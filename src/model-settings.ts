import {
  modelSettingsSchema,
  type ModelSelection,
  type ModelSettings,
} from "./settings-contract.ts";

export type ProviderSettingsValues = {
  allowSubagents: boolean;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettingsValues = {
  allowSubagents: false,
};

export const DEFAULT_MODEL_SETTINGS: ModelSettings = resolveModelSettings(
  DEFAULT_PROVIDER_SETTINGS,
  null,
);

export function resolveModelSettings(
  values: Readonly<Record<string, unknown>>,
  enabledModels: string[] | null,
): ModelSettings {
  const allowSubagents =
    typeof values.allowSubagents === "boolean"
      ? values.allowSubagents
      : DEFAULT_PROVIDER_SETTINGS.allowSubagents;
  return {
    enabledModels,
    disableSubagents: !allowSubagents,
  };
}

export function normalizeModelSelection(value: unknown): ModelSelection {
  return { enabledModels: normalizeModelSettings(value).enabledModels };
}

export function legacyProviderSettings(
  value: unknown,
): ProviderSettingsValues | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  if (!("disableSubagents" in candidate)) return undefined;
  return { allowSubagents: candidate.disableSubagents === false };
}

export function normalizeModelSettings(value: unknown): ModelSettings {
  const parsed = modelSettingsSchema.safeParse(value);
  if (parsed.success) {
    return {
      ...parsed.data,
      enabledModels:
        parsed.data.enabledModels === null
          ? null
          : [...new Set(parsed.data.enabledModels)],
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_MODEL_SETTINGS };
  }

  const candidate = value as Record<string, unknown>;
  const enabledModels = Array.isArray(candidate.enabledModels)
    ? candidate.enabledModels.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : null;

  return {
    enabledModels: enabledModels === null ? null : [...new Set(enabledModels)],
    disableSubagents: candidate.disableSubagents !== false,
  };
}
