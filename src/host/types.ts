import type { OpenCodeClient } from "@opencode/client";
import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
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

export type ActiveTurn = {
  providerTurnId: string;
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
  abortController: AbortController;
  manualCompaction?: { itemId: string };
  checkpointId?: string;
  opened: Map<string, OpenCodeRecord>;
  pendingTools: Map<string, string>;
  pendingInput: Map<string, string>;
  touchedFiles: Map<string, string[]>;
  openQuestions: Map<string, string>;
  settledTools: Set<string>;
  /** Tool calls already closed, so a repeated terminal event is ignored. */
  finishedTools?: Set<string>;
  /** Set while the asynchronous turn-diff read is finishing the turn. */
  finishing?: boolean;
  /** Live shell output pollers by tool call ID. */
  shellPolls?: Map<string, { stopped: boolean }>;
  /** Token counts of the latest finished step, for `usage.last`. */
  lastStepTokens?: OpenCodeRecord;
  /** Question calls waiting for their form, keyed by tool call ID. */
  questionWaiters: Map<string, { resolve(form?: OpenCodeRecord): void }>;
  /** Forms that arrived before their question tool registered a waiter. */
  earlyQuestionForms: Map<string, OpenCodeRecord>;
  /** Form outcomes observed from OpenCode, keyed by raw form ID. */
  settledForms: Map<string, "answered" | "cancelled">;
  /** Raw IDs of BB's own form writes, removed when their OpenCode echo arrives. */
  ownForms: Set<string>;
  /** Permission requests settled in OpenCode, keyed by raw request ID. */
  settledPermissions: Set<string>;
  /** Raw IDs of BB's own permission replies, removed on their echo. */
  ownPermissionReplies: Set<string>;
};

export function createActiveTurn(providerTurnId: string): ActiveTurn {
  return {
    providerTurnId,
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map(),
    pendingTools: new Map(),
    pendingInput: new Map(),
    touchedFiles: new Map(),
    openQuestions: new Map(),
    settledTools: new Set(),
    questionWaiters: new Map(),
    earlyQuestionForms: new Map(),
    settledForms: new Map(),
    ownForms: new Set(),
    settledPermissions: new Set(),
    ownPermissionReplies: new Set(),
  };
}

export type SessionState = {
  bbThreadId: string;
  providerThreadId: string;
  cwd: string;
  permissionMode?: OpenCodePermissionMode;
  /** Serialized ruleset last sent to OpenCode, to skip redundant PATCHes. */
  appliedPermissions?: string;
  disableSubagents: boolean;
  nativeSkillNames?: Set<string>;
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
  /** True while BB itself is removing the OpenCode session. */
  closing?: boolean;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export function isSubagentTool(name: string): boolean {
  const tool = name.toLowerCase();
  return tool === "task" || tool === "subagent";
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
