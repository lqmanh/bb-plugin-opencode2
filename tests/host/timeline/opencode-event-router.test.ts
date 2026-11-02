import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeClient } from "@opencode/client";
import {
  mergeChildUsage,
  OpenCodeEventRouter,
  createActiveTurn,
  usageTotals,
} from "../../support/host-api.js";
import type {
  ActiveTurn,
  ChildSessionRecord,
  OpenCodeRecord,
  SessionState,
} from "../../../src/host/types.ts";

const emptyApi = async () =>
  ({ session: { diff: async () => [] } }) as unknown as OpenCodeClient;

function mcpApi(remove: (input: OpenCodeRecord) => Promise<void>) {
  return async () =>
    ({
      session: { diff: async () => [] },
      experimental: { mcp: { remove } },
    }) as unknown as OpenCodeClient;
}

test("translates current OpenCode v2 text, reasoning, tool, and terminal events", async () => {
  const { emitted, event, session } = sessionFixture(emptyApi, undefined, {
    session: {
      providerThreadId: "oc-session",
      cwd: process.cwd(),
      disableSubagents: false,
      contextWindow: 1000,
    },
  });

  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
  });
  await event("session.text.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Hello",
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Hello",
  });
  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
    text: "Again",
  });
  await event("session.reasoning.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    state: {},
  });
  await event("session.reasoning.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Think",
  });
  await event("session.reasoning.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Think",
    state: {},
  });
  await event("session.tool.input.started", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    name: "bash",
  });
  await event("session.tool.input.ended", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    text: JSON.stringify({ command: "printf ok" }),
  });
  await event("session.tool.called", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    input: { command: "printf ok" },
    executed: true,
    state: {},
  });
  await event("session.tool.success", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    content: [{ type: "text", text: "ok" }],
    metadata: {},
  });
  await event("session.step.ended", {
    assistantMessageID: "msg-assistant",
    finish: "stop",
    tokens: {
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 4, write: 5 },
    },
  });
  // OpenCode follows each step with the session's cumulative totals.
  await event("session.usage.updated", {
    cost: 1.25,
    tokens: {
      input: 30,
      output: 20,
      reasoning: 10,
      cache: { read: 40, write: 50 },
    },
  });
  await event("session.execution.succeeded", {});

  const openedKeys = emitted
    .filter((delta) => delta.kind === "item.open")
    .map((delta) => delta.key as { providerItemId: string; channel: string });
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:0" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:1" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "reasoning:msg-assistant:0" &&
        key.channel === "reasoningText",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) => key.providerItemId === "tool-1" && key.channel === "tool",
    ),
  );
  assert.equal(
    new Set(openedKeys.map((key) => JSON.stringify(key))).size,
    openedKeys.length,
  );

  const usage = emitted.find((delta) => delta.kind === "usage");
  assert.equal(usage?.last.totalTokens, 15);
  assert.equal(usage?.total.totalTokens, 150);
  assert.equal(usage?.modelContextWindow, 1000);
  const context = emitted.find((delta) => delta.kind === "contextWindow");
  assert.equal(context?.used, 15);
  assert.equal(context?.size, 1000);
  assert.deepEqual(context?.cost, { amount: 1.25, currency: "USD" });
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.kind, "turn.boundary");
  assert.equal(emitted.at(-1)?.status, "completed");
});

