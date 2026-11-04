import {
  backgroundTaskItemStatus,
  experimental_COMPACTION_PRESENTATION as compactionPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  AGENT_OPTION_ID,
  SESSION_OPTIONS_STATE_KIND,
  SESSION_OPTION_SELECTIONS_STATE_KIND,
} from "../../shared/settings-contract.ts";
import {
  dynamicToolCallRouter,
  emit,
  notify,
} from "../bridge/bridge-runtime.ts";
import { withSelectedAgent } from "../opencode/models.ts";
import { OpenCodeInteractions } from "../opencode/opencode-interactions.ts";
import { toolFailureError } from "../opencode/prompt.ts";
import { dynamicMcpServerName } from "../opencode/opencode-requests.ts";
import {
  releaseSessionTools,
  removeSessionEntries,
  sessionsByProviderId,
} from "../session/session-teardown.ts";
import {
  boundedTimelineText,
  itemKey,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  providerFailureDeltas,
} from "./timeline.ts";
import { rememberBounded } from "../../shared/collections.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  backgroundRunMetadata,
  backgroundTaskDescription,
  backgroundTaskItem,
  backgroundTaskKey,
  backgroundTaskTaskType,
  backgroundTaskUsage,
  contentText,
  diffFileChanges,
  dynamicToolRow,
  isBackgroundToolInput,
  metadataFileChanges,
  parseBackgroundCompletion,
  toolRow,
  touchedPaths,
  workspacePath,
  type BackgroundCompletion,
} from "./tool-mapping.ts";
import {
  ARCHIVED_SESSION_MESSAGE,
  DELETED_SESSION_MESSAGE,
  MOVED_SESSION_MESSAGE,
  createInteractionContext,
  inputRecord,
  isSubagentTool,
  parseInputText,
  stringValue,
  type ActiveTurn,
  type BackgroundTaskRecord,
  type ChildSessionRecord,
  type InteractionContext,
  type OpenCodeApi,
  type OpenCodeRecord,
  type SessionState,
  type UsageTotals,
  usageTotal,
} from "../types.ts";

type RecordValue = OpenCodeRecord;

const SHELL_OUTPUT_POLL_MS = 400;
const SHELL_OUTPUT_CHUNK_BYTES = 32 * 1024;
const TURN_DIFF_CONTEXT_LINES = 3;
const TURN_DIFF_TIMEOUT_MS = 2_000;
const CHILD_RECONCILE_PAGE_SIZE = 100;
const CHILD_RECONCILE_MAX_PAGES = 5;
const CHILD_RECONCILE_MAX_CHILDREN = 500;
const CHILD_RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * OpenCode v2 reports a shell tool's exit status as `metadata.exit` on
 * `session.tool.success` (a non-zero exit is still a "success" event) and
 * appends "Exited with code N" to the content.
 */
