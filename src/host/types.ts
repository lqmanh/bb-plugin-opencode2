import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodeClient } from "@opencode/client";
import type { DynamicToolsMcpProxy } from "./bridge/dynamic-tools-mcp.ts";

export type OpenCodeApi = () => Promise<OpenCodeClient>;

/**
 * OpenCode's beta API does not publish a complete event schema. Keep its
 * untyped payloads behind this adapter type and normalize fields before they
 * reach BB protocol objects.
 */
export type OpenCodeRecord = Record<string, any>;

export type OpenCodePermissionMode = "accept-edits" | "auto" | "full";
export type OpenCodePermissionReply = "once" | "always" | "reject";
export type SessionTerminalKind = "archived" | "deleted" | "moved";

export const DELETED_SESSION_MESSAGE =
  "The OpenCode session for this thread was deleted. Start a new thread to continue.";
export const MOVED_SESSION_MESSAGE =
  "The OpenCode session moved to another workspace. Start a new thread to continue.";
export const ARCHIVED_SESSION_MESSAGE =
  "The OpenCode session was archived outside BB. Unarchive it before sending another message.";

export type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

export type UsageTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export function usageTotal(totals: UsageTotals) {
  return (
    totals.input +
    totals.output +
    totals.reasoning +
    totals.cacheRead +
    totals.cacheWrite
  );
}

export type InteractionContext = {
  /** Null for background tasks, which have no turn of their own. */
  providerTurnId: string | null;
  formSessionId: string;
  background: boolean;
  abortController: AbortController;
  opened: Map<string, OpenCodeRecord>;
  openQuestions: Map<string, string>;
  /** Session that owns an open form, which can be a nested child. */
  formSessions: Map<string, string>;
  settledTools: Set<string>;
  questionWaiters: Map<string, { resolve(form?: OpenCodeRecord): void }>;
  earlyQuestionForms: Map<string, OpenCodeRecord>;
  settledForms: Map<string, "answered" | "cancelled">;
  ownForms: Set<string>;
  settledPermissions: Set<string>;
  ownPermissionReplies: Set<string>;
};

export type BackgroundCompletionState =
  "running" | "completed" | "error" | "cancelled";

export type BackgroundTaskRecord = {
  id: string;
  callId: string;
  kind: "shell" | "subagent" | "image";
  startedAt: number;
  settled: boolean;
  item: OpenCodeRecord;
  interaction: InteractionContext;
  shellId?: string;
  childSessionId?: string;
  outputFile?: string;
  /** The OpenCode job ID for an image task. */
  jobId?: string;
  /** The save stem from an image tool result, without its extension. */
  imageStem?: string;
  /** A child that may finish without reporting; settle after it goes idle. */
  settleTimer?: ReturnType<typeof setTimeout>;
};

/** A completed image waiting for delivery to the agent. */
export type PendingImageReport = {
  jobId: string;
  path: string;
  delivered?: boolean;
};

/** A native subagent session, shared with background-task support. */
export type ChildSessionRecord = {
  parentThreadId: string;
  parentProviderThreadId: string;
  usage?: {
    tokens: UsageTotals;
    cost?: number;
  };
  backgroundTaskId?: string;
  /** The task a nested child's permissions and forms are shown under. */
  topLevelTaskId?: string;
};

export function createInteractionContext(input: {
  providerTurnId: string | null;
  formSessionId: string;
  background: boolean;
}): InteractionContext {
  return {
    providerTurnId: input.providerTurnId,
    formSessionId: input.formSessionId,
    background: input.background,
    abortController: new AbortController(),
    opened: new Map(),
    openQuestions: new Map(),
    formSessions: new Map(),
    settledTools: new Set(),
    questionWaiters: new Map(),
    earlyQuestionForms: new Map(),
    settledForms: new Map(),
    ownForms: new Set(),
    settledPermissions: new Set(),
    ownPermissionReplies: new Set(),
  };
}

export type ActiveTurn = {
  interaction: InteractionContext;
  startedAt: number;
  /** Set once OpenCode accepted the prompt; reconciliation waits for it. */
  promptDelivered?: boolean;
  /** Message IDs of this turn's prompts (the first and any steers). */
  promptIds?: Set<string>;
  /** A command turn adopts the first inbox message as its checkpoint. */
  awaitingCommandCheckpoint?: boolean;
  /**
   * Set when OpenCode starts working on one of this turn's prompts. Terminal
   * execution events before that belong to earlier work (for example a
   * compaction still finishing) and must not end this turn.
   */
  inputDelivered?: boolean;
  manualCompaction?: { itemId: string };
  checkpointId?: string;
  pendingTools: Map<string, string>;
  pendingInput: Map<string, string>;
  touchedFiles: Map<string, string[]>;
  /** Tool calls already closed, so a repeated terminal event is ignored. */
  finishedTools?: Set<string>;
  /** Set while the asynchronous turn-diff read is finishing the turn. */
  finishing?: boolean;
  /** Live shell output pollers by tool call ID. */
  shellPolls?: Map<string, { stopped: boolean }>;
  /** Token counts of the latest finished step, for `usage.last`. */
  lastStepTokens?: OpenCodeRecord;
};

