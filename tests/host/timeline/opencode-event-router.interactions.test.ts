import assert from "node:assert/strict";
import test from "node:test";
import { createActiveTurn } from "../../support/host-api.js";
import { nextTick } from "../../support/async.ts";
import {
  formApi,
  permissionApi,
  sessionFixture,
} from "./opencode-event-router.fixture.ts";
import type { OpenCodeRecord } from "../../../src/host/types.ts";

test("routes form.created to the question tool without polling", async () => {
  const cancelled: OpenCodeRecord[] = [];
  let listCalls = 0;
  const api = formApi({
    list: async () => {
      listCalls += 1;
      return [];
    },
    cancel: async (input: OpenCodeRecord) => {
      cancelled.push(input);
    },
  });
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
  await nextTick();
  await router.finish(session, "completed");
  await nextTick();

  assert.equal(listCalls, 0);
  assert.deepEqual(cancelled, [{ sessionID: "ses_1", formID: "form_1" }]);
  assert.ok(
    emitted.some(
      (delta) =>
        delta.kind === "item.close" && delta.key?.providerItemId === "call_q",
    ),
  );
});

test("a failed permission reply never escapes as an unhandled rejection", async () => {
  let replied = false;
  const api = permissionApi(async () => {
    replied = true;
    throw {
      _tag: "PermissionNotFoundError",
      message: "Permission request not found",
    };
  });
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

test("answers a general form through BB's question UI", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = formApi({
    reply: async (input: OpenCodeRecord) => {
      replies.push(input);
    },
  });
  const { emitted, event } = sessionFixture(api, {
    requestInteraction: async () => ({
      kind: "user_answer",
      answers: {
        name: { selected: [], freeText: "Ada" },
        count: { selected: [], freeText: "3" },
        active: { selected: ["true"] },
        tags: { selected: ["a"], freeText: "b" },
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
  const api = formApi({
    cancel: async (input: OpenCodeRecord) => {
      cancelled.push(input);
    },
  });
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

test("reports a form answered in OpenCode instead of replying again", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = formApi({
    reply: async (input: OpenCodeRecord) => {
      replies.push(input);
    },
  });
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
    kind: "user_answer",
    answers: { name: { selected: [], freeText: "Bob" } },
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
  const api = permissionApi(async (input: OpenCodeRecord) => {
    replies.push(input);
  });
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
  resolveInteraction({ decision: "allow_once" });
  await nextTick();

  assert.deepEqual(replies, []);
});

test("drops settlements from a turn abandoned without finish", async () => {
  const replies: OpenCodeRecord[] = [];
  const api = formApi({
    reply: async (input: OpenCodeRecord) => {
      replies.push(input);
    },
  });
  const { active, event, session } = sessionFixture(api, {
    requestInteraction: async () => ({
      kind: "user_answer",
      answers: { name: { selected: [], freeText: "Alice" } },
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