test("nests a native subagent's work under its delegation row", async () => {
  const { active, emitted, event, router, session } = sessionFixture(
    emptyApi,
    undefined,
    {
      session: {
        providerThreadId: "ses_parent",
        cwd: process.cwd(),
        disableSubagents: false,
      },
    },
  );

  await registerChild(event, "call_sub", "ses_child");
  await event("session.tool.input.started", {
    sessionID: "ses_child",
    id: "call_child",
    name: "read",
  });
  await event("session.tool.called", {
    sessionID: "ses_child",
    id: "call_child",
    input: { path: "package.json" },
  });
  await event("session.tool.success", {
    sessionID: "ses_child",
    id: "call_child",
    content: [{ type: "text", text: "{}" }],
  });
  // The child's own lifecycle must not settle the parent turn.
  await event("session.execution.succeeded", { sessionID: "ses_child" });
  assert.equal(session.active, active);
  await event("session.tool.success", {
    id: "call_sub",
    content: [
      {
        type: "text",
        text: '<subagent sessionID="ses_child" state="completed">\nOne file.\n</subagent>',
      },
    ],
    metadata: { sessionID: "ses_child", status: "completed" },
  });

  const delegationOpen = emitted.find(
    (delta) => delta.kind === "item.open" && delta.item.type === "delegation",
  );
  assert.equal(delegationOpen?.item.label, "explore: List files");
  assert.equal(delegationOpen?.key.parentRef, undefined);
  const childRows = emitted.filter(
    (delta) => delta.key?.providerItemId === "call_child",
  );
  assert.equal(childRows.length, 2);
  for (const delta of childRows) assert.equal(delta.key.parentRef, "call_sub");
  const delegationClose = emitted.find(
    (delta) => delta.kind === "item.close" && delta.item.type === "delegation",
  );
  assert.equal(delegationClose?.status, "completed");
  assert.equal(delegationClose?.item.childRef, "ses_child");
  assert.equal(delegationClose?.item.summary, "One file.");

  // Child events after the delegation's turn ended are dropped.
  await router.finish(session, "completed");
  const count = emitted.length;
  await event("session.text.started", {
    sessionID: "ses_child",
    assistantMessageID: "m",
    ordinal: 0,
  });
  assert.equal(emitted.length, count);
});

