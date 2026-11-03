import assert from "node:assert/strict";
import test from "node:test";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import {
  backgroundFixture,
  backgroundTaskClose,
  backgroundTaskOpen,
  completeShell,
  delegationClose,
  emptyApi,
  formApi,
  permissionApi,
  startShellTask,
  startSubagentTask,
  usagePayload,
} from "./opencode-event-router.fixture.ts";
import { nextTick } from "../../support/async.ts";
import type { OpenCodeRecord } from "../../../src/host/types.ts";

test("maps an explicit background shell to one local_bash task row", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startShellTask(event, {
    command: "npm test",
    shellStarted: true,
    progress: true,
    outputFile: "/tmp/shell.out",
    success: false,
  });
  await completeShell(event, {
    via: "synthetic",
    text: "ok",
    command: "npm test",
  });

  const opens = emitted.filter(
    (delta) => delta.kind === "item.open" && delta.item.type !== "agentMessage",
  );
  assert.equal(opens.length, 1);
  assert.equal(opens[0].item.type, "backgroundTask");
  assert.equal(opens[0].item.taskType, "local_bash");
  assert.equal(opens[0].item.familyId, "bg:call_shell");
  assert.equal(opens[0].item.skipTranscript, false);
  assert.equal(opens[0].item.foreground, false);
  assert.equal(
    emitted.some((delta) => delta.item?.type === "command"),
    false,
  );

  const progress = emitted.find(
    (delta) => delta.kind === "item.progress" && delta.snapshot,
  );
  assert.equal(progress?.snapshot.outputFile, "/tmp/shell.out");
  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.taskStatus, "completed");
  assert.equal(close?.item.summary, "ok");
  assert.equal(close?.item.outputFile, "/tmp/shell.out");
  assert.equal("providerTurnId" in (close ?? {}), false);
  assert.equal(session.backgroundTasks?.get("bg:call_shell")?.settled, true);
});

test("maps an explicit background subagent and reads child usage at completion", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event, { background: true });
  await event("session.usage.updated", {
    sessionID: "ses_child",
    tokens: usagePayload(1, 2, 3, 4, 5),
  });
  await event("session.synthetic", {
    text: '<subagent sessionID="ses_child" state="completed" description="List files">\nDone.\n</subagent>',
    metadata: {
      source: "subagent",
      childID: "ses_child",
      agent: "explore",
      state: "completed",
    },
  });

  const open = backgroundTaskOpen(emitted);
  assert.equal(open?.item.taskType, "local_agent");
  const close = backgroundTaskClose(emitted);
  assert.equal(close?.item.summary, "Done.");
  assert.equal(close?.item.taskStatus, "completed");
  assert.equal(close?.item.usage?.totalTokens, 15);
  assert.equal(close?.item.usage?.toolUses, 0);
  assert.ok((close?.item.usage?.durationMs ?? -1) >= 0);
  assert.equal(session.backgroundTasks?.get("bg:call_sub")?.settled, true);
});

test("converts a running foreground shell into a background task row", async () => {
  const { emitted, event } = backgroundFixture();

  await startShellTask(event, { background: false, command: "npm test" });

  const commandClose = emitted.find(
    (delta) => delta.kind === "item.close" && delta.item.type === "command",
  );
  assert.equal(commandClose?.status, "completed");
  assert.match(
    commandClose?.item.aggregatedOutput ?? "",
    /Moved to background/,
  );
  const taskOpen = backgroundTaskOpen(emitted);
  assert.equal(taskOpen?.item.taskType, "local_bash");
  assert.equal(taskOpen?.item.familyId, "bg:call_shell");
});

test("buffers a completion that arrives before the tool success", async () => {
  const { emitted, event, session } = backgroundFixture();

  const { succeed } = await startShellTask(event, {
    command: "true",
    success: false,
  });
  await completeShell(event, { via: "synthetic", text: "ok" });
  await succeed();

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.summary, "ok");
  assert.equal(session.backgroundTasks?.get("bg:call_shell")?.settled, true);
});

test("keeps late background completions after the spawning turn finishes", async () => {
  const { emitted, event, router, session } = backgroundFixture();

  await startShellTask(event, { command: "sleep 1" });
  await router.finish(session, "completed");
  const before = emitted.length;
  await completeShell(event, {
    via: "synthetic",
    text: "done",
    command: "sleep 1",
  });

  const close = backgroundTaskClose(emitted, before);
  assert.equal(close?.status, "completed");
  assert.equal("providerTurnId" in (close ?? {}), false);
});

