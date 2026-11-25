import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import {
  backgroundFixture,
  backgroundTaskClose,
  backgroundTaskOpen,
  completeShell,
  delegationClose,
  emptyApi,
  formApi,
  imageTaskClose,
  permissionApi,
  startImageTask,
  startShellTask,
  startSubagentTask,
  subagentReport,
  usagePayload,
} from "./opencode-event-router.fixture.ts";
import { nextTick, withMockTimers } from "../../support/async.ts";
import type { OpenCodeRecord } from "../../../src/host/types.ts";

// OpenCode's not-found guards only check `_tag`.
const shellNotFound = () => ({ _tag: "ShellNotFoundError" });
const sessionNotFound = () => ({ _tag: "SessionNotFoundError" });

function shellInfo(overrides: OpenCodeRecord = {}) {
  return { id: "shell_1", status: "exited", ...overrides };
}

function childSession(overrides: OpenCodeRecord = {}) {
  return {
    id: "ses_child",
    time: { created: 1, updated: 2 },
    ...overrides,
  };
}

const shellOutput = (output: string) => ({ data: { output } });

type Api = Parameters<typeof backgroundFixture>[0];

async function reconcile(
  api: Api,
  start: (
    event: ReturnType<typeof backgroundFixture>["event"],
  ) => Promise<unknown>,
) {
  const { emitted, event, router, session } = backgroundFixture(api);
  await start(event);
  await router.finish(session, "completed");
  const before = emitted.length;
  await router.reconcileBackgroundTasks(session);
  return { close: backgroundTaskClose(emitted, before) };
}

const reconcileShell = (api: Api) =>
  reconcile(api, (event) => startShellTask(event, { command: "true" }));

const reconcileSubagent = (api: Api) =>
  reconcile(api, (event) => startSubagentTask(event));

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
  assert.equal(session.backgroundTasks.get("bg:call_shell")?.settled, true);
});

test("maps a subagent call and reads child usage at its final report", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event);
  await event("session.usage.updated", {
    sessionID: "ses_child",
    tokens: usagePayload(1, 2, 3, 4, 5),
  });
  await subagentReport(event, { text: "Done." });

  const open = backgroundTaskOpen(emitted);
  assert.equal(open?.item.taskType, "local_agent");
  const close = backgroundTaskClose(emitted);
  assert.equal(close?.item.summary, "Done.");
  assert.equal(close?.item.taskStatus, "completed");
  assert.equal(close?.item.usage?.totalTokens, 15);
  assert.equal(close?.item.usage?.toolUses, 0);
  assert.ok((close?.item.usage?.durationMs ?? -1) >= 0);
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, true);
});

test("settles a completed report whose answer quotes the running heading", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event);
  await subagentReport(event, {
    state: "completed",
    text: "The log said:\n\nBackground work still running:\n- shell (shell_1): sleep 20",
  });

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.taskStatus, "completed");
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, true);
});

test("routes a nested child's permission and form to the top-level task", async () => {
  const requests: OpenCodeRecord[] = [];
  const permissionReplies: OpenCodeRecord[] = [];
  const formReplies: OpenCodeRecord[] = [];
  const api = createFakeOpenCodeApi({
    permission: {
      reply: async (input: OpenCodeRecord) => {
        permissionReplies.push(input);
      },
    },
    session: {
      form: {
        reply: async (input: OpenCodeRecord) => {
          formReplies.push(input);
        },
      },
    },
  });
  const { emitted, event, router, session } = backgroundFixture(api, {
    requestInteraction: async (_method, params) => {
      requests.push(params);
      return params.payload?.kind === "approval"
        ? { decision: "allow_once" }
        : { kind: "user_answer", answers: { name: { freeText: "Ada" } } };
    },
  });

  await startSubagentTask(event);
  await event("session.tool.progress", {
    sessionID: "ses_child",
    id: "call_grand",
    metadata: { sessionID: "ses_grand", status: "running" },
  });
  await event("permission.asked", {
    sessionID: "ses_grand",
    id: "per_1",
    action: "read",
    message: "read?",
  });
  await event("form.created", {
    sessionID: "ses_grand",
    form: {
      id: "form_1",
      metadata: { kind: "question", tool: { id: "call_q" } },
      fields: [{ key: "name", type: "string", description: "Your name" }],
    },
  });
  await nextTick();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].turnId, null);
  assert.deepEqual(permissionReplies, [
    { sessionID: "ses_grand", requestID: "per_1", decision: "once" },
  ]);
  assert.equal(formReplies.length, 1);
  assert.equal(formReplies[0].sessionID, "ses_grand");
  const row = emitted.find(
    (delta) =>
      delta.key?.providerItemId === "form:form_1" &&
      delta.kind === "item.close",
  );
  assert.equal(row?.key.parentRef, "bg:call_sub");

  // The nested child's own execution must not settle the top-level task.
  await withMockTimers(async () => {
    await event("session.execution.succeeded", { sessionID: "ses_grand" });
    mock.timers.tick(5_000);
  });
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, false);

  await router.finish(session, "completed");
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
  assert.equal(session.backgroundTasks.get("bg:call_shell")?.settled, true);
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

  await startSubagentTask(event);
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

  await startSubagentTask(event);
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

  await startSubagentTask(event, { success: false });
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