export function shellExitCode(data: RecordValue): number | undefined {
  const candidates = [inputRecord(data.metadata).exit, data.exitCode];
  for (const value of candidates)
    if (typeof value === "number" && Number.isInteger(value)) return value;
  const match = contentText(data.content).match(/Exited with code (-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

function sessionToolRow(session: SessionState, name: string, input: unknown) {
  return (
    (session.dynamicTools.length > 0
      ? dynamicToolRow(
          dynamicMcpServerName(session.providerThreadId),
          session.dynamicTools,
          name,
          input,
        )
      : undefined) ?? toolRow(name, input, session.cwd)
  );
}

export function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function usageCostAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** OpenCode reports session cost in USD; ignore malformed values. */
function usageCost(value: number | undefined) {
  return value === undefined ? undefined : { amount: value, currency: "USD" };
}

function zeroUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function breakdownFromTotals(totals: UsageTotals) {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    reasoningOutputTokens: totals.reasoning,
    cachedInputTokens: totals.cacheRead,
    totalTokens: usageTotal(totals),
  };
}

export function usageTotals(raw: unknown): UsageTotals {
  const tokens = inputRecord(raw);
  const cache = inputRecord(tokens.cache);
  return {
    input: tokenCount(tokens.input),
    output: tokenCount(tokens.output),
    reasoning: tokenCount(tokens.reasoning),
    cacheRead: tokenCount(cache.read),
    cacheWrite: tokenCount(cache.write),
  };
}

function addUsage(totals: UsageTotals, add: UsageTotals): UsageTotals {
  return {
    input: totals.input + add.input,
    output: totals.output + add.output,
    reasoning: totals.reasoning + add.reasoning,
    cacheRead: totals.cacheRead + add.cacheRead,
    cacheWrite: totals.cacheWrite + add.cacheWrite,
  };
}

function maxUsage(current: UsageTotals, next: UsageTotals): UsageTotals {
  return {
    input: Math.max(current.input, next.input),
    output: Math.max(current.output, next.output),
    reasoning: Math.max(current.reasoning, next.reasoning),
    cacheRead: Math.max(current.cacheRead, next.cacheRead),
    cacheWrite: Math.max(current.cacheWrite, next.cacheWrite),
  };
}

export function mergeUsageTotals(
  current: UsageTotals,
  next: UsageTotals,
): UsageTotals {
  return maxUsage(current, next);
}

function sameUsage(left: UsageTotals, right: UsageTotals) {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  );
}

function shellCompletionKey(shellId: string) {
  return `shell:${shellId}`;
}

function childCompletionKey(childId: string) {
  return `child:${childId}`;
}

function completionKey(completion: BackgroundCompletion) {
  return completion.kind === "shell"
    ? shellCompletionKey(completion.shellId ?? completion.id)
    : childCompletionKey(completion.childId ?? completion.id);
}

function taskCompletion(
  task: BackgroundTaskRecord,
  state: BackgroundCompletion["state"],
  text: string,
): BackgroundCompletion {
  return {
    kind: task.kind,
    id: task.shellId ?? task.childSessionId ?? task.id,
    ...(task.shellId ? { shellId: task.shellId } : {}),
    ...(task.childSessionId ? { childId: task.childSessionId } : {}),
    state,
    text,
  };
}

function shellCompletion(
  shellId: string,
  status: string,
  exit: number | undefined,
  text: string,
): BackgroundCompletion {
  return {
    kind: "shell",
    id: shellId,
    shellId,
    state:
      status === "killed"
        ? "cancelled"
        : status === "timeout"
          ? "error"
          : "completed",
    text,
    ...(exit !== undefined ? { exit } : {}),
    ...(status === "timeout" ? { timeout: true } : {}),
  };
}

function childUsage(children: Iterable<ChildSessionRecord>) {
  let totals = zeroUsage();
  let cost: number | undefined;
  for (const child of children) {
    if (!child.usage) continue;
    totals = addUsage(totals, child.usage.tokens);
    if (child.usage.cost !== undefined) cost = (cost ?? 0) + child.usage.cost;
  }
  return { totals, cost };
}

function usageSnapshotDeltas(
  session: SessionState,
  active: ActiveTurn | undefined,
  parent: UsageTotals,
  children: Iterable<ChildSessionRecord>,
): RecordValue[] {
  const child = childUsage(children);
  const total = addUsage(parent, child.totals);
  const last = active
    ? usageTotals(active.lastStepTokens ?? {})
    : (session.lastUsage?.tokens ?? zeroUsage());
  const size = session.contextWindow ?? null;
  const used = active
    ? active.lastStepTokens
      ? usageTotal(last)
      : null
    : (session.lastUsage?.used ?? null);
  const totalCost =
    session.usageCost === undefined
      ? child.cost
      : session.usageCost + (child.cost ?? 0);
  // BB applies a usage delta without providerTurnId to the current or last
  // turn, so late child usage does not need a synthetic turn ID.
  const providerTurnId = active?.interaction.providerTurnId;
  return [
    {
      kind: "usage",
      total: breakdownFromTotals(total),
      last: breakdownFromTotals(last),
      modelContextWindow: size,
      ...(providerTurnId ? { providerTurnId } : {}),
    },
    ...(used !== null
      ? [
          {
            kind: "contextWindow",
            used,
            size,
            estimated: false,
            attach: "currentOrLast",
            ...(totalCost !== undefined ? { cost: usageCost(totalCost) } : {}),
            ...(providerTurnId ? { providerTurnId } : {}),
          },
        ]
      : []),
  ];
}

/**
 * `session.usage.updated` carries OpenCode's cumulative session totals, so it
 * stays correct across resumes and workers. The latest step's tokens are the
 * last request's usage and approximate the live context size. Only the parent
 * session updates `session.usage`; child totals are added to the emitted total.
 */
export function usageDeltas(
  session: SessionState,
  active: ActiveTurn | undefined,
  totals: unknown,
  cost?: unknown,
  children: Iterable<ChildSessionRecord> = [],
): RecordValue[] {
  const parent = usageTotals(totals);
  session.usage = parent;
  const parentCost = usageCostAmount(cost);
  if (parentCost !== undefined) session.usageCost = parentCost;
  if (active?.lastStepTokens) {
    const last = usageTotals(active.lastStepTokens);
    session.lastUsage = { tokens: last, used: usageTotal(last) };
  }
  return usageSnapshotDeltas(session, active, parent, children);
}

function childUsageDeltas(
  session: SessionState,
  active: ActiveTurn | undefined,
  children: Iterable<ChildSessionRecord>,
): RecordValue[] {
  return usageSnapshotDeltas(session, active, session.usage, children);
}

export function mergeChildUsage(
  record: ChildSessionRecord,
  tokens: UsageTotals,
  cost?: number,
): boolean {
  const nextTokens = record.usage
    ? maxUsage(record.usage.tokens, tokens)
    : tokens;
  const nextCost =
    cost === undefined
      ? record.usage?.cost
      : Math.max(record.usage?.cost ?? 0, cost);
  if (
    record.usage &&
    sameUsage(record.usage.tokens, nextTokens) &&
    record.usage.cost === nextCost
  )
    return false;
  record.usage = {
    tokens: nextTokens,
    ...(nextCost !== undefined ? { cost: nextCost } : {}),
  };
  return true;
}

function retryErrorCategory(error: RecordValue) {
  const text =
    `${stringValue(error.type) ?? ""} ${stringValue(error.message) ?? ""}`.toLowerCase();
  if (/rate.?limit|429|too many requests/.test(text)) return "rate-limit";
  if (/overload|529|503|unavailable/.test(text)) return "overloaded";
  if (/timeout|connection|network|econn|socket/.test(text))
    return "connection-failed";
  return undefined;
}

const CHILD_EVENT_PATTERN =
  /^(permission\.asked|session\.(text|reasoning|tool)\.)/;

/** The subagent's final report, without OpenCode's wrapper tag. */
export function subagentSummary(text: string): string {
  return text
    .replace(/^\s*<subagent\b[^>]*>\s*/, "")
    .replace(/\s*<\/subagent>\s*$/, "")
    .trim();
}

export type OpenCodeEventRouterHooks = {
  onSessionGone?: (
    session: SessionState,
    reason: string,
  ) => Promise<void> | void;
  notify?: typeof notify;
  requestInteraction?: ConstructorParameters<typeof OpenCodeInteractions>[2];
};

export class OpenCodeEventRouter {
  private readonly interactions: OpenCodeInteractions;
  private readonly emitTimeline: typeof emit;
  private readonly sessionLookup: ReadonlyMap<string, SessionState>;
  private readonly api: OpenCodeApi;
  private readonly onSessionGone?: OpenCodeEventRouterHooks["onSessionGone"];
  private readonly sendNotification: typeof notify;
  /** Native subagent sessions, shared with background-task support. */
  private readonly childSessions = new Map<string, ChildSessionRecord>();
  /** Child IDs by parent provider session, an index over the registry. */
  private readonly childIdsByParent = new Map<string, Set<string>>();
  /** Shell ID -> the session and task showing it, for global shell events. */
  private readonly shellTaskOwners = new Map<
    string,
    { session: SessionState; taskId: string }
  >();
  /** Provider item ID -> the delegation call it is nested under. */
  private readonly parentRefs = new Map<string, string>();
  /** Set while handling a child-session event. */
  private childParentRef?: string;

  constructor(
    api: OpenCodeApi,
    emitTimeline: typeof emit = emit,
    sessionLookup: ReadonlyMap<string, SessionState> = sessionsByProviderId,
    hooks: OpenCodeEventRouterHooks = {},
  ) {
    this.api = api;
    this.emitTimeline = emitTimeline;
    this.interactions = new OpenCodeInteractions(
      api,
      this.emit,
      hooks.requestInteraction,
    );
    this.sessionLookup = sessionLookup;
    this.onSessionGone = hooks.onSessionGone;
    this.sendNotification = hooks.notify ?? notify;
  }

  private registerChildSession(
    childId: string,
    parent: SessionState,
    callId: string,
    options: { terminal?: boolean; updateCallId?: boolean } = {},
  ): ChildSessionRecord {
    const existing = this.childSessions.get(childId);
    if (existing) {
      if (existing.parentProviderThreadId !== parent.providerThreadId) {
        this.childIdsByParent
          .get(existing.parentProviderThreadId)
          ?.delete(childId);
        this.addChildIndex(parent.providerThreadId, childId);
      }
      existing.parentThreadId = parent.bbThreadId;
      existing.parentProviderThreadId = parent.providerThreadId;
      if (options.updateCallId && callId) existing.callId = callId;
      else if (!existing.callId && callId) existing.callId = callId;
      if (options.terminal !== undefined) existing.terminal = options.terminal;
      return existing;
    }
    const record: ChildSessionRecord = {
      parentThreadId: parent.bbThreadId,
      parentProviderThreadId: parent.providerThreadId,
      callId,
      terminal: options.terminal ?? false,
    };
    this.childSessions.set(childId, record);
    this.addChildIndex(parent.providerThreadId, childId);
    return record;
  }

  private addChildIndex(parentProviderThreadId: string, childId: string) {
    let ids = this.childIdsByParent.get(parentProviderThreadId);
    if (!ids) {
      ids = new Set();
      this.childIdsByParent.set(parentProviderThreadId, ids);
    }
    ids.add(childId);
  }

  private childRecords(parent: SessionState): ChildSessionRecord[] {
    const ids = this.childIdsByParent.get(parent.providerThreadId);
    if (!ids) return [];
    const records: ChildSessionRecord[] = [];
    for (const childId of ids) {
      const child = this.childSessions.get(childId);
      if (child) records.push(child);
    }
    return records;
  }

  private parentForChild(record: ChildSessionRecord) {
    const parent = this.sessionLookup.get(record.parentProviderThreadId);
    return parent?.bbThreadId === record.parentThreadId ? parent : undefined;
  }

  private backgroundTaskForCall(session: SessionState, callId: string) {
    return session.backgroundTasks.get(backgroundTaskKey(callId));
  }

  private backgroundTaskForShell(session: SessionState, shellId: string) {
    const owner = this.shellTaskOwners.get(shellId);
    if (owner?.session === session) {
      const task = session.backgroundTasks.get(owner.taskId);
      if (task) return task;
    }
    for (const task of session.backgroundTasks.values())
      if (task.shellId === shellId) return task;
    return undefined;
  }

  private backgroundTaskForChild(session: SessionState, childId: string) {
    const taskId = this.childSessions.get(childId)?.backgroundTaskId;
    if (taskId) {
      const task = session.backgroundTasks.get(taskId);
      if (task) return task;
    }
    for (const task of session.backgroundTasks.values())
      if (task.childSessionId === childId) return task;
    return undefined;
  }

  private markBackgroundChild(
    session: SessionState,
    childId: string,
    callId: string,
    task: BackgroundTaskRecord,
    terminal = false,
  ) {
    const record = this.registerChildSession(childId, session, callId, {
      terminal,
      updateCallId: true,
    });
    record.background = true;
    record.backgroundTaskId = task.id;
    task.childSessionId = childId;
    task.interaction.formSessionId = childId;
    return record;
  }

  private openBackgroundTask(
    session: SessionState,
    callId: string,
    name: string,
    input: unknown,
    providerTurnId?: string,
  ) {
    const existing = this.backgroundTaskForCall(session, callId);
    if (existing) return existing;
    const kind = isSubagentTool(name) ? "subagent" : "shell";
    const description = backgroundTaskDescription(name, input);
    const item = backgroundTaskItem({
      familyId: backgroundTaskKey(callId),
      taskType: backgroundTaskTaskType(name),
      description,
    });
    const task: BackgroundTaskRecord = {
      id: backgroundTaskKey(callId),
      callId,
      kind,
      startedAt: Date.now(),
      settled: false,
      item,
      interaction: createInteractionContext({
        providerTurnId: null,
        formSessionId: "",
        background: true,
      }),
    };
    session.backgroundTasks.set(task.id, task);
    this.emit(session.bbThreadId, [
      {
        kind: "item.open",
        key: itemKey(task.id, "tool"),
        item,
        ...(providerTurnId ? { providerTurnId } : {}),
      },
    ]);
    this.applyPendingBackgroundCompletion(session, task);
    return task;
  }

  private emitBackgroundProgress(
    session: SessionState,
    task: BackgroundTaskRecord,
  ) {
    this.emit(session.bbThreadId, [
      {
        kind: "item.progress",
        key: itemKey(task.id, "tool"),
        snapshot: task.item,
      },
    ]);
  }

  private updateBackgroundTask(
    session: SessionState,
    task: BackgroundTaskRecord,
    metadata: unknown,
  ) {
    const raw = inputRecord(metadata);
    if (task.kind === "shell") {
      const shellId = stringValue(raw.shellID);
      if (!shellId) return;
      task.shellId = shellId;
      this.shellTaskOwners.set(shellId, {
        session,
        taskId: task.id,
      });
      const file = session.shellOutputFiles.get(shellId);
      if (file) {
        task.outputFile = file;
        task.item.outputFile = file;
      }
    } else {
      const childId = stringValue(raw.sessionID);
      if (!childId) return;
      this.markBackgroundChild(session, childId, task.callId, task);
    }
    this.emitBackgroundProgress(session, task);
    this.applyPendingBackgroundCompletion(session, task);
  }

  private bufferBackgroundCompletion(
    session: SessionState,
    completion: BackgroundCompletion,
  ) {
    rememberBounded(
      session.pendingBackgroundCompletions,
      completionKey(completion),
      completion as OpenCodeRecord,
      100,
    );
  }

  private applyPendingBackgroundCompletion(
    session: SessionState,
    task: BackgroundTaskRecord,
  ) {
    if (task.settled) return;
    const map = session.pendingBackgroundCompletions;
    const keys = [
      task.shellId ? shellCompletionKey(task.shellId) : undefined,
      task.childSessionId ? childCompletionKey(task.childSessionId) : undefined,
    ].filter((key): key is string => key !== undefined);
    for (const key of keys) {
      const completion = map.get(key) as BackgroundCompletion | undefined;
      if (!completion) continue;
      map.delete(key);
      this.settleBackgroundTask(session, task, completion);
      return;
    }
  }

  private backgroundChildContext(
    session: SessionState,
    record: ChildSessionRecord,
  ) {
    const task = record.backgroundTaskId
      ? session.backgroundTasks.get(record.backgroundTaskId)
      : undefined;
    return task?.interaction;
  }

  private closeInteractionContext(
    session: SessionState,
    context: InteractionContext,
    status: "completed" | "interrupted" | "failed",
    providerTurnId?: string,
  ) {
    context.abortController.abort();
    for (const [, formId] of context.openQuestions)
      void this.interactions
        .cancelQuestionForm(context, formId)
        .catch(() => {});
    context.openQuestions.clear();
    this.interactions.cancelQuestionWaiters(context);
    for (const [id, item] of context.opened) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKeyForOpenItem(id, item),
          status,
          item,
          ...(providerTurnId ? { providerTurnId } : {}),
        },
      ]);
      this.parentRefs.delete(id);
    }
    context.opened.clear();
  }

  private settleBackgroundTask(
    session: SessionState,
    task: BackgroundTaskRecord,
    completion: BackgroundCompletion,
  ) {
    if (task.settled) return;
    task.settled = true;
    if (task.shellId) this.shellTaskOwners.delete(task.shellId);
    this.closeInteractionContext(
      session,
      task.interaction,
      completion.state === "cancelled" ? "interrupted" : "failed",
    );
    const completedAt = Date.now();
    const failed =
      completion.state !== "completed" ||
      (completion.kind === "shell" &&
        (completion.timeout === true ||
          (completion.exit !== undefined && completion.exit !== 0)));
    const interrupted = completion.state === "cancelled";
    const taskStatus = interrupted
      ? ("stopped" as const)
      : failed
        ? ("failed" as const)
        : ("completed" as const);
    const status = backgroundTaskItemStatus(taskStatus);
    const summary = completion.text
      ? boundedTimelineText(completion.text, 16 * 1024)
      : undefined;
    const error = failed
      ? completion.timeout
        ? "Command timed out"
        : completion.exit !== undefined && completion.exit !== 0
          ? `Exited with code ${completion.exit}`
          : completion.text || "Background task failed"
      : undefined;
    const item: RecordValue = {
      ...task.item,
      status,
      taskStatus,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      ...(task.outputFile ? { outputFile: task.outputFile } : {}),
    };
    if (task.kind === "subagent" && task.childSessionId) {
      const child = this.childSessions.get(task.childSessionId);
      if (child) {
        child.terminal = true;
        const usage = backgroundTaskUsage(
          child.usage?.tokens,
          task.startedAt,
          completedAt,
        );
        if (usage) item.usage = usage;
      }
    }
    this.emit(session.bbThreadId, [
      {
        kind: "item.close",
        key: itemKey(task.id, "tool"),
        status,
        item,
      },
    ]);
  }

  interruptBackgroundTasks(session: SessionState, reason?: string) {
    for (const task of session.backgroundTasks.values()) {
      if (task.settled) continue;
      this.settleBackgroundTask(
        session,
        task,
        taskCompletion(task, "cancelled", reason ?? "Task interrupted"),
      );
    }
  }

  clearBackgroundTasks(session: SessionState) {
    for (const task of session.backgroundTasks.values()) {
      if (task.shellId) this.shellTaskOwners.delete(task.shellId);
      for (const id of task.interaction.opened.keys())
        this.parentRefs.delete(id);
    }
    session.backgroundTasks.clear();
    session.pendingBackgroundCompletions.clear();
    session.shellOutputFiles.clear();
  }

  clearSession(session: SessionState) {
    this.clearBackgroundTasks(session);
    this.clearChildSessions(session.providerThreadId);
  }

  private handleSynthetic(session: SessionState, data: RecordValue) {
    const completion = parseBackgroundCompletion(data);
    if (!completion) return;
    const task =
      completion.kind === "shell"
        ? ((completion.shellId
            ? this.backgroundTaskForShell(session, completion.shellId)
            : undefined) ??
          (completion.jobId
            ? this.backgroundTaskForShell(session, completion.jobId)
            : undefined))
        : this.backgroundTaskForChild(
            session,
            completion.childId ?? completion.id,
          );
    if (task) this.settleBackgroundTask(session, task, completion);
    else this.bufferBackgroundCompletion(session, completion);
  }

  private rememberShellOutput(
    session: SessionState,
    shellId: string,
    file: string,
  ) {
    rememberBounded(session.shellOutputFiles, shellId, file, 200);
    for (const task of session.backgroundTasks.values())
      if (task.shellId === shellId && !task.settled) {
        task.outputFile = file;
        task.item.outputFile = file;
      }
  }

  private handleShellStarted(session: SessionState, data: RecordValue) {
    const shell = inputRecord(data.shell ?? data.info);
    const shellId = stringValue(shell.id);
    const file = stringValue(shell.file);
    if (shellId && file) this.rememberShellOutput(session, shellId, file);
  }

  private handleShellEnded(session: SessionState, data: RecordValue) {
    const shell = inputRecord(data.shell);
    const shellId = stringValue(shell.id);
    if (!shellId) return;
    const task = this.backgroundTaskForShell(session, shellId);
    if (!task || task.settled) return;
    const status = stringValue(shell.status) ?? "exited";
    const exit =
      typeof shell.exit === "number" && Number.isFinite(shell.exit)
        ? shell.exit
        : undefined;
    this.settleBackgroundTask(
      session,
      task,
      shellCompletion(
        shellId,
        status,
        exit,
        stringValue(data.output) ??
          stringValue(inputRecord(data.output).output) ??
          "",
      ),
    );
  }

  private handleShellExited(data: RecordValue) {
    const shellId = stringValue(data.id);
    if (!shellId) return;
    const status = stringValue(data.status) ?? "exited";
    const exit =
      typeof data.exit === "number" && Number.isFinite(data.exit)
        ? data.exit
        : undefined;
    const text =
      status === "timeout"
        ? "Command timed out"
        : status === "killed"
          ? "Command cancelled"
          : exit !== undefined && exit !== 0
            ? `Exited with code ${exit}`
            : "";
    const owner = this.shellTaskOwners.get(shellId);
    if (owner) {
      const task = owner.session.backgroundTasks.get(owner.taskId);
      if (task && !task.settled)
        this.settleBackgroundTask(
          owner.session,
          task,
          shellCompletion(shellId, status, exit, text),
        );
      return;
    }
    for (const session of this.sessionLookup.values()) {
      if (session.backgroundTasks.size === 0) continue;
      const task = this.backgroundTaskForShell(session, shellId);
      if (!task || task.settled) continue;
      this.settleBackgroundTask(
        session,
        task,
        shellCompletion(shellId, status, exit, text),
      );
    }
  }

  private handleShellCreated(data: RecordValue) {
    const info = inputRecord(data.info);
    const shellId = stringValue(info.id);
    const file = stringValue(info.file);
    const sessionId = stringValue(inputRecord(info.metadata).sessionID);
    if (!shellId || !file) return;
    const session = sessionId ? this.sessionLookup.get(sessionId) : undefined;
    if (session) this.rememberShellOutput(session, shellId, file);
  }

  private handleChildUsage(record: ChildSessionRecord, data: RecordValue) {
    const parent = this.parentForChild(record);
    if (!parent) return;
    if (data.tokens === undefined) return;
    if (
      !mergeChildUsage(
        record,
        usageTotals(data.tokens),
        usageCostAmount(data.cost),
      )
    )
      return;
    this.emit(
      parent.bbThreadId,
      childUsageDeltas(parent, parent.active, this.childRecords(parent)),
    );
  }

  /**
   * Rebuild child usage from OpenCode after a reconnect or resume. The event
   * stream does not replay, so this is the only way to recover usage that
   * arrived while the bridge was disconnected. The scan is bounded by age,
   * pages, and total children, and merges monotonically.
   */
  async reconcileChildSessions(session: SessionState): Promise<void> {
    const api = await this.api();
    const cutoff = Date.now() - CHILD_RECONCILE_WINDOW_MS;
    const queue = [session.providerThreadId];
    const visited = new Set(queue);
    let queueIndex = 0;
    let discovered = 0;
    let usageChanged = false;
    while (
      queueIndex < queue.length &&
      discovered < CHILD_RECONCILE_MAX_CHILDREN
    ) {
      const parentId = queue[queueIndex++];
      let cursor: string | undefined;
      for (
        let page = 0;
        page < CHILD_RECONCILE_MAX_PAGES &&
        discovered < CHILD_RECONCILE_MAX_CHILDREN;
        page++
      ) {
        const result = inputRecord(
          await api.session.list({
            parentID: parentId,
            limit: CHILD_RECONCILE_PAGE_SIZE,
            ...(cursor ? { cursor } : { order: "desc" as const }),
          }),
        );
        const rows = Array.isArray(result.data)
          ? result.data.map(inputRecord)
          : [];
        if (rows.length === 0) break;
        let reachedOld = false;
        for (const info of rows) {
          const updated = inputRecord(info.time).updated;
          if (typeof updated === "number" && updated < cutoff) {
            reachedOld = true;
            break;
          }
          const childId = stringValue(info.id);
          if (!childId || visited.has(childId)) continue;
          visited.add(childId);
          queue.push(childId);
          discovered++;
          const time = inputRecord(info.time);
          const busy = typeof time.busy === "number" ? time.busy : undefined;
          const idle = typeof time.idle === "number" ? time.idle : undefined;
          const running =
            busy !== undefined && (idle === undefined || busy > idle);
          const existing = this.childSessions.get(childId);
          const callId = existing?.callId ?? "";
          const record = this.registerChildSession(childId, session, callId, {
            terminal: !callId || (!running && info.outcome !== undefined),
          });
          if (
            mergeChildUsage(
              record,
              usageTotals(info.tokens),
              usageCostAmount(info.cost),
            )
          )
            usageChanged = true;
          if (discovered >= CHILD_RECONCILE_MAX_CHILDREN) break;
        }
        if (reachedOld || discovered >= CHILD_RECONCILE_MAX_CHILDREN) break;
        const next = stringValue(inputRecord(result.cursor).next);
        if (!next || next === cursor) break;
        cursor = next;
      }
    }
    if (usageChanged && (session.active || session.lastUsage))
      this.emit(
        session.bbThreadId,
        childUsageDeltas(session, session.active, this.childRecords(session)),
      );
  }

  /**
   * Settle background tasks whose completion synthetic arrived while the
   * event stream was down. The stream is live-only; the same synthetic is
   * also durable in the session's message history.
   */
  async reconcileBackgroundTasks(session: SessionState): Promise<void> {
    if (![...session.backgroundTasks.values()].some((task) => !task.settled))
      return;
    const api = await this.api();
    const result = await api.message.list({
      sessionID: session.providerThreadId,
      limit: 50,
      order: "desc" as const,
    });
    const messages = Array.isArray(result.data) ? result.data : [];
    for (const value of messages) {
      const message = inputRecord(value);
      if (stringValue(message.type) !== "synthetic") continue;
      this.handleSynthetic(session, message);
    }
  }

  clearChildSessions(parentProviderThreadId?: string): void {
    if (parentProviderThreadId === undefined) {
      this.childSessions.clear();
      this.childIdsByParent.clear();
      this.shellTaskOwners.clear();
      return;
    }
    const ids = this.childIdsByParent.get(parentProviderThreadId);
    if (!ids) return;
    for (const childId of ids) this.childSessions.delete(childId);
    this.childIdsByParent.delete(parentProviderThreadId);
  }

  /**
   * Emit deltas, nesting items that belong to a native subagent under its
   * delegation row. An item first opened while handling a child-session
   * event records its parent; later deltas for it (output, close, turn-end
   * cleanup) reuse that parent wherever they are emitted from.
   */
  private readonly emit = (threadId: string, deltas: RecordValue[]) => {
    this.emitTimeline(
      threadId,
      deltas.map((delta) => {
        const key = inputRecord(delta.key);
        const id = stringValue(key.providerItemId);
        if (!id) return delta;
        if (
          delta.kind === "item.open" &&
          this.childParentRef &&
          !this.parentRefs.has(id)
        )
          this.parentRefs.set(id, this.childParentRef);
        const parentRef = this.parentRefs.get(id);
        return parentRef ? { ...delta, key: { ...key, parentRef } } : delta;
      }),
    );
  };

  async handleEvent(event: RecordValue): Promise<void> {
    const data = inputRecord(event.data);
    const eventType = stringValue(event.type) ?? "";
    if (eventType === "shell.created") {
      this.handleShellCreated(data);
      return;
    }
    if (eventType === "shell.exited") {
      this.handleShellExited(data);
      return;
    }
    const form =
      eventType === "form.created" ? inputRecord(data.form) : undefined;
    const sessionId =
      stringValue(data.sessionID) ??
      (form ? stringValue(form.sessionID) : undefined);
    if (!sessionId) return;
    const session = this.sessionLookup.get(sessionId);
    const child = session ? undefined : this.childSessions.get(sessionId);
    const parent = child ? this.parentForChild(child) : undefined;
    const childContext =
      child && parent ? this.backgroundChildContext(parent, child) : undefined;
    if (eventType === "form.created") {
      if (session?.active) {
        this.interactions.handleCreatedForm(session, form ?? {});
      } else if (childContext && child && parent) {
        this.childParentRef = child.backgroundTaskId;
        try {
          this.interactions.handleCreatedForm(parent, form ?? {}, childContext);
        } finally {
          this.childParentRef = undefined;
        }
      }
      return;
    }
    if (eventType === "permission.replied") {
      if (session) this.interactions.handlePermissionReplied(session, data);
      else if (childContext && parent)
        this.interactions.handlePermissionReplied(parent, data, childContext);
      return;
    }
    if (eventType === "form.replied" || eventType === "form.cancelled") {
      if (session) this.interactions.handleFormEvent(session, eventType, data);
      else if (childContext && parent)
        this.interactions.handleFormEvent(
          parent,
          eventType,
          data,
          childContext,
        );
      return;
    }
    if (session) return this.handleSessionEvent(session, event, data);
    if (!child) return;
    if (eventType === "session.usage.updated") {
      this.handleChildUsage(child, data);
      return;
    }
    if (child.backgroundTaskId) {
      if (eventType === "permission.asked" && parent && childContext) {
        void this.interactions.handlePermission(parent, data, childContext);
      } else if (eventType.startsWith("session.execution.")) {
        child.terminal = true;
      }
      return;
    }
    if (child.terminal || !CHILD_EVENT_PATTERN.test(eventType)) return;
    if (!parent) return;
    this.childParentRef = child.callId;
    try {
      await this.handleSessionEvent(parent, event, data);
    } finally {
      this.childParentRef = undefined;
    }
  }

  private async handleSessionEvent(
    session: SessionState,
    event: RecordValue,
    data: RecordValue,
  ): Promise<void> {
    const active = session.active;
    const eventId = stringValue(data.id) ?? "";
    const eventType = stringValue(event.type) ?? "";
    const metadata = inputRecord(data.metadata);
    const childId = stringValue(metadata.sessionID);
    const task = eventId
      ? this.backgroundTaskForCall(session, eventId)
      : undefined;
    if (
      childId &&
      (eventType === "session.tool.progress" ||
        eventType === "session.tool.success" ||
        eventType === "session.tool.failed")
    ) {
      const live = active !== undefined;
      const terminal =
        !live ||
        eventType === "session.tool.failed" ||
        (eventType === "session.tool.success" &&
          stringValue(metadata.status) !== "running");
      if (task) {
        this.markBackgroundChild(session, childId, eventId, task, terminal);
      } else {
        this.registerChildSession(childId, session, eventId, {
          terminal,
          updateCallId: live && eventType === "session.tool.progress",
        });
      }
    }
    if (event.type === "permission.asked") {
      void this.interactions.handlePermission(session, data);
      return;
    }
    if (event.type === "session.agent.selected") {
      this.handleAgentSelected(session, data);
      return;
    }
    if (event.type === "session.renamed") {
      this.handleSessionRenamed(session, data);
      return;
    }
    if (event.type === "session.deleted") {
      await this.handleSessionDeleted(session);
      return;
    }
    if (event.type === "session.moved") {
      await this.handleSessionMoved(session, data);
      return;
    }
    if (event.type === "session.archived") {
      this.handleSessionArchived(session);
      return;
    }
    if (event.type === "session.unarchived") {
      this.handleSessionUnarchived(session);
      return;
    }
    if (eventType === "session.synthetic") {
      this.handleSynthetic(session, data);
      return;
    }
    if (eventType === "session.shell.started") {
      this.handleShellStarted(session, data);
      return;
    }
    if (eventType === "session.shell.ended") {
      this.handleShellEnded(session, data);
      return;
    }
    if (!active) return;
    if (eventType.startsWith("session.tool.") && !eventId) return;
    if (this.handleCompactionEvent(session, active, event.type, data)) return;
    const assistantMessageId = stringValue(data.assistantMessageID);
    const ordinal =
      typeof data.ordinal === "number" && Number.isSafeInteger(data.ordinal)
        ? data.ordinal
        : undefined;
    const textPartId =
      assistantMessageId && ordinal !== undefined
        ? `text:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.text.started" && textPartId) {
      const item = { type: "agentMessage", text: "" };
      active.interaction.opened.set(textPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(textPartId, "agentMessage"),
          item,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.delta" &&
      textPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.delta,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.ended" &&
      textPartId &&
      typeof data.text === "string"
    ) {
      const item = active.interaction.opened.get(textPartId) ?? {
        type: "agentMessage",
        text: data.text,
      };
      item.text = data.text;
      active.interaction.opened.delete(textPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.text,
          providerTurnId: active.interaction.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(textPartId, "agentMessage"),
          status: "completed",
          item,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    const reasoningPartId =
      assistantMessageId && ordinal !== undefined
        ? `reasoning:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.reasoning.started" && reasoningPartId) {
      const item = { type: "reasoning", summary: [], content: [] };
      active.interaction.opened.set(reasoningPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(reasoningPartId, "reasoningText"),
          item,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.delta" &&
      reasoningPartId &&
      typeof data.delta === "string"
    ) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.delta,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.ended" &&
      reasoningPartId &&
      typeof data.text === "string"
    ) {
      const item = active.interaction.opened.get(reasoningPartId) ?? {
        type: "reasoning",
        summary: [],
        content: [],
      };
      item.content = [data.text];
      active.interaction.opened.delete(reasoningPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.text,
          providerTurnId: active.interaction.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(reasoningPartId, "reasoningText"),
          status: "completed",
          item,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.tool.input.started") {
      const toolName = stringValue(data.name);
      if (eventId && toolName) active.pendingTools.set(eventId, toolName);
    }
    if (event.type === "session.tool.input.ended") {
      if (eventId && typeof data.text === "string")
        active.pendingInput.set(eventId, data.text);
    }
    if (event.type === "session.tool.called") {
      const name = active.pendingTools.get(eventId);
      if (name) {
        const input = inputRecord(
          data.input ?? parseInputText(active.pendingInput.get(eventId)),
        );
        if (
          isBackgroundToolInput(name, input) &&
          !(isSubagentTool(name) && session.disableSubagents)
        ) {
          this.openBackgroundTask(
            session,
            eventId,
            name,
            input,
            active.interaction.providerTurnId,
          );
        } else {
          const row = sessionToolRow(session, name, input);
          if (row.item.type === "delegation")
            (row.item as RecordValue).childRef = eventId;
          active.interaction.opened.set(eventId, row.item);
          const touched = touchedPaths(name, input);
          if (touched.length) active.touchedFiles.set(eventId, touched);
          this.emit(session.bbThreadId, [
            {
              kind: "item.open",
              key: itemKey(eventId, "tool"),
              item: row.item,
              presentation: row.presentation,
              providerTurnId: active.interaction.providerTurnId,
            },
          ]);
          // OpenCode's question tool blocks forever waiting on an interactive
          // form that no TUI will answer in a BB thread. Relay it to BB's
          // native question UI instead (see handleQuestion).
          if (name.toLowerCase() === "question") {
            void this.interactions
              .handleQuestion(session, active, eventId)
              .catch(() => {});
          }
        }
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
      } else {
        const item = active.interaction.opened.get(eventId);
        if (item) item.args = data.input;
      }
    }
    if (event.type === "session.tool.progress") {
      if (task) {
        this.updateBackgroundTask(session, task, metadata);
      } else {
        const opened = active.interaction.opened.get(eventId);
        if (childId && opened?.type === "delegation") opened.childRef = childId;
        const shellId = stringValue(metadata.shellID);
        if (shellId && opened?.type === "command")
          this.streamShellOutput(session, active, eventId, shellId);
      }
    }
    if (
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      this.stopShellOutput(active, eventId);
      active.finishedTools ??= new Set();
      if (active.finishedTools.has(eventId)) return;
      active.finishedTools.add(eventId);
      // handleQuestion may already have closed + answered this call.
      if (active.interaction.settledTools.has(eventId)) {
        active.interaction.settledTools.delete(eventId);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        return;
      }
      const name =
        active.pendingTools.get(eventId) ??
        stringValue(data.name) ??
        "OpenCode tool";
      const input = inputRecord(
        data.input ?? parseInputText(active.pendingInput.get(eventId)),
      );
      const output = contentText(data.content);
      const error = inputRecord(data.error);
      if (task) {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        if (event.type === "session.tool.failed") {
          this.settleBackgroundTask(
            session,
            task,
            taskCompletion(
              task,
              "error",
              toolFailureError(
                name,
                session.disableSubagents,
                stringValue(error.message),
              ),
            ),
          );
        } else if (stringValue(metadata.status) !== "running") {
          this.settleBackgroundTask(
            session,
            task,
            taskCompletion(task, "completed", output),
          );
        } else {
          this.updateBackgroundTask(session, task, metadata);
        }
        return;
      }
      const foreground = active.interaction.opened.get(eventId);
      const toolName =
        foreground?.type === "command"
          ? "bash"
          : foreground?.type === "delegation"
            ? "subagent"
            : name;
      const run =
        event.type === "session.tool.success"
          ? backgroundRunMetadata(toolName, metadata)
          : undefined;
      if (run) {
        if (foreground) {
          if (foreground.type === "command")
            foreground.aggregatedOutput = "Moved to background";
          else if (foreground.type === "delegation") {
            foreground.summary = "Moved to background";
            if (childId) foreground.childRef = childId;
          }
          active.interaction.opened.delete(eventId);
          this.emit(session.bbThreadId, [
            {
              kind: "item.close",
              key: itemKey(eventId, "tool"),
              status: "completed",
              item: foreground,
              providerTurnId: active.interaction.providerTurnId,
            },
          ]);
        }
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        const opened = this.openBackgroundTask(
          session,
          eventId,
          toolName,
          input,
          active.interaction.providerTurnId,
        );
        this.updateBackgroundTask(session, opened, metadata);
        return;
      }
      let item = active.interaction.opened.get(eventId);
      if (!item) {
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        item = row.item;
        active.interaction.opened.set(eventId, item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item,
            presentation: row.presentation,
            providerTurnId: active.interaction.providerTurnId,
          },
        ]);
      }
      if (item.type === "delegation") {
        item.summary =
          event.type === "session.tool.success"
            ? subagentSummary(output)
            : toolFailureError(
                isSubagentTool(name) ? name : "subagent",
                session.disableSubagents,
                stringValue(error.message),
              );
        if (!item.summary) delete item.summary;
        if (childId) item.childRef = childId;
      } else if (item.type === "tool") {
        if (event.type === "session.tool.success") item.result = output;
        else {
          item.error = toolFailureError(
            name,
            session.disableSubagents,
            stringValue(error.message),
          );
        }
      } else if (item.type === "command") {
        item.aggregatedOutput =
          event.type === "session.tool.success"
            ? output
            : (stringValue(error.message) ?? "OpenCode tool failed");
        const exitCode = shellExitCode(data);
        item.exitCode =
          event.type === "session.tool.success"
            ? (exitCode ?? 0)
            : (exitCode ?? 1);
      }
      active.interaction.opened.delete(eventId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKey(eventId, "tool"),
          status:
            event.type.endsWith("failed") ||
            (item.type === "command" && item.exitCode !== 0)
              ? "failed"
              : "completed",
          ...(item.type === "tool" && item.result
            ? { resultText: item.result }
            : {}),
          item,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
      if (event.type === "session.tool.success") {
        const touched =
          active.touchedFiles.get(eventId) ?? touchedPaths(name, input);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        const patched = metadataFileChanges(data.metadata, session.cwd);
        if (patched.length) {
          this.emitFileChangeRow(session, active, `files:${eventId}`, patched);
        } else if (touched.length) {
          this.emitFileChangeRow(
            session,
            active,
            `files:${eventId}`,
            touched.map((path) => ({
              path: workspacePath(session.cwd, path),
              kind: "update",
            })),
          );
        }
      } else {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
      }
    }
    if (
      event.type === "session.step.ended" ||
      event.type === "session.step.failed"
    ) {
      if (data.tokens !== undefined)
        active.lastStepTokens = inputRecord(data.tokens);
    }
    if (event.type === "session.usage.updated") {
      this.emit(
        session.bbThreadId,
        usageDeltas(
          session,
          active,
          data.tokens,
          data.cost,
          this.childRecords(session),
        ),
      );
    }
    if (event.type === "session.retry.scheduled") {
      const error = inputRecord(data.error);
      const attempt =
        typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : "";
      const category = retryErrorCategory(error);
      this.emit(session.bbThreadId, [
        {
          kind: "provider.error",
          message: `${stringValue(error.message) ?? "OpenCode model request failed"}. Retrying${attempt}.`,
          willRetry: true,
          ...(category ? { category } : {}),
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.inbox.enqueued") {
      this.adoptCommandCheckpoint(active, stringValue(data.inboxID));
    }
    if (event.type === "session.inbox.delivered") {
      const inboxId = stringValue(data.inboxID);
      if (this.adoptCommandCheckpoint(active, inboxId)) {
        active.inputDelivered = true;
      } else if (inboxId && active.promptIds?.has(inboxId)) {
        active.inputDelivered = true;
      }
    }
    if (
      eventType.startsWith("session.execution.") &&
      (active.awaitingCommandCheckpoint ||
        (active.promptIds?.size && !active.inputDelivered))
    )
      return;
    if (event.type === "session.execution.succeeded")
      await this.finish(session, "completed");
    if (event.type === "session.execution.interrupted")
      await this.finish(session, "interrupted");
    if (event.type === "session.execution.failed") {
      const error = inputRecord(data.error);
      await this.finish(
        session,
        "failed",
        stringValue(error.message) ?? "OpenCode execution failed",
      );
    }
  }

  private notifyRecovery(
    session: SessionState,
    kind: "sessionArchived" | "restartRecommended",
    message: string,
  ) {
    this.sendNotification("provider/recovery", {
      kind,
      message,
      retryable: false,
      threadId: session.bbThreadId,
    });
  }

  private async detachSession(session: SessionState, reason: string) {
    this.interruptBackgroundTasks(session, reason);
    this.clearSession(session);
    await releaseSessionTools(session, reason, () => this.api());
    if (this.sessionLookup.get(session.providerThreadId) === session) {
      (this.sessionLookup as Map<string, SessionState>).delete(
        session.providerThreadId,
      );
    }
    removeSessionEntries(session);
    await this.onSessionGone?.(session, reason);
  }

  private async handleSessionDeleted(session: SessionState) {
    if (session.closing) return;
    if (session.active)
      await this.finish(session, "failed", DELETED_SESSION_MESSAGE);
    session.terminalError = DELETED_SESSION_MESSAGE;
    session.terminalKind = "deleted";
    this.notifyRecovery(session, "restartRecommended", DELETED_SESSION_MESSAGE);
    await this.detachSession(session, DELETED_SESSION_MESSAGE);
  }

  private async handleSessionMoved(session: SessionState, data: RecordValue) {
    if (session.closing) return;
    const directory = stringValue(inputRecord(data.location).directory);
    const message = directory
      ? `The OpenCode session moved to ${directory}. Start a new thread to continue there.`
      : MOVED_SESSION_MESSAGE;
    session.terminalError = message;
    session.terminalKind = "moved";
    if (session.active) await this.finish(session, "failed", message);
    this.interruptBackgroundTasks(session, message);
    this.clearBackgroundTasks(session);
    this.notifyRecovery(session, "restartRecommended", message);
  }

  private handleSessionArchived(session: SessionState) {
    if (session.closing) return;
    session.terminalError = ARCHIVED_SESSION_MESSAGE;
    session.terminalKind = "archived";
    this.notifyRecovery(session, "sessionArchived", ARCHIVED_SESSION_MESSAGE);
  }

  private handleSessionUnarchived(session: SessionState) {
    if (session.terminalKind !== "archived") return;
    session.terminalError = undefined;
    session.terminalKind = undefined;
  }

  /** Mirror an agent selected in OpenCode back into BB's session options. */
  private handleAgentSelected(session: SessionState, data: RecordValue) {
    const agent = stringValue(data.agent);
    if (!agent) return;
    session.agent = agent;
    // Plan mode owns the agent for its turn; the next ordinary turn restores
    // the BB choice. Do not overwrite it with the plan switch's own event.
    if (session.planMode) return;
    if (agent === session.agentChoice) return;
    session.agentChoice = agent;
    this.publishAgentChoice(session, agent);
  }

  private publishAgentChoice(session: SessionState, agent: string) {
    if (session.publishedAgentSelection !== agent) {
      session.publishedAgentSelection = agent;
      this.emit(session.bbThreadId, [
        {
          kind: "extension.state",
          extensionKind: SESSION_OPTION_SELECTIONS_STATE_KIND,
          payload: { selections: { [AGENT_OPTION_ID]: agent } },
        },
      ]);
    }
    const options = withSelectedAgent(session.publishedAgentOptions, agent);
    if (!options) return;
    session.publishedAgentOptions = JSON.stringify(options);
    this.emit(session.bbThreadId, [
      {
        kind: "extension.state",
        extensionKind: SESSION_OPTIONS_STATE_KIND,
        payload: { options },
      },
    ]);
  }

  /** Fill an untitled BB thread with a title set in OpenCode. */
  private handleSessionRenamed(session: SessionState, data: RecordValue) {
    const title = stringValue(data.title);
    if (!title) return;
    const expected = session.expectedTitle;
    session.expectedTitle = undefined;
    if (expected === title) return;
    this.emit(session.bbThreadId, [
      { kind: "thread.name", name: title, source: "agent" },
    ]);
  }

  /**
   * `session.command` returns no message ID, so the first inbox message after
   * dispatch becomes the turn's checkpoint and input to wait on.
   */
  private adoptCommandCheckpoint(
    active: ActiveTurn,
    inboxId: string | undefined,
  ) {
    if (!inboxId || !active.awaitingCommandCheckpoint) return false;
    active.checkpointId = inboxId;
    (active.promptIds ??= new Set()).add(inboxId);
    active.awaitingCommandCheckpoint = false;
    return true;
  }

  private handleCompactionEvent(
    session: SessionState,
    active: ActiveTurn,
    type: unknown,
    data: RecordValue,
  ) {
    const eventType = stringValue(type);
    if (!eventType) return false;
    const message = inputRecord(data.message ?? data.info);
    const messageId = stringValue(
      data.messageID ?? data.messageId ?? data.id ?? message.id,
    );
    const reason = stringValue(data.reason ?? message.reason);
    const status = stringValue(data.status ?? message.status);
    const itemId = messageId ?? active.manualCompaction?.itemId;
    const isStarted =
      eventType === "session.next.compaction.started" ||
      eventType === "session.compaction.started" ||
      (eventType === "session.message.updated" &&
        status === "running" &&
        message.type === "compaction");
    const isCompleted =
      eventType === "session.next.compaction.ended" ||
      eventType === "session.compaction.ended" ||
      eventType === "session.compacted" ||
      (eventType === "session.message.updated" &&
        status === "completed" &&
        message.type === "compaction");
    const isFailed =
      eventType === "session.compaction.failed" ||
      (eventType === "session.message.updated" &&
        status === "failed" &&
        message.type === "compaction");
    if (!isStarted && !isCompleted && !isFailed) return false;

    if (isStarted) {
      if (itemId && !active.interaction.opened.has(itemId)) {
        const item = { type: "compaction" };
        active.interaction.opened.set(itemId, item);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(itemId, "compaction"),
            item,
            presentation: compactionPresentation,
            providerTurnId: active.interaction.providerTurnId,
          },
        ]);
      }
      return true;
    }

    const error =
      stringValue(
        data.error?.message ??
          data.error ??
          message.error?.message ??
          message.error,
      ) ?? "OpenCode context compaction failed";
    const manualCompaction = active.manualCompaction;
    const manual =
      manualCompaction !== undefined &&
      (itemId === manualCompaction.itemId ||
        reason === "manual" ||
        eventType === "session.compacted");
    if (manual && manualCompaction) {
      active.interaction.opened.delete(manualCompaction.itemId);
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.interaction.providerTurnId,
          messageId: manualCompaction.itemId,
          status: isCompleted ? "completed" : "failed",
          ...(isFailed ? { error } : {}),
        }),
      );
      active.interaction.openQuestions.clear();
      active.interaction.settledTools.clear();
      active.pendingTools.clear();
      active.pendingInput.clear();
      active.touchedFiles.clear();
      active.interaction.abortController.abort();
      session.active = undefined;
      return true;
    }

    if (itemId) {
      const item = active.interaction.opened.get(itemId);
      if (item) {
        active.interaction.opened.delete(itemId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.close",
            key: itemKey(itemId, "compaction"),
            status: isCompleted ? "completed" : "failed",
            item,
            presentation: compactionPresentation,
            providerTurnId: active.interaction.providerTurnId,
          },
        ]);
      }
    }
    if (isCompleted)
      this.emit(session.bbThreadId, [
        {
          kind: "context.compacted",
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
    return true;
  }

  /**
   * OpenCode v2 runs shell tools as background shells and only reports their
   * output when the tool finishes. Poll the shell's byte-cursor output API so
   * BB's command row streams like a local terminal.
   */
  private streamShellOutput(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    shellId: string,
  ) {
    active.shellPolls ??= new Map();
    if (active.shellPolls.has(callId)) return;
    const poll = { stopped: false };
    active.shellPolls.set(callId, poll);
    void (async () => {
      let cursor = 0;
      while (!poll.stopped && session.active === active) {
        try {
          const api = await this.api();
          const result = await api.shell.output(
            {
              id: shellId,
              location: { directory: session.cwd },
              cursor,
            },
            { signal: active.interaction.abortController.signal },
          );
          const output = inputRecord(result.data);
          if (
            !poll.stopped &&
            session.active === active &&
            typeof output.output === "string" &&
            output.output.length > 0
          ) {
            this.emit(session.bbThreadId, [
              {
                kind: "item.outputDelta",
                key: itemKey(callId, "tool"),
                channel: "command",
                text: boundedTimelineText(
                  output.output,
                  SHELL_OUTPUT_CHUNK_BYTES,
                ),
                providerTurnId: active.interaction.providerTurnId,
              },
            ]);
          }
          if (typeof output.cursor === "number") cursor = output.cursor;
        } catch {
          // The shell is gone (finished and cleaned up) or the turn ended.
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, SHELL_OUTPUT_POLL_MS),
        );
      }
    })();
  }

  private stopShellOutput(active: ActiveTurn, callId: string) {
    const poll = active.shellPolls?.get(callId);
    if (!poll) return;
    poll.stopped = true;
    active.shellPolls?.delete(callId);
  }

  private async readTurnFileChanges(session: SessionState, active: ActiveTurn) {
    const from = active.promptIds?.values().next().value;
    if (!from) return [];
    const api = await this.api();
    const entries = await api.session.diff(
      {
        sessionID: session.providerThreadId,
        from,
        context: TURN_DIFF_CONTEXT_LINES,
      },
      { signal: AbortSignal.timeout(TURN_DIFF_TIMEOUT_MS) },
    );
    return diffFileChanges(entries, session.cwd);
  }

  private async turnDiff(session: SessionState, active: ActiveTurn) {
    let changes: RecordValue[];
    try {
      changes = await this.readTurnFileChanges(session, active);
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not read the turn diff: ${errorMessage(error)}\n`,
      );
      return undefined;
    }
    const patches = changes
      .map((change) => stringValue(change.diff))
      .filter((patch): patch is string => Boolean(patch));
    if (!patches.length) return undefined;
    return patches
      .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
      .join("");
  }

  private emitFileChangeRow(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    changes: RecordValue[],
  ) {
    const item = { type: "fileChange", changes };
    this.emit(session.bbThreadId, [
      {
        kind: "item.open",
        key: itemKey(key, "fileChange"),
        item,
        providerTurnId: active.interaction.providerTurnId,
      },
      {
        kind: "item.close",
        key: itemKey(key, "fileChange"),
        status: "completed",
        item,
        providerTurnId: active.interaction.providerTurnId,
      },
    ]);
  }

  async finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ): Promise<void> {
    const active = session.active;
    if (!active || active.finishing) return;
    active.finishing = true;
    const context = active.interaction;
    context.abortController.abort();
    for (const child of this.childRecords(session))
      if (!child.backgroundTaskId) child.terminal = true;
    if (active.manualCompaction) {
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: context.providerTurnId,
          messageId: active.manualCompaction.itemId,
          status,
          ...(error ? { error } : {}),
        }),
      );
      session.active = undefined;
      return;
    }
    for (const poll of active.shellPolls?.values() ?? []) poll.stopped = true;
    active.shellPolls?.clear();
    dynamicToolCallRouter.resolve(
      session.dynamicToolScope,
      "OpenCode turn ended before the BB tool returned",
    );
    this.closeInteractionContext(
      session,
      context,
      status,
      context.providerTurnId,
    );
    context.settledTools.clear();
    active.pendingTools.clear();
    active.pendingInput.clear();
    active.touchedFiles.clear();
    const diff = await this.turnDiff(session, active);
    if (diff)
      this.emit(session.bbThreadId, [
        {
          kind: "turn.diff",
          diff,
          providerTurnId: context.providerTurnId,
        },
      ]);
    if (status === "failed") {
      this.emit(
        session.bbThreadId,
        providerFailureDeltas({
          providerTurnId: context.providerTurnId,
          error: error ?? "OpenCode execution failed",
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
        }),
      );
    } else {
      this.emit(session.bbThreadId, [
        {
          kind: "turn.boundary",
          status,
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
          providerTurnId: context.providerTurnId,
        },
      ]);
    }
    session.active = undefined;
  }
}