test("routes a background child permission after the parent turn ends", async () => {
  const requests: OpenCodeRecord[] = [];
  const replies: OpenCodeRecord[] = [];
  const api = permissionApi(async (input: OpenCodeRecord) => {
    replies.push(input);
  });
  const { event, router, session } = backgroundFixture(api, {
    requestInteraction: async (_method, params) => {
      requests.push(params);
      return { decision: "allow_once" };
    },
  });

  await startSubagentTask(event, { background: true });
  await router.finish(session, "completed");
  await event("permission.asked", {
    sessionID: "ses_child",
    id: "per_1",
    action: "read",
    message: "read?",
  });
  await nextTick();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].turnId, null);
  assert.equal(requests[0].threadId, "bb-thread");
  assert.deepEqual(replies, [
    { sessionID: "ses_child", requestID: "per_1", decision: "once" },
  ]);
});

test("routes a background child form with the child session id and task parentRef", async () => {
  const requests: OpenCodeRecord[] = [];
  const formReplies: OpenCodeRecord[] = [];
  const api = formApi({
    reply: async (input: OpenCodeRecord) => {
      formReplies.push(input);
    },
  });
  const { emitted, event, router, session } = backgroundFixture(api, {
    requestInteraction: async (_method, params) => {
      requests.push(params);
      return { kind: "user_answer", answers: { name: { freeText: "Ada" } } };
    },
  });

  await startSubagentTask(event, { background: true });
  await router.finish(session, "completed");
  await event("form.created", {
    sessionID: "ses_child",
    form: {
      id: "form_1",
      sessionID: "ses_child",
      metadata: { kind: "question", tool: { id: "call_q" } },
      fields: [{ key: "name", type: "string", description: "Your name" }],
    },
  });
  await nextTick();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].turnId, null);
  assert.equal(formReplies.length, 1);
  assert.equal(formReplies[0].sessionID, "ses_child");
  const row = emitted.find(
    (delta) =>
      delta.key?.providerItemId === "form:form_1" &&
      delta.kind === "item.close",
  );
  assert.equal(row?.key.parentRef, "bg:call_sub");
  assert.equal(row?.status, "completed");
});

test("does not create a background task for a denied subagent", async () => {
  const { emitted, event } = backgroundFixture(emptyApi, undefined, {
    disableSubagents: true,
  });

  await startSubagentTask(event, { background: true, success: false });
  await event("session.tool.failed", {
    id: "call_sub",
    error: { message: "Native subagents are disabled" },
  });

  assert.equal(
    emitted.some((delta) => delta.item?.type === "backgroundTask"),
    false,
  );
  const delegation = delegationClose(emitted);
  assert.equal(delegation?.status, "failed");
  assert.match(delegation?.item.summary ?? "", /Native subagents/);
});

test("reconciles a completion missed while the event stream was down", async () => {
  const api = createFakeOpenCodeApi({
    message: {
      list: async () => ({
        data: [
          {
            id: "msg_1",
            type: "synthetic",
            text: '<shell id="shell_1" state="completed" command="true">\nok\n</shell>',
            metadata: {
              source: "shell",
              shellID: "shell_1",
              state: "completed",
              exit: 0,
            },
          },
        ],
      }),
    },
  });
  const { emitted, event, router, session } = backgroundFixture(api);

  await startShellTask(event, { command: "true" });
  await router.finish(session, "completed");
  const before = emitted.length;
  await router.reconcileBackgroundTasks(session);

  const close = backgroundTaskClose(emitted, before);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.summary, "ok");
  assert.equal(session.backgroundTasks?.get("bg:call_shell")?.settled, true);
});

test("converts a running foreground subagent into a background task row", async () => {
  const { emitted, event } = backgroundFixture();

  await startSubagentTask(event, { background: false, progress: true });

  const delegation = delegationClose(emitted);
  assert.equal(delegation?.status, "completed");
  assert.equal(delegation?.item.summary, "Moved to background");
  const taskOpen = backgroundTaskOpen(emitted);
  assert.equal(taskOpen?.item.taskType, "local_agent");
  assert.equal(taskOpen?.item.familyId, "bg:call_sub");
});

test("closes open background tasks as interrupted when the thread stops", async () => {
  const { emitted, event, router, session } = backgroundFixture();

  await startShellTask(event, { command: "sleep 1" });
  router.interruptBackgroundTasks(session, "Thread stopped");

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "interrupted");
  assert.equal(close?.item.taskStatus, "stopped");
  assert.equal(session.backgroundTasks?.get("bg:call_shell")?.settled, true);
});

test("closes a background shell when OpenCode reports it exited", async (t) => {
  const scenarios = [
    {
      name: "shell.exited",
      via: "shell.exited" as const,
      text: undefined as string | undefined,
    },
    {
      name: "session.shell.ended with output",
      via: "session.shell.ended" as const,
      text: "done",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { emitted, event } = backgroundFixture();

      await startShellTask(event, { command: "true" });
      await completeShell(event, {
        via: scenario.via,
        text: scenario.text,
      });

      const close = backgroundTaskClose(emitted);
      assert.equal(close?.status, "completed");
      assert.equal(close?.item.taskStatus, "completed");
      if (scenario.text) assert.equal(close?.item.summary, scenario.text);
    });
  }
});
