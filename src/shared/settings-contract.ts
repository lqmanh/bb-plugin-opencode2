import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The BB session option through which OpenCode's primary agent is chosen. */
export const AGENT_OPTION_ID = "agent";
/** Core thread-state kind for the declared session options. */
export const SESSION_OPTIONS_STATE_KIND = "bb/session-options";
/** Core thread-state kind for the selected session-option values. */
export const SESSION_OPTION_SELECTIONS_STATE_KIND =
  "bb/session-option-selections";
/** OpenCode's default primary agent. */
export const DEFAULT_AGENT = "build";
/** This plugin's BB provider ID. */
export const OPENCODE_PROVIDER_ID = "opencode2";

export const openCodeStatusSchema = z
  .object({
    status: z.enum([
      "ready",
      "not_installed",
      "unsupported_version",
      "unauthenticated",
      "unknown",
    ]),
    statusMessage: z.string().nullable(),
    installedVersion: z.string().nullable(),
    latestVersion: z.string().nullable(),
    minimumSupportedVersion: z.string(),
    loginCommand: z.string(),
  })
  .strict();

export const usageSourceStatusSchema = z
  .object({
    status: z.enum(["active", "no_accounts", "unavailable", "not_installed"]),
    sourceType: z.enum(["package", "local", "builtin", "sdk"]).optional(),
    source: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    providerCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .strict();

export type UsageSourceStatus = z.infer<typeof usageSourceStatusSchema>;

export function unavailableUsageStatus(
  error: string,
  metadata: Pick<UsageSourceStatus, "sourceType" | "source" | "version"> = {},
): UsageSourceStatus {
  return { status: "unavailable", ...metadata, providerCount: 0, error };
}

export const hostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    hostName: z.string(),
    status: openCodeStatusSchema.optional(),
    error: z.string().optional(),
    usage: usageSourceStatusSchema,
  })
  .strict();

export const usageWindowSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    percent: z.number(),
    resetsAt: z.string(),
  })
  .strict();

export const usageErrorSchema = z
  .object({
    code: z.enum(["expired", "unavailable", "failed"]),
    message: z.string().min(1),
  })
  .strict();

export type UsageErrorCode = z.infer<typeof usageErrorSchema>["code"];

export function usageStatusFromErrorCode(
  code: UsageErrorCode,
): "expired" | "unauthenticated" | "error" {
  switch (code) {
    case "expired":
      return "expired";
    case "unavailable":
      return "unauthenticated";
    case "failed":
      return "error";
  }
}

export const usageSnapshotSchema = z
  .object({
    providerID: z.string().min(1),
    providerName: z.string().min(1),
    accountLabel: z.string().optional(),
    accountKey: z.string().min(1).nullable(),
    fetchedAt: z.number().nonnegative(),
    windows: z.array(usageWindowSchema),
    error: usageErrorSchema.optional(),
  })
  .strict();

export const usageProviderSchema = usageSnapshotSchema.pick({
  providerID: true,
  providerName: true,
  accountLabel: true,
  accountKey: true,
});

export const usageListSchema = z
  .object({
    available: z.boolean(),
    providers: z.array(usageProviderSchema).max(10_000),
    error: z.string().optional(),
  })
  .strict();

const backgroundThreadRequestSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();
const backgroundThreadResultSchema = z.object({ ok: z.literal(true) }).strict();

export const nativeSkillsConfigureResultSchema = z
  .object({
    enabled: z.boolean(),
    packageSpec: z.string().optional(),
    locationsDir: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type NativeSkillsStatus = z.infer<
  typeof nativeSkillsConfigureResultSchema
>;

export const opencodeHostContract = defineRpcContract({
  getStatus: {
    input: z.object({}).strict(),
    output: openCodeStatusSchema,
  },
  "nativeSkills/configure": {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: nativeSkillsConfigureResultSchema,
  },
  backgroundSession: {
    input: backgroundThreadRequestSchema,
    output: backgroundThreadResultSchema,
  },
  "usage/list": {
    input: z.object({}).strict(),
    output: usageListSchema,
  },
  "usage/get": {
    input: z
      .object({
        providerID: z.string().min(1),
        bypassCache: z.boolean().optional(),
      })
      .strict(),
    output: usageSnapshotSchema,
  },
  "usage/status": {
    input: z.object({}).strict(),
    output: usageSourceStatusSchema,
  },
});

export const opencodeSettingsRpcContract = defineRpcContract({
  getStatus: {
    input: z.object({}).strict(),
    output: z.object({ hosts: z.array(hostStatusSchema).max(1_000) }).strict(),
  },
});

export const opencodeThreadRpcContract = defineRpcContract({
  backgroundThread: {
    input: backgroundThreadRequestSchema,
    output: backgroundThreadResultSchema,
  },
});

export type OpenCodeStatus = z.infer<typeof openCodeStatusSchema>;
export type HostStatus = z.infer<typeof hostStatusSchema>;
export type UsageList = z.infer<typeof usageListSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