function usagePayload(
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
) {
  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

async function registerChild(
  event: (type: string, data?: OpenCodeRecord) => Promise<void>,
  callId = "call_sub",
  childId = "ses_child",
) {
  await event("session.tool.input.started", { id: callId, name: "subagent" });
  await event("session.tool.called", {
    id: callId,
    input: { agent: "explore", description: "List files", prompt: "ls" },
  });
  await event("session.tool.progress", {
    id: callId,
    metadata: { sessionID: childId, status: "running" },
  });
}

function latestUsage(emitted: OpenCodeRecord[]) {
  return emitted.filter((delta) => delta.kind === "usage").at(-1);
}

function latestContext(emitted: OpenCodeRecord[]) {
  return emitted.filter((delta) => delta.kind === "contextWindow").at(-1);
}

test("adds child usage to total and cost without changing parent last or context", async () => {
  const { emitted, event, session } = sessionFixture(emptyApi, undefined, {
    session: {
      providerThreadId: "ses_parent",
      contextWindow: 1000,
      disableSubagents: false,
    },
  });

  await event("session.step.ended", {
    tokens: usagePayload(3, 2, 1, 4, 5),
  });
  await event("session.usage.updated", {
    cost: 1.25,
    tokens: usagePayload(30, 20, 10, 40, 50),
  });
  await registerChild(event);
  await event("session.usage.updated", {
    sessionID: "ses_child",
    cost: 0.75,
    tokens: usagePayload(5, 6, 7, 8, 9),
  });

  const usage = latestUsage(emitted);
  assert.deepEqual(usage?.total, {
    inputTokens: 35,
    outputTokens: 26,
    reasoningOutputTokens: 17,
    cachedInputTokens: 48,
    totalTokens: 185,
  });
  assert.equal(usage?.last.totalTokens, 15);
  assert.equal(usage?.modelContextWindow, 1000);

  const context = latestContext(emitted);
  assert.equal(context?.used, 15);
  assert.equal(context?.size, 1000);
  assert.deepEqual(context?.cost, { amount: 2, currency: "USD" });
  assert.deepEqual(session.usage, {
    input: 30,
    output: 20,
    reasoning: 10,
    cacheRead: 40,
    cacheWrite: 50,
  });
  assert.equal(session.usageCost, 1.25);
});

test("aggregates multiple and nested child sessions exactly once", async () => {
  const { emitted, event, session } = sessionFixture(emptyApi, undefined, {
    session: {
      providerThreadId: "ses_parent",
      contextWindow: 1000,
      disableSubagents: false,
    },
  });

  await registerChild(event, "call_sub", "ses_child");
  await event("session.tool.input.started", {
    sessionID: "ses_child",
    id: "call_grand",
    name: "subagent",
  });
  await event("session.tool.called", {
    sessionID: "ses_child",
    id: "call_grand",
    input: { agent: "explore", description: "Nested", prompt: "pwd" },
  });
  await event("session.tool.progress", {
    sessionID: "ses_child",
    id: "call_grand",
    metadata: { sessionID: "ses_grand", status: "running" },
  });
  // A child discovered only from terminal tool metadata.
  await event("session.tool.success", {
    id: "call_second",
    name: "subagent",
    content: [
      {
        type: "text",
        text: '<subagent sessionID="ses_child2" state="completed">done</subagent>',
      },
    ],
    metadata: { sessionID: "ses_child2", status: "completed" },
  });

  await event("session.usage.updated", {
    sessionID: "ses_child",
    cost: 0.2,
    tokens: usagePayload(1, 2, 3, 4, 5),
  });
  await event("session.usage.updated", {
    sessionID: "ses_grand",
    cost: 0.3,
    tokens: usagePayload(2, 3, 4, 5, 6),
  });
  await event("session.usage.updated", {
    sessionID: "ses_child2",
    cost: 0.4,
    tokens: usagePayload(3, 4, 5, 6, 7),
  });
  await event("session.step.ended", {
    tokens: usagePayload(1, 1, 1, 1, 1),
  });
  await event("session.usage.updated", {
    cost: 1,
    tokens: usagePayload(10, 0, 0, 0, 0),
  });

  const usage = latestUsage(emitted);
  assert.deepEqual(usage?.total, {
    inputTokens: 16,
    outputTokens: 9,
    reasoningOutputTokens: 12,
    cachedInputTokens: 15,
    totalTokens: 70,
  });
  const context = latestContext(emitted);
  assert.deepEqual(context?.cost, { amount: 1.9, currency: "USD" });
  assert.deepEqual(session.usage, {
    input: 10,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("replayed child usage is idempotent", async () => {
  const { emitted, event } = sessionFixture(emptyApi, undefined, {
    session: { providerThreadId: "ses_parent", disableSubagents: false },
  });
  await registerChild(event);
  await event("session.step.ended", {
    tokens: usagePayload(1, 1, 1, 1, 1),
  });
  await event("session.usage.updated", {
    cost: 0.5,
    tokens: usagePayload(10, 0, 0, 0, 0),
  });
  const replay = {
    sessionID: "ses_child",
    cost: 0.25,
    tokens: usagePayload(4, 1, 2, 3, 5),
  };
  await event("session.usage.updated", replay);
  await event("session.usage.updated", replay);

  const usage = latestUsage(emitted);
  assert.deepEqual(usage?.total, {
    inputTokens: 14,
    outputTokens: 1,
    reasoningOutputTokens: 2,
    cachedInputTokens: 3,
    totalTokens: 25,
  });
  assert.deepEqual(latestContext(emitted)?.cost, {
    amount: 0.75,
    currency: "USD",
  });
});

test("keeps late child usage after the parent turn finishes", async () => {
  const { emitted, event, router, session } = sessionFixture(
    emptyApi,
    undefined,
    {
      session: {
        providerThreadId: "ses_parent",
        contextWindow: 1000,
        disableSubagents: false,
      },
    },
  );

  await event("session.step.ended", {
    tokens: usagePayload(3, 2, 1, 4, 5),
  });
  await event("session.usage.updated", {
    cost: 1.25,
    tokens: usagePayload(30, 20, 10, 40, 50),
  });
  await registerChild(event);
  await router.finish(session, "completed");
  await event("session.usage.updated", {
    sessionID: "ses_child",
    cost: 0.75,
    tokens: usagePayload(5, 6, 7, 8, 9),
  });

  const usage = latestUsage(emitted);
  assert.equal(usage?.total.totalTokens, 185);
  assert.equal(usage?.last.totalTokens, 15);
  assert.equal("providerTurnId" in usage, false);
  const context = latestContext(emitted);
  assert.equal(context?.used, 15);
  assert.deepEqual(context?.cost, { amount: 2, currency: "USD" });
  assert.equal(session.active, undefined);
});

test("drops child usage after the parent session detaches", async () => {
  const { emitted, event, router, session } = sessionFixture(
    emptyApi,
    undefined,
    {
      session: { providerThreadId: "ses_parent", disableSubagents: false },
    },
  );
  await registerChild(event);
  await router.handleEvent({
    type: "session.deleted",
    data: { sessionID: session.providerThreadId },
  });
  const usageCount = emitted.filter((delta) => delta.kind === "usage").length;
  await event("session.usage.updated", {
    sessionID: "ses_child",
    cost: 0.5,
    tokens: usagePayload(5, 5, 5, 5, 5),
  });
  assert.equal(
    emitted.filter((delta) => delta.kind === "usage").length,
    usageCount,
  );
});

test("reconciles child usage monotonically after reconnect", async () => {
  const now = Date.now();
  let childCost = 0.5;
  let childTokens = usagePayload(5, 5, 5, 5, 5);
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        list: async ({ parentID }: { parentID: string }) => ({
          data:
            parentID === "ses_parent"
              ? [
                  {
                    id: "ses_child",
                    parentID,
                    cost: childCost,
                    tokens: childTokens,
                    outcome: "succeeded",
                    time: { updated: now },
                  },
                ]
              : parentID === "ses_child"
                ? [
                    {
                      id: "ses_grand",
                      parentID,
                      cost: 0.25,
                      tokens: usagePayload(2, 2, 2, 2, 2),
                      outcome: "succeeded",
                      time: { updated: now },
                    },
                  ]
                : [],
          cursor: {},
        }),
      },
    }) as unknown as OpenCodeClient;
  const { emitted, event, router, session } = sessionFixture(api, undefined, {
    session: {
      providerThreadId: "ses_parent",
      contextWindow: 1000,
      disableSubagents: false,
    },
  });

  await event("session.step.ended", {
    tokens: usagePayload(1, 1, 1, 1, 1),
  });
  await event("session.usage.updated", {
    cost: 1,
    tokens: usagePayload(10, 0, 0, 0, 0),
  });
  await router.reconcileChildSessions(session);
  await router.reconcileChildSessions(session);
  // A stale hydration must not lower the already observed totals.
  childCost = 0.1;
  childTokens = usagePayload(1, 1, 1, 1, 1);
  await router.reconcileChildSessions(session);
  await event("session.usage.updated", {
    cost: 1,
    tokens: usagePayload(10, 0, 0, 0, 0),
  });

  const usage = latestUsage(emitted);
  assert.deepEqual(usage?.total, {
    inputTokens: 17,
    outputTokens: 7,
    reasoningOutputTokens: 7,
    cachedInputTokens: 7,
    totalTokens: 45,
  });
  assert.deepEqual(latestContext(emitted)?.cost, {
    amount: 1.75,
    currency: "USD",
  });
});

test("merges child usage monotonically and normalizes malformed tokens", () => {
  const record: ChildSessionRecord = {
    parentThreadId: "bb-thread",
    parentProviderThreadId: "ses_parent",
    callId: "call_sub",
    terminal: false,
  };
  assert.equal(
    mergeChildUsage(record, usageTotals(usagePayload(5, 6, 7, 8, 9)), 0.75),
    true,
  );
  assert.equal(
    mergeChildUsage(record, usageTotals(usagePayload(3, 4, 5, 6, 7)), 0.5),
    false,
  );
  assert.deepEqual(record.usage, {
    tokens: { input: 5, output: 6, reasoning: 7, cacheRead: 8, cacheWrite: 9 },
    cost: 0.75,
  });
  assert.deepEqual(usageTotals({ input: -1, output: Number.NaN }), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

function sessionFixture(
  api: () => Promise<OpenCodeClient>,
  hooks?: NonNullable<ConstructorParameters<typeof OpenCodeEventRouter>[3]>,
  overrides: {
    active?: Partial<ActiveTurn> | null;
    session?: Partial<SessionState>;
  } = {},
) {
  const emitted: OpenCodeRecord[] = [];
  const active: ActiveTurn = {
    ...createActiveTurn("turn-1"),
    promptIds: new Set(["msg_user"]),
    inputDelivered: true,
    ...(overrides.active ?? {}),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active: overrides.active === null ? undefined : active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides.session,
  };
  const lookup = new Map([[session.providerThreadId, session]]);
  const router = new OpenCodeEventRouter(
    api,
    (_threadId, deltas) => emitted.push(...deltas),
    lookup,
    hooks,
  );
  const event = (type: string, data: OpenCodeRecord = {}) =>
    router.handleEvent({
      type,
      data: { sessionID: session.providerThreadId, ...data },
    });
  return { active, emitted, event, lookup, router, session };
}

function sessionWithTurnDiff(
  files: OpenCodeRecord[],
  onDiff?: (input: OpenCodeRecord) => void,
) {
  return sessionFixture(
    async () =>
      ({
        session: {
          diff: async (input: OpenCodeRecord) => {
            onDiff?.(input);
            return files;
          },
        },
      }) as unknown as OpenCodeClient,
  );
}

test("emits the session diff as turn.diff before the boundary", async () => {
  const patch = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-two\n+TWO\n";
  let input: OpenCodeRecord | undefined;
  const { emitted, event } = sessionWithTurnDiff(
    [
      {
        file: "a.txt",
        patch,
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ],
    (value) => {
      input = value;
    },
  );
  await event("session.execution.succeeded", {});
  assert.deepEqual(input, {
    sessionID: "ses_1",
    from: "msg_user",
    context: 3,
  });
  const kinds = emitted.map((delta) => delta.kind);
  const diffIndex = kinds.indexOf("turn.diff");
  assert.ok(diffIndex >= 0 && diffIndex < kinds.indexOf("turn.boundary"));
  assert.equal(emitted[diffIndex].diff, patch);
});

test("emits write rows without patches and reads the turn diff once", async () => {
  const patch = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-two\n+TWO\n";
  let diffCalls = 0;
  const { emitted, event } = sessionWithTurnDiff(
    [
      {
        file: "a.txt",
        patch,
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ],
    () => {
      diffCalls += 1;
    },
  );
  for (const [id, filePath] of [
    ["call_a", "a.txt"],
    ["call_b", "notes.txt"],
  ] as const) {
    await event("session.tool.input.started", { id, name: "write" });
    await event("session.tool.called", { id, input: { filePath } });
    await event("session.tool.success", {
      id,
      content: [{ type: "text", text: "Wrote file" }],
      metadata: {},
    });
  }
  assert.equal(diffCalls, 0);

  await event("session.execution.succeeded", {});
  assert.equal(diffCalls, 1);
  const changes = emitted
    .filter(
      (delta) =>
        delta.kind === "item.open" && delta.key?.channel === "fileChange",
    )
    .map((delta) => delta.item.changes[0]);
  assert.deepEqual(
    changes.map((change) => [change.path, change.diff]),
    [
      ["a.txt", undefined],
      ["notes.txt", undefined],
    ],
  );
  const turnDiff = emitted.find((delta) => delta.kind === "turn.diff");
  assert.equal(turnDiff?.diff, patch);
});

test("keeps the boundary when the session diff is empty", async () => {
  const { emitted, event } = sessionWithTurnDiff([]);
  await event("session.execution.succeeded", {});
  const kinds = emitted.map((delta) => delta.kind);
  assert.equal(kinds.includes("turn.diff"), false);
  assert.equal(kinds.includes("turn.boundary"), true);
});

test("routes form.created to the question tool without polling", async () => {
  const cancelled: OpenCodeRecord[] = [];
  let listCalls = 0;
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        form: {
          list: async () => {
            listCalls += 1;
            return [];
          },
          cancel: async (input: OpenCodeRecord) => {
            cancelled.push(input);
          },
        },
      },
    }) as unknown as OpenCodeClient;
  const { emitted, event, session, router } = sessionFixture(api, {
    requestInteraction: async () => ({}),
  });

  await event("session.tool.input.started", { id: "call_q", name: "question" });
  await event("session.tool.called", {
    id: "call_q",
    input: { questions: [{ question: "Pick", options: [] }] },
  });
  await event("form.created", {
    form: {
      id: "form_1",
      sessionID: "ses_1",
      title: "Pick",
      metadata: { tool: { id: "call_q" } },
      fields: [{ key: "q", title: "Pick", type: "string" }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await router.finish(session, "completed");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(listCalls, 0);
  assert.deepEqual(cancelled, [{ sessionID: "ses_1", formID: "form_1" }]);
  assert.ok(
    emitted.some(
      (delta) =>
        delta.kind === "item.close" && delta.key?.providerItemId === "call_q",
    ),
  );
});

test("ignores terminal events from earlier work until the turn's prompt is delivered", async () => {
  const { active, emitted, event, session } = sessionFixture(
    emptyApi,
    undefined,
    {
      active: {
        providerTurnId: "turn-2",
        promptIds: new Set(["msg_prompt"]),
        inputDelivered: false,
      },
    },
  );
  // A compaction from the previous turn finishes after this turn opened.
  await event("session.execution.succeeded");
  assert.equal(session.active, active);
  await event("session.inbox.delivered", { inboxID: "msg_other" });
  await event("session.execution.succeeded");
  assert.equal(session.active, active);
  await event("session.inbox.delivered", { inboxID: "msg_prompt" });
  await event("session.execution.succeeded");
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.kind, "turn.boundary");
});

test("shows a Code Mode execute as one code row without nested rows", async () => {
  const { emitted, event: send } = sessionFixture(emptyApi);
  const event = (type: string, data: OpenCodeRecord) =>
    send(type, { id: "call_exec", ...data });
  // Shapes recorded from OpenCode 2.0.27 with a Code Mode MCP server.
  const code =
    'const a = await tools.cm_echo.shout({text: "hello"});\nreturn a;';
  const call = { tool: "cm_echo.shout", input: { text: "hello" } };
  await event("session.tool.input.started", { name: "execute" });
  await event("session.tool.called", { input: { code } });
  await event("session.tool.progress", {
    metadata: { toolCalls: [{ ...call, status: "running" }] },
  });
  await event("session.tool.success", {
    content: [{ type: "text", text: '"HELLO"' }],
    metadata: { toolCalls: [{ ...call, status: "completed" }] },
  });
  // BB renders any item with a parentRef as a subagent's work.
  assert.equal(emitted.filter((delta) => delta.key?.parentRef).length, 0);
  assert.deepEqual(
    emitted.map((delta) => [delta.kind, delta.key.providerItemId]),
    [
      ["item.open", "call_exec"],
      ["item.close", "call_exec"],
    ],
  );
  assert.equal(emitted[0].presentation.label.completed, "Ran code");
  assert.equal(emitted[0].presentation.title, "cm_echo.shout");
});

test("a failed permission reply never escapes as an unhandled rejection", async () => {
  let replied = false;
  const api = async () => {
    return {
      permission: {
        reply: async () => {
          replied = true;
          throw {
            _tag: "PermissionNotFoundError",
            message: "Permission request not found",
          };
        },
      },
    } as unknown as OpenCodeClient;
  };
  const { event } = sessionFixture(api, undefined, {
    session: { permissionMode: "full" },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await event("permission.asked", { id: "per_1", action: "shell" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = stderrWrite;
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(replied, true);
  assert.deepEqual(unhandled, []);
});

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("adopts a command's inbox message as the turn checkpoint", async () => {
  const { active, emitted, event, session } = sessionFixture(
    emptyApi,
    undefined,
    {
      active: {
        providerTurnId: "turn-cmd",
        promptIds: new Set(),
        inputDelivered: false,
        awaitingCommandCheckpoint: true,
      },
    },
  );

  // The turn cannot end before its command input is known.
  await event("session.execution.succeeded");
  assert.equal(session.active, active);

  await event("session.inbox.enqueued", { inboxID: "msg_cmd" });
  assert.equal(active.checkpointId, "msg_cmd");
  assert.equal(active.promptIds?.has("msg_cmd"), true);
  await event("session.inbox.delivered", { inboxID: "msg_cmd" });
  await event("session.execution.succeeded");
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.providerCheckpointId, "msg_cmd");
});

test("fails a turn and reports a deleted OpenCode session", async () => {
  const notifications: OpenCodeRecord[] = [];
  const { emitted, lookup, router, session } = sessionFixture(emptyApi, {
    notify: (method, params) => notifications.push({ method, params }),
  });

  await router.handleEvent({
    type: "session.deleted",
    data: { sessionID: session.providerThreadId },
  });

  assert.equal(session.active, undefined);
  assert.equal(lookup.has(session.providerThreadId), false);
  assert.ok(emitted.some((delta) => delta.kind === "provider.error"));
  assert.equal(notifications[0]?.method, "provider/recovery");
  assert.equal(notifications[0]?.params.kind, "restartRecommended");
  assert.match(session.terminalError ?? "", /deleted/);
});

test("removes dynamic tools before detaching a deleted session", async () => {
  const events: string[] = [];
  const removed: OpenCodeRecord[] = [];
  const api = mcpApi(async (input) => {
    events.push("remove");
    removed.push(input);
  });
  const { event, lookup, session } = sessionFixture(api, {
    onSessionGone: async () => {
      events.push("gone");
    },
  });
  session.active?.abortController.signal.addEventListener("abort", () =>
    events.push("abort"),
  );
  session.dynamicToolProxy = {
    serverName: "bb_opencode2_ses_1",
    config: {} as never,
    close: () => events.push("close"),
  };

  await event("session.deleted", {});

  // The active turn finishes first, then teardown runs before onSessionGone.
  assert.deepEqual(events, ["abort", "close", "remove", "gone"]);
  assert.deepEqual(removed, [
    { server: "bb_opencode2_ses_1", location: { directory: "/repo" } },
  ]);
  assert.equal(lookup.has(session.providerThreadId), false);
});

test("detaches a deleted session even when MCP removal fails", async () => {
  const events: string[] = [];
  const api = mcpApi(async () => {
    events.push("remove");
    throw new Error("server is gone");
  });
  const { event, lookup, session } = sessionFixture(api, {
    onSessionGone: async () => {
      events.push("gone");
    },
  });
  session.dynamicToolProxy = {
    serverName: "bb_opencode2_ses_1",
    config: {} as never,
    close: () => events.push("close"),
  };

  await event("session.deleted", {});

  assert.deepEqual(events, ["close", "remove", "gone"]);
  assert.equal(session.dynamicToolProxy, undefined);
  assert.equal(lookup.has(session.providerThreadId), false);
});

test("reports an external archive and clears it on unarchive", async () => {
  const notifications: OpenCodeRecord[] = [];
  const { router, session } = sessionFixture(
    emptyApi,
    { notify: (method, params) => notifications.push({ method, params }) },
    { active: null },
  );

  await router.handleEvent({
    type: "session.archived",
    data: { sessionID: session.providerThreadId },
  });
  assert.match(session.terminalError ?? "", /archived/);
  assert.equal(session.terminalKind, "archived");
  assert.equal(notifications[0]?.params.kind, "sessionArchived");

  await router.handleEvent({
    type: "session.unarchived",
    data: { sessionID: session.providerThreadId },
  });
  assert.equal(session.terminalError, undefined);
  assert.equal(session.terminalKind, undefined);
});

test("answers a general form through BB's question UI", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        form: {
          reply: async (input: OpenCodeRecord) => {
            replies.push(input);
          },
          cancel: async () => {},
        },
      },
    }) as unknown as OpenCodeClient;
  const { emitted, event } = sessionFixture(api, {
    requestInteraction: async () => ({
      resolution: {
        kind: "user_answer",
        answers: {
          name: { selected: [], freeText: "Ada" },
          count: { selected: [], freeText: "3" },
          active: { selected: ["true"] },
          tags: { selected: ["a"], freeText: "b" },
        },
      },
    }),
  });

  await event("form.created", {
    form: {
      id: "frm_1",
      sessionID: "ses_1",
      fields: [
        { key: "name", title: "Name", type: "string", required: true },
        { key: "count", title: "Count", type: "integer", minimum: 1 },
        { key: "active", title: "Active", type: "boolean" },
        {
          key: "tags",
          title: "Tags",
          type: "multiselect",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          custom: true,
        },
      ],
    },
  });
  await nextTick();

  assert.deepEqual(replies, [
    {
      sessionID: "ses_1",
      formID: "frm_1",
      answer: { name: "Ada", count: 3, active: true, tags: ["a", "b"] },
    },
  ]);
  const open = emitted.find(
    (delta) =>
      delta.kind === "item.open" && delta.key?.providerItemId === "form:frm_1",
  );
  assert.equal(open?.item.tool, "question");
  const close = emitted.find(
    (delta) =>
      delta.kind === "item.close" && delta.key?.providerItemId === "form:frm_1",
  );
  assert.equal(close?.status, "completed");
});

test("cancels a form BB cannot represent with a visible reason", async () => {
  const cancelled: OpenCodeRecord[] = [];
  let requested = false;
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        form: {
          reply: async () => {},
          cancel: async (input: OpenCodeRecord) => {
            cancelled.push(input);
          },
        },
      },
    }) as unknown as OpenCodeClient;
  const { emitted, event } = sessionFixture(api, {
    requestInteraction: async () => {
      requested = true;
      return {};
    },
  });

  await event("form.created", {
    form: {
      id: "frm_x",
      sessionID: "ses_1",
      fields: [{ key: "url", type: "external", url: "https://example.com" }],
    },
  });
  await nextTick();

  assert.equal(requested, false);
  assert.deepEqual(cancelled, [
    {
      sessionID: "ses_1",
      formID: "frm_x",
      message: "OpenCode form uses an external step that BB cannot show",
    },
  ]);
  const close = emitted.find(
    (delta) =>
      delta.kind === "item.close" && delta.key?.providerItemId === "form:frm_x",
  );
  assert.equal(close?.status, "failed");
  assert.match(close?.item.error, /external/);
});

test("syncs agent and title changes made in OpenCode", async () => {
  const { emitted, event, session } = sessionFixture(emptyApi);
  session.agent = "build";
  session.agentChoice = "build";
  session.publishedAgentOptions = JSON.stringify([
    {
      type: "select",
      id: "agent",
      label: "Agent",
      description: "OpenCode primary agent",
      value: "build",
      values: [
        { id: "build", label: "build" },
        { id: "reviewer", label: "reviewer" },
      ],
    },
  ]);

  await event("session.agent.selected", { agent: "reviewer" });
  assert.equal(session.agent, "reviewer");
  assert.equal(session.agentChoice, "reviewer");
  const options = emitted.find(
    (delta) =>
      delta.kind === "extension.state" &&
      delta.extensionKind === "bb/session-options",
  );
  assert.equal(options?.payload.options[0].value, "reviewer");
  const selection = emitted.find(
    (delta) =>
      delta.kind === "extension.state" &&
      delta.extensionKind === "bb/session-option-selections",
  );
  assert.equal(selection?.payload.selections.agent, "reviewer");

  session.planMode = true;
  await event("session.agent.selected", { agent: "build" });
  assert.equal(session.agentChoice, "reviewer");
  session.planMode = false;

  session.expectedTitle = "BB title";
  await event("session.renamed", { title: "BB title" });
  assert.equal(
    emitted.filter((delta) => delta.kind === "thread.name").length,
    0,
  );
  await event("session.renamed", { title: "OpenCode title" });
  const renamed = emitted.find((delta) => delta.kind === "thread.name");
  assert.equal(renamed?.name, "OpenCode title");
  assert.equal(renamed?.source, "agent");
});

test("reports a form answered in OpenCode instead of replying again", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        form: {
          reply: async (input: OpenCodeRecord) => {
            replies.push(input);
          },
          cancel: async () => {},
        },
      },
    }) as unknown as OpenCodeClient;
  let resolveInteraction!: (value: OpenCodeRecord) => void;
  const interaction = new Promise<OpenCodeRecord>((resolve) => {
    resolveInteraction = resolve;
  });
  const { emitted, event } = sessionFixture(api, {
    requestInteraction: () => interaction,
  });

  await event("form.created", {
    form: {
      id: "frm_ext",
      sessionID: "ses_1",
      fields: [{ key: "name", type: "string" }],
    },
  });
  await nextTick();
  await event("form.replied", {
    id: "frm_ext",
    sessionID: "ses_1",
    answer: { name: "Alice" },
  });
  resolveInteraction({
    resolution: {
      kind: "user_answer",
      answers: { name: { selected: [], freeText: "Bob" } },
    },
  });
  await nextTick();

  assert.deepEqual(replies, []);
  const close = emitted.find(
    (delta) =>
      delta.kind === "item.close" &&
      delta.key?.providerItemId === "form:frm_ext",
  );
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.result, "Answered in OpenCode");
});

