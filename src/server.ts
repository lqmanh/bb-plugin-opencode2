// BB provider registration for OpenCode v2.
//
// The host bridge talks to OpenCode's local v2 HTTP API. This file only owns
// provider metadata and keeps process/API details out of the BB server runtime.
import {
  type BbPluginApi,
  experimental_PluginRpcRefusal,
} from "@get-bb/plugin-sdk";
import {
  OPENCODE_PROVIDER_ID,
  opencodeHostContract,
  opencodeSettingsRpcContract,
  unavailableUsageStatus,
  type HostStatus,
  type ModelSummary,
} from "./settings-contract.ts";
import {
  parseUsageResourceId,
  providerUsageRpcContract,
  usageResourceFromSnapshot,
  usageResources,
} from "./provider-usage.ts";
import {
  DEFAULT_PROVIDER_SETTINGS,
  normalizeModelSelection,
  resolveModelSettings,
} from "./model-settings.ts";
import { errorMessage } from "./host/types.ts";

const SETTINGS_KEY = "model-settings";

export default async function plugin(bb: BbPluginApi) {
  const providerSettings = bb.settings.define({
    allowSubagents: {
      type: "boolean",
      label: "Allow OpenCode subagents",
      description:
        "Let OpenCode delegate to its own subagents. When off, OpenCode hides its subagent tool and agents delegate through BB instead.",
      default: DEFAULT_PROVIDER_SETTINGS.allowSubagents,
    },
  });

  const storedSettings = await bb.storage.kv.get(SETTINGS_KEY);
  let selection = normalizeModelSelection(storedSettings);

  let settingValues = await providerSettings.get();
  function currentModelSettings() {
    return resolveModelSettings(settingValues, selection.enabledModels);
  }
  const host = bb.hosts.experimental_client({ contract: opencodeHostContract });
  const syncedSettings = new Map<string, string>();

  async function connectedHostIds(signal?: AbortSignal) {
    return (await bb.sdk.hosts.list({ signal }))
      .filter((item) => item.status === "connected")
      .map((item) => item.id);
  }

  async function settleHostCalls<T>(
    hostIds: readonly string[],
    call: (hostId: string) => Promise<T>,
  ) {
    const results = await Promise.allSettled(hostIds.map(call));
    return hostIds.map((hostId, index) => ({
      hostId,
      result: results[index],
    }));
  }

  async function syncSettings(hostIds?: string[], signal?: AbortSignal) {
    const connected = hostIds ?? (await connectedHostIds(signal));
    const modelSettings = currentModelSettings();
    const revision = JSON.stringify(modelSettings);
    const targets = connected.filter(
      (hostId) => syncedSettings.get(hostId) !== revision,
    );
    const results = await Promise.allSettled(
      targets.map((hostId) => {
        const call = host.call("setModelSettings", modelSettings, {
          hostId,
          signal,
        });
        if (!signal) return call;
        return new Promise((resolve, reject) => {
          const aborted = () =>
            reject(signal.reason ?? new Error("Settings sync aborted"));
          if (signal.aborted) {
            aborted();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
          call.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", aborted);
          });
        });
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        syncedSettings.set(targets[index], revision);
      }
    });
    for (const hostId of syncedSettings.keys()) {
      if (!connected.includes(hostId)) syncedSettings.delete(hostId);
    }
    if (
      !signal?.aborted &&
      results.some((result) => result.status === "rejected")
    ) {
      bb.log.warn(
        "Could not sync OpenCode model settings to every connected host",
      );
    }
  }

  async function listModels() {
    const hostIds = await connectedHostIds();
    await syncSettings(hostIds);
    const results = await settleHostCalls(hostIds, (hostId) =>
      host.call("listModels", {}, { hostId }),
    );
    const models = new Map<string, ModelSummary>();
    for (const { result } of results) {
      if (result.status !== "fulfilled") continue;
      for (const model of result.value.models) models.set(model.id, model);
    }
    return {
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async function getStatus() {
    const hosts = (await bb.sdk.hosts.list()).filter(
      (item) => item.status === "connected",
    );
    const results = await Promise.all(
      hosts.map(async (item): Promise<HostStatus> => {
        const [opencodeStatus, usageStatus] = await Promise.allSettled([
          host.call("getStatus", {}, { hostId: item.id }),
          host.call("usage/status", {}, { hostId: item.id }),
        ]);
        return {
          hostId: item.id,
          hostName: item.name,
          ...(opencodeStatus.status === "fulfilled"
            ? { status: opencodeStatus.value }
            : { error: errorMessage(opencodeStatus.reason) }),
          usage:
            usageStatus.status === "fulfilled"
              ? usageStatus.value
              : unavailableUsageStatus(errorMessage(usageStatus.reason)),
        };
      }),
    );
    return { hosts: results };
  }

  bb.rpc.register(opencodeSettingsRpcContract, {
    getModelSelection: () => selection,
    listModels,
    getStatus,
    async saveModelSelection(next) {
      selection = normalizeModelSelection(next);
      await bb.storage.kv.set(SETTINGS_KEY, selection);
      await syncSettings();
      bb.realtime.publish("settings-changed", selection);
      return selection;
    },
  });

  bb.rpc.register(
    providerUsageRpcContract,
    {
      async "provider-usage.v1.listResources"(_input, context) {
        const hostIds = await connectedHostIds(context.experimental_signal);
        const results = await settleHostCalls(hostIds, (hostId) =>
          host.call(
            "usage/list",
            {},
            { hostId, signal: context.experimental_signal },
          ),
        );
        const resources = usageResources(
          results.map(({ hostId, result }) => ({
            hostId,
            usage: result.status === "fulfilled" ? result.value : undefined,
          })),
        );
        return resources.length > 0
          ? { label: "OpenCode v2", resources }
          : { resources: [] };
      },
      async "provider-usage.v1.getResource"({ resourceId, refresh }, context) {
        const target = parseUsageResourceId(resourceId);
        if (!target) {
          throw new experimental_PluginRpcRefusal({
            code: "not_found",
            message: "OpenCode usage resource no longer exists.",
          });
        }
        try {
          const snapshot = await host.call(
            "usage/get",
            { providerID: target.providerID, bypassCache: refresh },
            { hostId: target.hostId, signal: context.experimental_signal },
          );
          return usageResourceFromSnapshot(snapshot);
        } catch (error) {
          throw new experimental_PluginRpcRefusal({
            code: "not_found",
            message: errorMessage(error),
          });
        }
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "OpenCode v2 provider usage, sourced from the opencode-usage OpenCode plugin.",
    },
  );

  providerSettings.onChange((next) => {
    settingValues = next;
    void syncSettings().catch((error) =>
      bb.log.warn(
        `Could not sync OpenCode provider settings: ${errorMessage(error)}`,
      ),
    );
  });

  bb.background.service("sync-model-settings", {
    async start(signal) {
      while (!signal.aborted) {
        await syncSettings(undefined, signal);
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
          }, 5_000);
          signal.addEventListener("abort", stop, { once: true });
        });
      }
    },
  });

  bb.providers.register({
    id: OPENCODE_PROVIDER_ID,
    displayName: "OpenCode v2",
    icon: "./icons/opencode.svg",
    strings: {
      signInHint:
        "Run `opencode2 auth login` on this machine to connect a model provider.",
      expiredHint:
        "An OpenCode model provider needs to be reconnected. Run `opencode2 auth login`, then reload.",
      installUrl: "https://opencode.ai/v2/docs/",
      brandPrefix: "OpenCode ",
      iconTint: { light: "#18181B", dark: "#FAFAFA" },
    },
    // Only show the provider when `opencode2` is installed on the target machine.
    experimental_visibility: "installed",
    maintenance: { health: true, usage: true, installation: true },
    models: { scope: "workspace" },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      supportsManualCompaction: true,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint",
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
    },
    // `/plan` maps to OpenCode's read-only `plan` agent for that turn, then
    // returns to the agent picked through the `agent` session option.
    composerActions: ["plan"],
    // OpenCode discovers skills in more places than BB scans by default;
    // the host entry answers with the roots OpenCode actually uses.
    experimental_resolvesNativeRoots: true,
    // Settings reach every session and turn command as providerOptions, so a
    // change applies on the next turn without waiting for the host sync.
    deriveProviderOptions: ({ settings }) => ({
      modelSettings: resolveModelSettings(settings, selection.enabledModels),
    }),
  });

  bb.log.info("registered OpenCode v2 provider");
}
