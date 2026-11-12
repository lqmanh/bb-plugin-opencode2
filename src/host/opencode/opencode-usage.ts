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
import { isPluginDirSpec, lookupPlugin } from "./plugin-lookup.ts";

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

function isUsagePluginSpec(spec: string): boolean {
  const value = spec.trim();
  return (
    value.startsWith(`${USAGE_RPC_ID}@`) || isPluginDirSpec(value, USAGE_RPC_ID)
  );
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
  { ok: true; providers: T[] } | { ok: false; error: string };

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

export async function usageSourceStatus(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<UsageSourceStatus> {
  const lookup = await lookupPlugin(api, cwd, USAGE_RPC_ID, isUsagePluginSpec);
  if (lookup.status === "missing")
    return { status: "not_installed", providerCount: 0 };
  if (lookup.status === "error") return unavailableUsageStatus(lookup.error);
  if (lookup.status === "failed")
    return unavailableUsageStatus(lookup.error, lookup.metadata);

  const listed = await fetchUsageList(api, cwd);
  if (!listed.ok) return unavailableUsageStatus(listed.error, lookup.metadata);

  const providerCount = listed.providers.length;
  return {
    status: providerCount > 0 ? "active" : "no_accounts",
    ...lookup.metadata,
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
