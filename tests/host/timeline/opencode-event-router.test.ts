import assert from "node:assert/strict";
import test from "node:test";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import {
  backgroundFixture,
  emptyApi,
  registerChild,
  sessionFixture,
  sessionWithTurnDiff,
  subagentReport,
} from "./opencode-event-router.fixture.ts";
import type { OpenCodeRecord } from "../../../src/host/types.ts";

function mcpApi(remove: (input: OpenCodeRecord) => Promise<void>) {
  return createFakeOpenCodeApi({ experimental: { mcp: { remove } } });
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

test("keeps a subagent's work out of the parent turn", async () => {
  const { active, emitted, event, router, session } = backgroundFixture(
    emptyApi,
    undefined,
    { providerThreadId: "ses_parent", cwd: process.cwd() },
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
  // A nested child is usage-only; its output must not leak into the parent.
  await event("session.tool.input.started", {
    sessionID: "ses_child",
    id: "call_grand",
    name: "subagent",
  });
  await event("session.tool.called", {
    sessionID: "ses_child",
    id: "call_grand",
    input: { agent: "explore", description: "Nested", prompt: "inner" },
  });
  await event("session.tool.progress", {
    sessionID: "ses_child",
    id: "call_grand",
    metadata: { sessionID: "ses_grand", status: "running" },
  });
  await event("session.text.started", {
    sessionID: "ses_grand",
    assistantMessageID: "msg_nested",
    ordinal: 0,
  });
  await event("session.text.ended", {
    sessionID: "ses_grand",
    assistantMessageID: "msg_nested",
    ordinal: 0,
    text: "nested output",
  });
  // The child's own lifecycle must not settle the parent turn.
  await event("session.execution.succeeded", { sessionID: "ses_child" });
  assert.equal(session.active, active);

  const taskOpen = emitted.find(
    (delta) =>
      delta.kind === "item.open" && delta.item.type === "backgroundTask",
  );
  assert.equal(taskOpen?.item.taskType, "local_agent");
  assert.equal(
    emitted.some((delta) => delta.item?.type === "delegation"),
    false,
  );
  assert.equal(
    emitted.some((delta) => delta.key?.providerItemId === "call_child"),
    false,
  );
  assert.equal(
    emitted.some((delta) => delta.key?.providerItemId === "text:msg_nested:0"),
    false,
  );
  assert.equal(
    emitted.some((delta) => delta.key?.parentRef === "call_grand"),
    false,
  );

  await router.finish(session, "completed");
});

test("opens a BB turn for a run woken by a report", async () => {
  const { emitted, event, router, session } = sessionFixture(emptyApi);

  await router.finish(session, "completed");
  const before = emitted.length;

  await subagentReport(event, { inboxId: "msg_report", text: "Done." });
  await event("session.execution.started");
  assert.equal(session.active?.interaction.providerTurnId, null);
  assert.equal(session.pendingReportIds?.has("msg_report"), true);

  await event("session.inbox.delivered", { inboxID: "msg_report" });
  assert.equal(session.pendingReportIds?.has("msg_report"), false);

  await event("session.text.started", {
    assistantMessageID: "msg_report",
    ordinal: 0,
  });
  await event("session.text.delta", {
    assistantMessageID: "msg_report",
    ordinal: 0,
    delta: "Answer",
  });
  await event("session.text.ended", {
    assistantMessageID: "msg_report",
    ordinal: 0,
    text: "Answer",
  });
  await event("session.execution.succeeded");

  const turn = emitted.slice(before);
  const open = turn.find((delta) => delta.kind === "turn.open");
  assert.equal(open?.providerTurnId, undefined);
  const boundary = turn.find((delta) => delta.kind === "turn.boundary");
  assert.equal(boundary?.providerTurnId, undefined);
  assert.equal(boundary?.status, "completed");
  assert.equal(
    turn.some((delta) => "providerTurnId" in delta),
    false,
  );
  assert.equal(
    turn.some(
      (delta) =>
        delta.kind === "item.open" && delta.key?.channel === "agentMessage",
    ),
    true,
  );
  assert.equal(session.active, undefined);
});

test("does not open a turn for a report settled in the active turn", async (t) => {
  for (const eventType of [
    "session.inbox.delivered",
    "session.inbox.cancelled",
  ] as const) {
    await t.test(eventType, async () => {
      const { emitted, event, router, session } = sessionFixture(emptyApi);

      await subagentReport(event, { inboxId: "msg_report" });
      await event(eventType, { inboxID: "msg_report" });
      await router.finish(session, "completed");
      const before = emitted.length;
      await event("session.execution.started");

      assert.equal(session.pendingReportIds?.has("msg_report"), false);
      assert.equal(session.active, undefined);
      assert.equal(
        emitted.slice(before).some((delta) => delta.kind === "turn.open"),
        false,
      );
    });
  }
});

test("opens a turn for a report still pending when the previous turn ends", async () => {
  const { emitted, event, router, session } = sessionFixture(emptyApi);

  await subagentReport(event, { inboxId: "msg_late" });
  assert.equal(session.pendingReportIds?.has("msg_late"), true);
  await router.finish(session, "completed");
  const before = emitted.length;

  await event("session.execution.started");
  assert.equal(session.active?.interaction.providerTurnId, null);
  assert.equal(
    emitted.slice(before).some((delta) => delta.kind === "turn.open"),
    true,
  );

  await event("session.inbox.delivered", { inboxID: "msg_late" });
  await event("session.execution.succeeded");
  assert.equal(session.pendingReportIds?.has("msg_late"), false);
  assert.equal(session.active, undefined);
});

test("suppresses a report-woken turn after Stop", async () => {
  const { emitted, event, lookup, router, session } = sessionFixture(emptyApi);

  session.suppressReportWake = true;
  await subagentReport(event, {
    inboxId: "msg_stopped",
    state: "cancelled",
  });
  await router.finish(session, "completed");
  const before = emitted.length;
  await event("session.execution.started");

  assert.equal(session.pendingReportIds?.has("msg_stopped") ?? false, false);
  assert.equal(session.active, undefined);
  assert.equal(
    emitted.slice(before).some((delta) => delta.kind === "turn.open"),
    false,
  );

  // The next user action clears suppression; a new report opens a turn again.
  session.suppressReportWake = false;
  await subagentReport(event, { inboxId: "msg_next" });
  await event("session.execution.started");
  assert.equal(
    lookup.get(session.providerThreadId)?.active?.interaction.providerTurnId,
    null,
  );
});

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

  // An empty diff still ends the turn with a boundary.
  const empty = sessionWithTurnDiff([]);
  await empty.event("session.execution.succeeded", {});
  const emptyKinds = empty.emitted.map((delta) => delta.kind);
  assert.equal(emptyKinds.includes("turn.diff"), false);
  assert.equal(emptyKinds.includes("turn.boundary"), true);
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
  session.active?.interaction.abortController.signal.addEventListener(
    "abort",
    () => events.push("abort"),
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
