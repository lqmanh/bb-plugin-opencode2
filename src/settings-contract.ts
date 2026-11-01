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

export const modelSummarySchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    isDefault: z.boolean().optional(),
  })
  .strict();

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
    modelCount: z.number().int().nonnegative(),
  })
  .strict();

export const hostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    hostName: z.string(),
    status: openCodeStatusSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

const enabledModelsSchema = z.array(z.string().min(1)).max(10_000).nullable();

export const modelSettingsSchema = z
  .object({
    // null means every discovered model is enabled. An array is the exact
    // allowlist, including an empty array for "disable all".
    enabledModels: enabledModelsSchema,
    // Prevent OpenCode from starting native subagents (task tool) so agents
    // use BB for delegation instead. Missing key defaults to true so older
    // stored settings migrate to the safer default.
    disableSubagents: z.boolean().default(true),
  })
  .strict();

export const modelSelectionSchema = z
  .object({
    enabledModels: enabledModelsSchema,
  })
  .strict();

export const opencodeHostContract = defineRpcContract({
  listModels: {
    input: z.object({ cwd: z.string().min(1).optional() }).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  setModelSettings: {
    input: modelSettingsSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  getStatus: {
    input: z.object({}).strict(),
    output: openCodeStatusSchema,
  },
});

export const opencodeSettingsRpcContract = defineRpcContract({
  getModelSelection: {
    input: z.null(),
    output: modelSelectionSchema,
  },
  listModels: {
    input: z.object({}).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  saveModelSelection: {
    input: modelSelectionSchema,
    output: modelSelectionSchema,
  },
  getStatus: {
    input: z.object({}).strict(),
    output: z.object({ hosts: z.array(hostStatusSchema).max(1_000) }).strict(),
  },
});

export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type OpenCodeStatus = z.infer<typeof openCodeStatusSchema>;
export type HostStatus = z.infer<typeof hostStatusSchema>;