test("maps reconciled shell status and exit codes", async (t) => {
  const scenarios = [
    {
      name: "exited zero",
      status: "exited",
      exit: 0,
      close: "completed",
      task: "completed",
      error: undefined,
    },
    {
      name: "exited non-zero",
      status: "exited",
      exit: 7,
      close: "failed",
      task: "failed",
      error: /Exited with code 7/,
    },
    {
      name: "timeout",
      status: "timeout",
      exit: undefined,
      close: "failed",
      task: "failed",
      error: /timed out/,
    },
    {
      name: "killed",
      status: "killed",
      exit: undefined,
      close: "interrupted",
      task: "stopped",
      error: undefined,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { close } = await reconcileShell(
        createFakeOpenCodeApi({
          shell: {
            get: async () => ({
              data: shellInfo({ status: scenario.status, exit: scenario.exit }),
            }),
            output: async () => shellOutput("output"),
          },
        }),
      );

      assert.equal(close?.status, scenario.close);
      assert.equal(close?.item?.taskStatus, scenario.task);
      assert.equal(close?.item?.summary, "output");
      if (scenario.error)
        assert.match(close?.item?.error ?? "", scenario.error);
    });
  }
});

test("keeps running or unavailable shells open", async (t) => {
  const scenarios = [
    {
      name: "running",
      get: async () => ({ data: shellInfo({ status: "running" }) }),
    },
    {
      name: "get failure",
      get: async () => {
        throw new Error("shell service unavailable");
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { close } = await reconcileShell(
        createFakeOpenCodeApi({ shell: { get: scenario.get } }),
      );

      assert.equal(close, undefined);
    });
  }
});

test("settles a missing shell as stopped", async () => {
  const { close } = await reconcileShell(
    createFakeOpenCodeApi({
      shell: {
        get: async () => {
          throw shellNotFound();
        },
      },
    }),
  );

  assert.equal(close?.status, "interrupted");
  assert.match(close?.item?.error ?? "", /no longer available/);
});

test("settles a missed subagent completion from its outcome", async (t) => {
  const scenarios = [
    {
      outcome: "succeeded",
      close: "completed",
      task: "completed",
      error: undefined,
    },
    {
      outcome: "failed",
      close: "failed",
      task: "failed",
      error: /Background task failed/,
    },
    {
      outcome: "interrupted",
      close: "interrupted",
      task: "stopped",
      error: undefined,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.outcome, async () => {
      const { close } = await reconcileSubagent(
        createFakeOpenCodeApi({
          session: {
            get: async () => childSession({ outcome: scenario.outcome }),
          },
        }),
      );

      assert.equal(close?.status, scenario.close);
      assert.equal(close?.item?.taskStatus, scenario.task);
      assert.equal(close?.item?.summary, undefined);
      if (scenario.error)
        assert.match(close?.item?.error ?? "", scenario.error);
    });
  }
});

test("falls through a stale outcome on a busy child", async (t) => {
  const scenarios = [
    { name: "active", active: { ses_child: {} }, close: undefined },
    {
      name: "inactive",
      active: {},
      close: "interrupted",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { close } = await reconcileSubagent(
        createFakeOpenCodeApi({
          session: {
            get: async () =>
              childSession({
                outcome: "succeeded",
                time: { created: 1, updated: 3, busy: 3, idle: 2 },
              }),
            active: async () => scenario.active,
          },
        }),
      );

      assert.equal(close?.status, scenario.close);
      if (scenario.close)
        assert.match(close?.item?.error ?? "", /no longer running/);
    });
  }
});

test("settles an inactive child from its late outcome", async () => {
  let reads = 0;
  const { close } = await reconcileSubagent(
    createFakeOpenCodeApi({
      session: {
        get: async () => {
          reads += 1;
          return reads === 1
            ? childSession({ time: { created: 1, updated: 3, busy: 3 } })
            : childSession({
                outcome: "succeeded",
                time: { created: 1, updated: 4, busy: 3, idle: 4 },
              });
        },
        active: async () => ({}),
      },
    }),
  );

  assert.equal(close?.status, "completed");
  assert.equal(close?.item?.taskStatus, "completed");
});

