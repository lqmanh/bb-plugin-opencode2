import type {
  OpenCodeStatus,
  SkillsPluginStatus,
  UsageSourceStatus,
} from "../shared/settings-contract.ts";

export type StatusTone = "ok" | "warn" | "error" | "neutral";

export type StatusDisplay = { label: string; tone: StatusTone };

/** One display vocabulary shared by every settings status row. */
const STATUS_DISPLAY = {
  ready: { label: "Ready", tone: "ok" },
  off: { label: "Off", tone: "neutral" },
  not_installed: { label: "Not installed", tone: "neutral" },
  setup_needed: { label: "Setup needed", tone: "warn" },
  update_needed: { label: "Update needed", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "error" },
} as const satisfies Record<string, StatusDisplay>;

export type ComponentStatus = keyof typeof STATUS_DISPLAY;

const OPEN_CODE_STATUS: Record<OpenCodeStatus["status"], ComponentStatus> = {
  ready: "ready",
  not_installed: "setup_needed",
  unauthenticated: "setup_needed",
  unsupported_version: "update_needed",
  unknown: "unavailable",
};

const SKILLS_STATUS: Record<SkillsPluginStatus["status"], ComponentStatus> = {
  active: "ready",
  off: "off",
  not_configured: "setup_needed",
  not_loaded: "setup_needed",
  outdated: "update_needed",
  failed: "unavailable",
};

const USAGE_SOURCE_STATUS: Record<
  UsageSourceStatus["status"],
  ComponentStatus
> = {
  active: "ready",
  no_accounts: "setup_needed",
  not_installed: "not_installed",
  unavailable: "unavailable",
};

export function statusDisplay(status: ComponentStatus): StatusDisplay {
  return STATUS_DISPLAY[status];
}

export function openCodeStatusDisplay(
  status: OpenCodeStatus["status"] | undefined,
): StatusDisplay {
  return statusDisplay(status ? OPEN_CODE_STATUS[status] : "unavailable");
}

export function usageStatusDisplay(
  status: UsageSourceStatus["status"],
): StatusDisplay {
  return statusDisplay(USAGE_SOURCE_STATUS[status]);
}

export function skillsStatusDisplay(
  status: SkillsPluginStatus["status"],
): StatusDisplay {
  return statusDisplay(SKILLS_STATUS[status]);
}
