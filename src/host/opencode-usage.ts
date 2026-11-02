import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  usageProviderSchema,
  usageSnapshotSchema,
  usageStatusFromErrorCode,
  type UsageList,
  type UsageSnapshot,
} from "../settings-contract.ts";
import { errorMessage, type OpenCodeApi } from "./types.ts";

const USAGE_RPC_ID = "opencode-usage";

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

type UsageFetch =
  { ok: true; providers: UsageSnapshot[] } | { ok: false; error: string };

async function fetchUsageSnapshots(
  api: OpenCodeApi,
  cwd: string,
  input: Record<string, string | boolean> = {},
): Promise<UsageFetch> {
  try {
    const output = await callUsageRpc(api, cwd, "get", input);
    const parsed = usageRpcGetSchema.safeParse(output);
    return parsed.success
      ? { ok: true, providers: parsed.data.providers }
      : { ok: false, error: "opencode-usage.get returned an invalid response" };
  } catch (error) {
    return {
      ok: false,
      error: `opencode-usage.get failed: ${errorMessage(error)}`,
    };
  }
}

function unavailableUsage(error: string): UsageList {
  return { available: false, providers: [], error };
}

export async function listProviderUsage(
  api: OpenCodeApi,
  cwd = process.cwd(),
): Promise<UsageList> {
  let output: unknown;
  try {
    output = await callUsageRpc(api, cwd, "list");
  } catch (error) {
    return unavailableUsage(errorMessage(error));
  }
  const parsed = usageRpcListSchema.safeParse(output);
  if (!parsed.success) {
    return unavailableUsage("opencode-usage.list returned an invalid response");
  }
  return { available: true, providers: parsed.data.providers };
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
