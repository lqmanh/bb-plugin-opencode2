import assert from "node:assert/strict";
import test from "node:test";
import { mergeChildUsage, usageTotals } from "../../support/host-api.js";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import {
  latestContext,
  latestUsage,
  registerChild,
  usageFixture,
  usagePayload,
} from "./opencode-event-router.fixture.ts";
import type { ChildSessionRecord } from "../../../src/host/types.ts";

test("adds child usage to total and cost without changing parent last or context", async () => {
  const { emitted, event, session } = usageFixture();

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

  // Replaying the same child usage must not double-count it.
  await event("session.usage.updated", {
    sessionID: "ses_child",
    cost: 0.75,
    tokens: usagePayload(5, 6, 7, 8, 9),
  });
  assert.deepEqual(latestUsage(emitted)?.total, usage?.total);
  assert.deepEqual(latestContext(emitted)?.cost, context?.cost);
});

test("aggregates multiple and nested child sessions exactly once", async () => {
  const { emitted, event, session } = usageFixture();

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

test("keeps late child usage after the parent turn finishes", async () => {
  const { emitted, event, router, session } = usageFixture();

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
  const { emitted, event, router, session } = usageFixture();
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
  const api = createFakeOpenCodeApi({
    session: {
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
  });
  const { emitted, event, router, session } = usageFixture(api);

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
