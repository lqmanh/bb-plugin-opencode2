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
  opencodeThreadRpcContract,
  unavailableUsageStatus,
  type HostStatus,
} from "../shared/settings-contract.ts";
import { registerBackgroundCompletionNotifications } from "./background-notifications.ts";
import {
  parseUsageResourceId,
  providerUsageRpcContract,
  usageResourceFromSnapshot,
  usageResources,
} from "./provider-usage.ts";
import { errorMessage } from "../shared/errors.ts";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Prevent OpenCode from starting native subagents so agents use BB for delegation.",
      default: false,
    },
    nativeSkills: {
      type: "boolean",
      label: "Register BB skills natively in OpenCode",
      description:
        "Install a small OpenCode plugin and add BB's skills to OpenCode's native skill registry for BB workspaces. " +
        "Other OpenCode clients that open the same workspace will see those skills. " +
        "OpenCode downloads the pinned plugin from GitHub on first use. Off by default.",
      default: false,
    },
  });

  const host = bb.hosts.experimental_client({ contract: opencodeHostContract });

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

  async function syncNativeSkills(enabled: boolean) {
    const hostIds = await connectedHostIds();
    if (hostIds.length === 0) return;
    const results = await settleHostCalls(hostIds, (hostId) =>
      host.call("nativeSkills/configure", { enabled }, { hostId }),
    );
    for (const { hostId, result } of results) {
      const error =
        result.status === "rejected"
          ? errorMessage(result.reason)
          : result.value.error;
      if (!error) continue;
      bb.log.warn(
        `Could not ${enabled ? "enable" : "disable"} native OpenCode skills on ${hostId}: ${error}`,
      );
    }
  }

  void settings
    .get()
    .then((values) => {
      if (values.nativeSkills === true) void syncNativeSkills(true);
    })
    .catch((error) => {
      bb.log.warn(
        `Could not read the native OpenCode skills setting: ${errorMessage(error)}`,
      );
    });
  settings.onChange((next, previous) => {
    if (next.nativeSkills !== previous.nativeSkills) {
      void syncNativeSkills(next.nativeSkills === true);
    }
  });

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

  bb.rpc.register(opencodeSettingsRpcContract, { getStatus });

  bb.rpc.register(opencodeThreadRpcContract, {
    async backgroundThread({ threadId }) {
      const [thread] = await bb.sdk.threads.list({ threadIds: [threadId] });
      if (!thread || thread.providerId !== OPENCODE_PROVIDER_ID) {
        throw new experimental_PluginRpcRefusal({
          code: "not_found",
          message: "This thread does not use OpenCode v2.",
        });
      }
      if (!thread.environmentHostId) {
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message: "This thread has no connected host.",
        });
      }
      try {
        await host.call(
          "backgroundSession",
          { threadId },
          { hostId: thread.environmentHostId },
        );
      } catch (error) {
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message: errorMessage(error),
        });
      }
      return { ok: true as const };
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
    // change applies from the next turn.
    deriveProviderOptions: ({ settings }) => ({
      disableSubagents: settings.subagentsDisabled === true,
      nativeSkills: settings.nativeSkills === true,
    }),
  });

  registerBackgroundCompletionNotifications(bb);

  bb.log.info("registered OpenCode v2 provider");
}