test("settles an inactive child without an outcome as stopped", async () => {
  const { close } = await reconcileSubagent(
    createFakeOpenCodeApi({
      session: {
        get: async () => childSession(),
        active: async () => ({}),
      },
    }),
  );

  assert.equal(close?.status, "interrupted");
  assert.match(close?.item?.error ?? "", /no longer running/);
});

test("settles a missing subagent session as stopped", async () => {
  const { close } = await reconcileSubagent(
    createFakeOpenCodeApi({
      session: {
        get: async () => {
          throw sessionNotFound();
        },
      },
    }),
  );

  assert.equal(close?.status, "interrupted");
  assert.match(close?.item?.error ?? "", /no longer available/);
});

test("leaves a subagent open on other session.get failures", async () => {
  const { close } = await reconcileSubagent(
    createFakeOpenCodeApi({
      session: {
        get: async () => {
          throw new Error("session service unavailable");
        },
      },
    }),
  );

  assert.equal(close, undefined);
});

test("keeps reconciling other tasks after a session.active failure", async () => {
  const api = createFakeOpenCodeApi({
    shell: {
      get: async () => {
        throw shellNotFound();
      },
    },
    session: {
      get: async () => childSession(),
      active: async () => {
        throw new Error("active failed");
      },
    },
  });
  const { emitted, event, router, session } = backgroundFixture(api);

  await startSubagentTask(event);
  await startShellTask(event, { command: "true" });
  await router.finish(session, "completed");
  const before = emitted.length;
  await router.reconcileBackgroundTasks(session);

  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, false);
  assert.equal(session.backgroundTasks.get("bg:call_shell")?.settled, true);
  assert.equal(
    backgroundTaskClose(emitted, before)?.key?.providerItemId,
    "bg:call_shell",
  );
});

test("keeps a task open through a running report and settles on the final one", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event);
  await withMockTimers(async () => {
    await event("session.execution.succeeded", { sessionID: "ses_child" });
    await subagentReport(event, { state: "running", text: "child started" });
    mock.timers.tick(1_100);
  });

  assert.equal(backgroundTaskClose(emitted), undefined);
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, false);

  await subagentReport(event, { text: "Done." });

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item.summary, "Done.");
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, true);
});

test("opens a new task row when a follow-up job reports again", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event, { callId: "call_first" });
  await subagentReport(event, { text: "First." });
  await startSubagentTask(event, {
    callId: "call_second",
    sessionID: "ses_child",
  });
  await subagentReport(event, { state: "running", text: "Second start." });
  await subagentReport(event, { text: "Second." });

  const opens = emitted.filter(
    (delta) =>
      delta.kind === "item.open" && delta.item?.type === "backgroundTask",
  );
  const closes = emitted.filter(
    (delta) =>
      delta.kind === "item.close" && delta.item?.type === "backgroundTask",
  );
  assert.deepEqual(
    opens.map((delta) => delta.key.providerItemId),
    ["bg:call_first", "bg:call_second"],
  );
  assert.deepEqual(
    closes.map((delta) => delta.key.providerItemId),
    ["bg:call_first", "bg:call_second"],
  );
  assert.equal(session.backgroundTasks.get("bg:call_first")?.settled, true);
  assert.equal(session.backgroundTasks.get("bg:call_second")?.settled, true);
});

test("settles a child that goes idle without reporting", async () => {
  const { emitted, event, session } = backgroundFixture();

  await startSubagentTask(event);
  await withMockTimers(async () => {
    await event("session.execution.succeeded", { sessionID: "ses_child" });
    assert.equal(backgroundTaskClose(emitted), undefined);
    mock.timers.tick(1_100);
  });

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(session.backgroundTasks.get("bg:call_sub")?.settled, true);
});

test("closes open task rows as interrupted when the thread stops", async () => {
  const { emitted, event, router, session } = backgroundFixture();

  await startShellTask(event, { command: "sleep 1" });
  await startImageTask(event);
  router.interruptBackgroundTasks(session, "Thread stopped");

  const close = backgroundTaskClose(emitted);
  assert.equal(close?.status, "interrupted");
  assert.equal(close?.item.taskStatus, "stopped");
  assert.equal(session.backgroundTasks.get("bg:call_shell")?.settled, true);

  const image = imageTaskClose(emitted);
  assert.equal(image?.status, "interrupted");
  assert.equal(session.backgroundTasks.get("bg:call_image")?.settled, true);
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
