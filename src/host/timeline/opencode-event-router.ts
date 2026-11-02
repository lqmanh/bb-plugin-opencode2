import { experimental_COMPACTION_PRESENTATION as compactionPresentation } from "@get-bb/plugin-sdk/provider-bridge";
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
import { errorMessage } from "../../shared/errors.ts";
import {
  contentText,
  diffFileChanges,
  dynamicToolRow,
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./tool-mapping.ts";
import {
  ARCHIVED_SESSION_MESSAGE,
  DELETED_SESSION_MESSAGE,
  MOVED_SESSION_MESSAGE,
  inputRecord,
  parseInputText,
  stringValue,
  type ActiveTurn,
  type ChildSessionRecord,
  type OpenCodeApi,
  type OpenCodeRecord,
  type SessionState,
  type UsageTotals,
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

function tokenCount(value: unknown) {
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

function totalTokens(totals: UsageTotals) {
  return (
    totals.input +
    totals.output +
    totals.reasoning +
    totals.cacheRead +
    totals.cacheWrite
  );
}

function breakdownFromTotals(totals: UsageTotals) {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    reasoningOutputTokens: totals.reasoning,
    cachedInputTokens: totals.cacheRead,
    totalTokens: totalTokens(totals),
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
      ? totalTokens(last)
      : null
    : (session.lastUsage?.used ?? null);
  const totalCost =
    session.usageCost === undefined
      ? child.cost
      : session.usageCost + (child.cost ?? 0);
  // BB applies a usage delta without providerTurnId to the current or last
  // turn, so late child usage does not need a synthetic turn ID.
  const providerTurnId = active?.providerTurnId;
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
    session.lastUsage = { tokens: last, used: totalTokens(last) };
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

  clearChildSessions(parentProviderThreadId?: string): void {
    if (parentProviderThreadId === undefined) {
      this.childSessions.clear();
      this.childIdsByParent.clear();
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
    const form =
      event.type === "form.created" ? inputRecord(data.form) : undefined;
    const sessionId =
      stringValue(data.sessionID) ??
      (form ? stringValue(form.sessionID) : undefined);
    if (!sessionId) return;
    const session = this.sessionLookup.get(sessionId);
    if (event.type === "form.created") {
      if (session?.active)
        this.interactions.handleCreatedForm(session, form ?? {});
      return;
    }
    if (event.type === "permission.replied") {
      if (session) this.interactions.handlePermissionReplied(session, data);
      return;
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      if (session) this.interactions.handleFormEvent(session, event.type, data);
      return;
    }
    if (session) return this.handleSessionEvent(session, event, data);
    const child = this.childSessions.get(sessionId);
    if (!child) return;
    const type = stringValue(event.type) ?? "";
    if (type === "session.usage.updated") {
      this.handleChildUsage(child, data);
      return;
    }
    if (child.terminal || !CHILD_EVENT_PATTERN.test(type)) return;
    const parent = this.parentForChild(child);
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
    if (
      childId &&
      (eventType === "session.tool.progress" ||
        eventType === "session.tool.success" ||
        eventType === "session.tool.failed")
    ) {
      const live = active !== undefined;
      this.registerChildSession(childId, session, eventId, {
        terminal:
          !live ||
          eventType === "session.tool.failed" ||
          (eventType === "session.tool.success" &&
            stringValue(metadata.status) !== "running"),
        updateCallId: live && eventType === "session.tool.progress",
      });
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
      active.opened.set(textPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(textPartId, "agentMessage"),
          item,
          providerTurnId: active.providerTurnId,
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
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.ended" &&
      textPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(textPartId) ?? {
        type: "agentMessage",
        text: data.text,
      };
      item.text = data.text;
      active.opened.delete(textPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(textPartId, "agentMessage"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    const reasoningPartId =
      assistantMessageId && ordinal !== undefined
        ? `reasoning:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.reasoning.started" && reasoningPartId) {
      const item = { type: "reasoning", summary: [], content: [] };
      active.opened.set(reasoningPartId, item);
      this.emit(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(reasoningPartId, "reasoningText"),
          item,
          providerTurnId: active.providerTurnId,
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
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.ended" &&
      reasoningPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(reasoningPartId) ?? {
        type: "reasoning",
        summary: [],
        content: [],
      };
      item.content = [data.text];
      active.opened.delete(reasoningPartId);
      this.emit(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(reasoningPartId, "reasoningText"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
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
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        active.opened.set(eventId, row.item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item: row.item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
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
      } else {
        const item = active.opened.get(eventId);
        if (item) item.args = data.input;
      }
    }
    if (event.type === "session.tool.progress") {
      const opened = active.opened.get(eventId);
      if (childId && opened?.type === "delegation") opened.childRef = childId;
      const shellId = stringValue(metadata.shellID);
      if (shellId && opened?.type === "command")
        this.streamShellOutput(session, active, eventId, shellId);
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
      if (active.settledTools.has(eventId)) {
        active.settledTools.delete(eventId);
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
      let item = active.opened.get(eventId);
      if (!item) {
        const row = sessionToolRow(session, name, input);
        if (row.item.type === "delegation")
          (row.item as RecordValue).childRef = eventId;
        item = row.item;
        active.opened.set(eventId, item);
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
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      const output = contentText(data.content);
      if (item.type === "delegation") {
        item.summary =
          event.type === "session.tool.success"
            ? subagentSummary(output)
            : toolFailureError(
                name,
                session.disableSubagents,
                stringValue(inputRecord(data.error).message),
              );
        if (!item.summary) delete item.summary;
        if (childId) item.childRef = childId;
      } else if (item.type === "tool") {
        if (event.type === "session.tool.success") item.result = output;
        else {
          const error = inputRecord(data.error);
          item.error = toolFailureError(
            name,
            session.disableSubagents,
            stringValue(error.message),
          );
        }
      } else if (item.type === "command") {
        const error = inputRecord(data.error);
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
      active.opened.delete(eventId);
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
          providerTurnId: active.providerTurnId,
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
          providerTurnId: active.providerTurnId,
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
    this.clearChildSessions(session.providerThreadId);
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
      if (itemId && !active.opened.has(itemId)) {
        const item = { type: "compaction" };
        active.opened.set(itemId, item);
        this.emit(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(itemId, "compaction"),
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
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
      active.opened.delete(manualCompaction.itemId);
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: manualCompaction.itemId,
          status: isCompleted ? "completed" : "failed",
          ...(isFailed ? { error } : {}),
        }),
      );
      active.openQuestions.clear();
      active.settledTools.clear();
      active.pendingTools.clear();
      active.pendingInput.clear();
      active.touchedFiles.clear();
      active.abortController.abort();
      session.active = undefined;
      return true;
    }

    if (itemId) {
      const item = active.opened.get(itemId);
      if (item) {
        active.opened.delete(itemId);
        this.emit(session.bbThreadId, [
          {
            kind: "item.close",
            key: itemKey(itemId, "compaction"),
            status: isCompleted ? "completed" : "failed",
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
    }
    if (isCompleted)
      this.emit(session.bbThreadId, [
        { kind: "context.compacted", providerTurnId: active.providerTurnId },
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
            { signal: active.abortController.signal },
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
                providerTurnId: active.providerTurnId,
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
        providerTurnId: active.providerTurnId,
      },
      {
        kind: "item.close",
        key: itemKey(key, "fileChange"),
        status: "completed",
        item,
        providerTurnId: active.providerTurnId,
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
    active.abortController.abort();
    for (const child of this.childRecords(session)) child.terminal = true;
    if (active.manualCompaction) {
      this.emit(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
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
    for (const [, formId] of active.openQuestions)
      void this.interactions.cancelQuestionForm(session, active, formId);
    this.interactions.cancelQuestionWaiters(active);
    for (const [id, item] of active.opened) {
      this.emit(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKeyForOpenItem(id, item),
          status,
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    for (const id of active.opened.keys()) this.parentRefs.delete(id);
    active.opened.clear();
    active.openQuestions.clear();
    active.settledTools.clear();
    active.pendingTools.clear();
    active.pendingInput.clear();
    active.touchedFiles.clear();
    const diff = await this.turnDiff(session, active);
    if (diff)
      this.emit(session.bbThreadId, [
        {
          kind: "turn.diff",
          diff,
          providerTurnId: active.providerTurnId,
        },
      ]);
    if (status === "failed") {
      this.emit(
        session.bbThreadId,
        providerFailureDeltas({
          providerTurnId: active.providerTurnId,
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
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    session.active = undefined;
  }
}
