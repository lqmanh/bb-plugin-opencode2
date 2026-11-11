import type { OpenCodeClient } from "@opencode/client";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  unavailableUsageStatus,
  usageProviderSchema,
  usageSnapshotSchema,
  usageStatusFromErrorCode,
  type UsageList,
  type UsageSnapshot,
  type UsageSourceStatus,
} from "../../shared/settings-contract.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { OpenCodeApi } from "../types.ts";

const USAGE_RPC_ID = "opencode-usage";
// OpenCode answers an unregistered RPC ID with RpcError type "rpc.unavailable".
const RPC_NOT_REGISTERED = "rpc.unavailable";
// OpenCode 2.2.7 stopped waiting for plugins in request handlers, so the first
// RPC after a Location boots can be unavailable for about a second. After the
// retries run out, later calls for that cwd skip retries for 5 minutes or until
// an RPC succeeds.
const USAGE_RPC_RETRIES = 5;
const USAGE_RPC_RETRY_MS = 300;
const USAGE_RETRY_SUPPRESS_MS = 5 * 60_000;

const usageRpcListSchema = z
  .object({
    providers: z.array(usageProviderSchema).max(10_000),
  })
  .strict();

const usageRpcGetSchema = z
  .object({
    providers: z.array(usageSnapshotSchema).max(10_000),
  })
  .strict();

type PluginInfo = Awaited<
  ReturnType<OpenCodeClient["plugin"]["list"]>
>["data"][number];

type UsagePluginMetadata = {
  sourceType: "package" | "local" | "builtin" | "sdk";
  source?: string;
  version?: string;
};

type UsagePluginLookup =
  | { status: "found"; metadata: UsagePluginMetadata }
  | { status: "missing" }
  | { status: "failed"; metadata: UsagePluginMetadata; error: string }
  | { status: "unconfirmed" };

function pluginMetadata(plugin: PluginInfo): UsagePluginMetadata {
  switch (plugin.source.type) {
    case "package":
      return {
        sourceType: "package",
        source: plugin.source.target,
        ...(plugin.source.version ? { version: plugin.source.version } : {}),
      };
    case "local":
      return { sourceType: "local", source: plugin.source.path };
    case "builtin":
      return { sourceType: "builtin" };
    case "sdk":
      return { sourceType: "sdk" };
  }
}

function isUsagePlugin(plugin: PluginInfo): boolean {
  if (plugin.id === USAGE_RPC_ID) return true;
  if (plugin.source.type !== "package") return false;
  return (
    plugin.source.target === USAGE_RPC_ID ||
    plugin.source.target.startsWith(`${USAGE_RPC_ID}@`)
  );
}

async function lookupUsagePlugin(
  api: OpenCodeApi,
  cwd: string,
): Promise<UsagePluginLookup> {
  try {
    const client = await api();
    const listed = await client.plugin.list({ location: { directory: cwd } });
    const selected = listed.data.find(isUsagePlugin);
    if (!selected) return { status: "missing" };
    const metadata = pluginMetadata(selected);
    return selected.state.status === "failed"
      ? { status: "failed", metadata, error: selected.state.error }
      : { status: "found", metadata };
  } catch {
    return { status: "unconfirmed" };
  }
}

async function callUsageRpc(
  api: OpenCodeApi,
  cwd: string,
  method: "list" | "get",
  input: Record<string, string | boolean> = {},
): Promise<unknown> {
  const client = await api();
  const result = await client.rpc.call({
    rpcID: USAGE_RPC_ID,
    method,
    location: { directory: cwd },
    input,
  });
  return result.output;
}

type UsageFetch<T> =
  | { ok: true; providers: T[] }
  | { ok: false; error: string; errorType?: string };

const usageRetrySuppressedUntil = new Map<string, number>();

function rpcErrorType(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

async function fetchUsage<T>(
  api: OpenCodeApi,
  cwd: string,
  method: "list" | "get",
  schema: z.ZodType<{ providers: T[] }>,
  input: Record<string, string | boolean> = {},
): Promise<UsageFetch<T>> {
  const retry = (usageRetrySuppressedUntil.get(cwd) ?? 0) <= Date.now();
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, USAGE_RPC_RETRY_MS));
    try {
      const output = await callUsageRpc(api, cwd, method, input);
      const parsed = schema.safeParse(output);
      if (!parsed.success) {
        return {
          ok: false,
          error: `opencode-usage.${method} returned an invalid response`,
        };
      }
      usageRetrySuppressedUntil.delete(cwd);
      return { ok: true, providers: parsed.data.providers };
    } catch (error) {
      const errorType = rpcErrorType(error);
      if (errorType === RPC_NOT_REGISTERED && retry) {
        if (attempt < USAGE_RPC_RETRIES) continue;
        usageRetrySuppressedUntil.set(
          cwd,
          Date.now() + USAGE_RETRY_SUPPRESS_MS,
        );
      }
      return {
        ok: false,
        error: `opencode-usage.${method} failed: ${errorMessage(error)}`,
        errorType,
      };
    }
  }
}