export function createActiveTurn(
  providerTurnId: string | null,
  formSessionId: string,
): ActiveTurn {
  return {
    interaction: createInteractionContext({
      providerTurnId,
      formSessionId,
      background: false,
    }),
    startedAt: Date.now(),
    pendingTools: new Map(),
    pendingInput: new Map(),
    touchedFiles: new Map(),
  };
}

/** A run OpenCode woke without a BB prompt, such as a subagent report. */
export function createProviderTurn(formSessionId: string): ActiveTurn {
  return { ...createActiveTurn(null, formSessionId), promptDelivered: true };
}

export type SessionState = {
  bbThreadId: string;
  providerThreadId: string;
  cwd: string;
  permissionMode?: OpenCodePermissionMode;
  /** Serialized ruleset last sent to OpenCode, to skip redundant PATCHes. */
  appliedPermissions?: string;
  disableSubagents: boolean;
  dynamicTools: DynamicTool[];
  disallowedTools: Set<string>;
  instructions: string;
  bridgeEnvVars: Record<string, string>;
  dynamicToolScope: object;
  dynamicToolProxy?: DynamicToolsMcpProxy;
  active?: ActiveTurn;
  model?: ModelRef;
  /** The current model's context limit, from OpenCode's model catalog. */
  contextWindow?: number | null;
  /** OpenCode agent the session is currently on. */
  agent?: string;
  /** The agent chosen through BB's `agent` session option, kept across turns. */
  agentChoice?: string;
  /** Set while the previous turn ran on OpenCode's `plan` agent. */
  planMode?: boolean;
  /** The agent to return to when the plan turn ends. */
  agentBeforePlan?: string;
  /** Last session-option selection published to BB, to skip repeats. */
  publishedAgentSelection?: string;
  /** Last session-options state published to BB, to skip repeats. */
  publishedAgentOptions?: string;
  /** The title this bridge just set, so its rename event is not echoed back. */
  expectedTitle?: string;
  /** Set when OpenCode deleted, moved, or archived the session. */
  terminalError?: string;
  /** Why the session stopped being usable, without comparing `terminalError`. */
  terminalKind?: SessionTerminalKind;
  /** True while this plugin is removing the OpenCode session. */
  closing?: boolean;
  usage: UsageTotals;
  /** Parent session cost in USD. Child cost is kept in the router registry. */
  usageCost?: number;
  /** Parent-only last step, used for late child usage after a turn closes. */
  lastUsage?: { tokens: UsageTotals; used: number };
  /** OpenCode background shells and subagents shown as BB task rows. */
  backgroundTasks: Map<string, BackgroundTaskRecord>;
  /** Completions that arrived before their task row was registered. */
  pendingBackgroundCompletions: Map<string, OpenCodeRecord>;
  /** Full output files for OpenCode shells, keyed by shell ID. */
  shellOutputFiles: Map<string, string>;
  /** Image completions waiting to render in the turn that receives them. */
  pendingImageReports: Map<string, PendingImageReport>;
  /** Image job IDs whose result row was already emitted. */
  emittedImageReports: Set<string>;
  /** Synthetic inbox IDs that may wake a parent run. */
  pendingReportIds: Set<string>;
  /** Reports settle rows but do not open a turn until the next user action. */
  suppressReportWake: boolean;
};

export function createSessionBackgroundState(): Pick<
  SessionState,
  | "backgroundTasks"
  | "pendingBackgroundCompletions"
  | "shellOutputFiles"
  | "pendingImageReports"
  | "emittedImageReports"
  | "pendingReportIds"
  | "suppressReportWake"
> {
  return {
    backgroundTasks: new Map(),
    pendingBackgroundCompletions: new Map(),
    shellOutputFiles: new Map(),
    pendingImageReports: new Map(),
    emittedImageReports: new Set(),
    pendingReportIds: new Set(),
    suppressReportWake: false,
  };
}

/** Carry background state when a thread is registered for the same provider session. */
export function copyBackgroundState(
  target: SessionState,
  source: SessionState,
) {
  target.backgroundTasks = source.backgroundTasks;
  target.pendingBackgroundCompletions = source.pendingBackgroundCompletions;
  target.shellOutputFiles = source.shellOutputFiles;
  target.pendingImageReports = source.pendingImageReports;
  target.emittedImageReports = source.emittedImageReports;
}

export function clearBackgroundState(session: SessionState) {
  session.backgroundTasks.clear();
  session.pendingBackgroundCompletions.clear();
  session.shellOutputFiles.clear();
  session.pendingImageReports.clear();
  session.emittedImageReports.clear();
}

/** Forget pending reports; `suppress` keeps later ones from opening a turn. */
export function resetReportWake(session: SessionState, suppress: boolean) {
  session.pendingReportIds.clear();
  session.suppressReportWake = suppress;
}

export function isSubagentTool(name: string): boolean {
  return name.toLowerCase() === "subagent";
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parsePermissionMode(
  value: unknown,
): OpenCodePermissionMode | undefined {
  const mode = stringValue(value);
  return mode === "accept-edits" || mode === "auto" || mode === "full"
    ? mode
    : undefined;
}

export function inputRecord(value: unknown): OpenCodeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as OpenCodeRecord)
    : {};
}

export function firstInputString(
  input: OpenCodeRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function parseInputText(text: unknown): OpenCodeRecord {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return inputRecord(JSON.parse(text));
  } catch {
    return {};
  }
}
