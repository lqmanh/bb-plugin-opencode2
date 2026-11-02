import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  OPENCODE_PROVIDER_ID,
  usageStatusFromErrorCode,
  type UsageList,
  type UsageSnapshot,
} from "./settings-contract.ts";

const planSchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().int().positive().nullable(),
});

const usageBaseSchema = {
  plan: planSchema.nullable().default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const usageWindowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);

const providerUsageWindowSchema = z.object({
  kind: usageWindowKindSchema.default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const providerUsageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...usageBaseSchema,
    windows: z.array(providerUsageWindowSchema),
  }),
  z.object({ status: z.literal("not_installed"), ...usageBaseSchema }),
  z.object({ status: z.literal("unauthenticated"), ...usageBaseSchema }),
  z.object({ status: z.literal("expired"), ...usageBaseSchema }),
  z.object({
    status: z.literal("error"),
    ...usageBaseSchema,
    message: z.string(),
  }),
]);

const accountKeySchema = z.string().min(1).nullable().default(null);

const usageResourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.object({ kind: z.literal("shared") }),
});

const usageResourcesSchema = z.object({
  label: z.string().min(1).optional(),
  resources: z.array(usageResourceSchema),
});

const usageResourceInputSchema = z.object({
  resourceId: z.string().min(1),
  refresh: z.boolean(),
});

const usageResourceOutputSchema = z.object({
  accountKey: accountKeySchema,
  observedAt: z.number().int().nonnegative().nullable(),
  usage: providerUsageSchema,
});

export const providerUsageRpcContract = defineRpcContract({
  "provider-usage.v1.listResources": {
    input: z.object({}),
    output: usageResourcesSchema,
    experimental_description:
      "Lists OpenCode v2 usage resources without refreshing quota.",
  },
  "provider-usage.v1.getResource": {
    input: usageResourceInputSchema,
    output: usageResourceOutputSchema,
    experimental_description:
      "Returns usage for one OpenCode v2 provider resource. A removed resource fails so consumers relist.",
  },
});

export type ProviderUsageResource = z.infer<typeof usageResourceSchema>;
export type ProviderUsageResourcePayload = z.infer<
  typeof usageResourceOutputSchema
>;

const resourceIdSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export function usageResourceId(hostId: string, providerID: string): string {
  return JSON.stringify([hostId, providerID]);
}

export function parseUsageResourceId(
  value: string,
): { hostId: string; providerID: string } | undefined {
  try {
    const parsed = resourceIdSchema.safeParse(JSON.parse(value));
    return parsed.success
      ? { hostId: parsed.data[0], providerID: parsed.data[1] }
      : undefined;
  } catch {
    return undefined;
  }
}

export function usageResources(
  hosts: readonly { hostId: string; usage: UsageList | undefined }[],
): ProviderUsageResource[] {
  return hosts.flatMap(({ hostId, usage }) => {
    if (!usage?.available) return [];
    return usage.providers.map((provider) => ({
      id: usageResourceId(hostId, provider.providerID),
      providerId: OPENCODE_PROVIDER_ID,
      label: provider.providerName,
      accountKey: provider.accountKey ?? null,
      scope: { kind: "shared" as const },
    }));
  });
}

type UsageWindowKind = "five-hour" | "daily" | "weekly" | "custom";

const durationLabel = /^\d+(?:\.\d+)?(?:w|d|h|m)$/;

const windowKindByLabel: Record<string, UsageWindowKind> = {
  "5h": "five-hour",
  "1d": "daily",
  "1w": "weekly",
  "7d": "weekly",
};

const windowKindById: Record<string, UsageWindowKind> = {
  rolling: "five-hour",
  daily: "daily",
  weekly: "weekly",
};

function usageKind(id: string, label: string): UsageWindowKind {
  const normalized = label.trim().toLowerCase();
  if (durationLabel.test(normalized)) {
    return windowKindByLabel[normalized] ?? "custom";
  }
  return windowKindById[id] ?? "custom";
}

function usageWindow(window: UsageSnapshot["windows"][number]) {
  return {
    kind: usageKind(window.id, window.label),
    id: window.id,
    label: window.label,
    usedPercent: window.percent,
    resetsAt: window.resetsAt || null,
    model: null,
    cost: null,
  };
}

function usageBase(snapshot: UsageSnapshot) {
  return {
    plan: null,
    accountEmail: null,
    planLabel: snapshot.accountLabel ?? null,
  };
}

export function usageResourceFromSnapshot(
  snapshot: UsageSnapshot,
): ProviderUsageResourcePayload {
  const accountKey = snapshot.accountKey ?? null;
  const base = usageBase(snapshot);
  const error = snapshot.error;
  if (!error) {
    return {
      accountKey,
      observedAt: snapshot.fetchedAt,
      usage: {
        status: "ok",
        ...base,
        windows: snapshot.windows.map(usageWindow),
      },
    };
  }
  const status = usageStatusFromErrorCode(error.code);
  if (status === "error") {
    return {
      accountKey,
      observedAt: null,
      usage: { status, ...base, message: error.message },
    };
  }
  return {
    accountKey,
    observedAt: null,
    usage: { status, ...base },
  };
}