function fetchUsageSnapshots(
  api: OpenCodeApi,
  cwd: string,
  input: Record<string, string | boolean> = {},
) {
  return fetchUsage<UsageSnapshot>(api, cwd, "get", usageRpcGetSchema, input);
}

function fetchUsageList(api: OpenCodeApi, cwd: string) {
  return fetchUsage<UsageList["providers"][number]>(
    api,
    cwd,
    "list",
    usageRpcListSchema,
  );
}

function unavailableUsageList(error: string): UsageList {
  return { available: false, providers: [], error };
}

export async function listProviderUsage(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<UsageList> {
  const result = await fetchUsageList(api, cwd);
  return result.ok
    ? { available: true, providers: result.providers }
    : unavailableUsageList(result.error);
}

function usageContractMissing(
  errorType: string | undefined,
  lookup: UsagePluginLookup,
): boolean {
  return errorType === RPC_NOT_REGISTERED && lookup.status === "missing";
}

export async function usageSourceStatus(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<UsageSourceStatus> {
  // Look up the plugin first: a listed-but-failed plugin aborts before the RPC,
  // and a cold plugin list is what makes the first RPC unavailable.
  const lookup = await lookupUsagePlugin(api, cwd);
  if (lookup.status === "failed")
    return unavailableUsageStatus(lookup.error, lookup.metadata);

  const listed = await fetchUsageList(api, cwd);
  if (!listed.ok)
    return usageContractMissing(listed.errorType, lookup)
      ? { status: "not_installed", providerCount: 0 }
      : unavailableUsageStatus(
          listed.error,
          lookup.status === "found" ? lookup.metadata : {},
        );

  // A cold plugin list can miss the plugin that answers the RPC; refresh the
  // metadata after success instead of leaving the source as Unknown.
  const found =
    lookup.status === "found" ? lookup : await lookupUsagePlugin(api, cwd);
  const providerCount = listed.providers.length;
  return {
    status: providerCount > 0 ? "active" : "no_accounts",
    ...(found.status === "found" ? found.metadata : {}),
    providerCount,
  };
}

export async function getProviderUsage(
  api: OpenCodeApi,
  providerID: string,
  options: { bypassCache?: boolean; cwd?: string } = {},
): Promise<UsageSnapshot> {
  const result = await fetchUsageSnapshots(api, options.cwd ?? process.cwd(), {
    providerID,
    bypassCache: options.bypassCache ?? false,
  });
  if (!result.ok) throw new Error(result.error);
  const snapshot = result.providers.find(
    (provider) => provider.providerID === providerID,
  );
  if (!snapshot) throw new Error("Provider usage is no longer available");
  return snapshot;
}

export async function collectProviderUsage(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<UsageSnapshot[]> {
  const result = await fetchUsageSnapshots(api, cwd);
  return result.ok ? result.providers : [];
}

export function aggregateUsageSnapshots(
  snapshots: readonly UsageSnapshot[],
): ProviderUsageResult {
  if (snapshots.length === 0) return { supported: false };
  const healthy = snapshots.filter((snapshot) => !snapshot.error);
  if (healthy.length > 0) {
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: "OpenCode",
        windows: healthy.flatMap((snapshot) =>
          snapshot.windows.map((window) => ({
            label: `${snapshot.providerName} · ${window.label}`,
            usedPercent: window.percent,
            resetsAt: window.resetsAt || null,
          })),
        ),
      },
    };
  }
  const codes = new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.error ? [snapshot.error.code] : [],
    ),
  );
  if (codes.size === 1) {
    const [code] = codes;
    const status = usageStatusFromErrorCode(code);
    if (status !== "error") {
      return {
        supported: true,
        usage: { status },
      };
    }
  }
  const messages = snapshots
    .map((snapshot) => snapshot.error?.message)
    .filter((message): message is string => Boolean(message));
  return {
    supported: true,
    usage: {
      status: "error",
      accountEmail: null,
      planLabel: "OpenCode",
      message: messages.join("; "),
    },
  };
}

export async function providerUsageAggregate(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<ProviderUsageResult> {
  return aggregateUsageSnapshots(await collectProviderUsage(api, cwd));
}