test("skips a permission reply already answered in OpenCode", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = async () =>
    ({
      permission: {
        reply: async (input: OpenCodeRecord) => {
          replies.push(input);
        },
      },
      session: { diff: async () => [] },
    }) as unknown as OpenCodeClient;
  let resolveInteraction!: (value: OpenCodeRecord) => void;
  const interaction = new Promise<OpenCodeRecord>((resolve) => {
    resolveInteraction = resolve;
  });
  const { event } = sessionFixture(api, {
    requestInteraction: () => interaction,
  });

  await event("permission.asked", {
    id: "per_1",
    action: "shell",
    message: "run?",
  });
  await nextTick();
  await event("permission.replied", { requestID: "per_1", reply: "once" });
  resolveInteraction({ resolution: { decision: "allow_once" } });
  await nextTick();

  assert.deepEqual(replies, []);
});

test("drops settlements from a turn abandoned without finish", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = async () =>
    ({
      session: {
        diff: async () => [],
        form: {
          reply: async (input: OpenCodeRecord) => {
            replies.push(input);
          },
          cancel: async () => {},
        },
      },
    }) as unknown as OpenCodeClient;
  const { active, event, session } = sessionFixture(api, {
    requestInteraction: async () => ({
      resolution: {
        kind: "user_answer",
        answers: { name: { selected: [], freeText: "Alice" } },
      },
    }),
  });

  await event("form.replied", { id: "frm_reused" });
  assert.equal(active.settledForms.get("frm_reused"), "answered");

  // Discard the turn without finish(), then reuse the form ID in the next one.
  const next = createActiveTurn("turn-2");
  session.active = next;

  await event("form.created", {
    form: {
      id: "frm_reused",
      sessionID: "ses_1",
      fields: [{ key: "name", type: "string" }],
    },
  });
  await nextTick();

  assert.equal(replies.length, 1);
  assert.equal(next.settledForms.size, 0);
});
