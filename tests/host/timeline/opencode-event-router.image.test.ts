import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createActiveTurn } from "../../support/host-api.js";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import {
  backgroundFixture,
  deliverImageReport,
  emptyApi,
  imageHistoryMessage,
  imageReport,
  imageRowClose,
  imageRowOpen,
  imageTaskClose,
  imageTaskOpen,
  startImageTask,
} from "./opencode-event-router.fixture.ts";

function assertImageRowInLastTurn(emitted: unknown[], threadId: string) {
  const events = experimental_createDeltaAssembler({
    providerId: "opencode2",
  }).assemble({
    threadId,
    deltas: emitted as never,
  });
  const imageItems = (type: string) =>
    events.filter(
      (event) =>
        event.type === type &&
        (event as { item?: { type?: string } }).item?.type ===
          "imageGeneration",
    );
  const started = imageItems("item/started");
  const completed = imageItems("item/completed");
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.deepEqual(started[0]?.scope, completed[0]?.scope);
  const turnStarts = events.filter((event) => event.type === "turn/started");
  assert.ok(turnStarts.length > 0);
  assert.deepEqual(started[0]?.scope, turnStarts.at(-1)?.scope);
}

test("opens an image task and renders the result in the receiving turn", async () => {
  const { emitted, event, router, session } = backgroundFixture(emptyApi);
  await startImageTask(event, { prompt: "A cat", path: "/tmp/cat" });

  const open = imageTaskOpen(emitted);
  assert.equal(open?.item?.taskType, "local_image");
  assert.equal(open?.item?.description, "A cat");

  await router.finish(session, "completed");
  const { inboxId } = await imageReport(event, { path: "/tmp/cat.png" });
  const taskClose = imageTaskClose(emitted);
  assert.equal(taskClose?.status, "completed");
  assert.equal(taskClose?.item?.summary, "Image generated");
  assert.equal(imageRowOpen(emitted), undefined);

  await event("session.execution.started");
  await deliverImageReport(event, inboxId);

  assert.equal(imageRowOpen(emitted)?.item?.prompt, "A cat");
  assert.equal(imageRowClose(emitted)?.status, "completed");
  assertImageRowInLastTurn(emitted, session.bbThreadId);
});

test("renders a Code Mode image report in the receiving turn", async () => {
  const { emitted, event, router, session } = backgroundFixture(emptyApi);
  await event("session.tool.input.started", {
    id: "call_execute",
    name: "execute",
  });
  await event("session.tool.called", { id: "call_execute", input: {} });

  await router.finish(session, "completed");
  const { inboxId } = await imageReport(event, { path: "/tmp/cat.png" });
  await event("session.execution.started");
  await deliverImageReport(event, inboxId);

  assert.equal(imageTaskOpen(emitted), undefined);
  assert.equal(imageRowOpen(emitted)?.item?.prompt, null);
  const close = imageRowClose(emitted);
  assert.equal(close?.status, "completed");
  assert.equal(close?.item?.path, "/tmp/cat.png");
  assert.equal(close?.presentation?.title, "cat.png");
  assertImageRowInLastTurn(emitted, session.bbThreadId);

  const duplicateFrom = emitted.length;
  const duplicate = await imageReport(event, { path: "/tmp/cat.png" });
  await deliverImageReport(event, duplicate.inboxId);
  assert.equal(imageRowOpen(emitted, duplicateFrom), undefined);
});

test("renders a failed Code Mode image report", async () => {
  const { emitted, event } = backgroundFixture(emptyApi);
  const { inboxId } = await imageReport(event, {
    state: "error",
    path: "/tmp/cat.png",
  });
  await deliverImageReport(event, inboxId);

  assert.equal(imageRowOpen(emitted)?.item?.prompt, null);
  const close = imageRowClose(emitted);
  assert.equal(close?.status, "failed");
  assert.equal(close?.item?.path, null);
  assert.equal(
    close?.item?.error,
    "Image request failed for /tmp/cat: mock failure.",
  );
  assert.equal(close?.presentation?.title, "cat");
});

test("applies an image report that arrives before the tool success", async () => {
  const { emitted, event } = backgroundFixture(emptyApi);
  const { succeed } = await startImageTask(event, {
    success: false,
    path: "/tmp/cat",
  });
  const { inboxId } = await imageReport(event, { path: "/tmp/cat.png" });
  assert.equal(imageTaskClose(emitted), undefined);

  await succeed();
  assert.equal(imageTaskClose(emitted)?.status, "completed");

  await deliverImageReport(event, inboxId);
  assert.equal(imageRowClose(emitted)?.item?.path, "/tmp/cat.png");
});

test("fails the image task when the tool fails", async () => {
  const { emitted, event } = backgroundFixture(emptyApi);
  await startImageTask(event, { fail: true });

  const close = imageTaskClose(emitted);
  assert.equal(close?.status, "failed");
  assert.match(close?.item?.error ?? "", /Image generation denied/);
  assert.equal(imageRowOpen(emitted), undefined);
});

test("settles an image task from history and queues its result", async () => {
  const assistant = {
    type: "assistant",
    id: "msg_assistant",
    content: [
      {
        type: "tool",
        id: "call_image",
        name: "generate_image",
        state: {
          status: "completed",
          metadata: { jobID: "image_1", path: "/tmp/cat" },
        },
      },
    ],
  };
  const synthetic = imageHistoryMessage({
    path: "/tmp/one.png",
    inboxId: "msg_report",
  });
  const api = createFakeOpenCodeApi({
    message: {
      list: async ({ type }: { type?: string }) => ({
        data:
          type === "assistant"
            ? [assistant]
            : type === "synthetic"
              ? [synthetic]
              : [],
      }),
    },
    experimental: { job: { list: async () => [] } },
  });
  const { emitted, event, router, session } = backgroundFixture(api);
  await startImageTask(event, { success: false, path: "/tmp/cat" });
  await router.finish(session, "completed");
  await router.reconcileBackgroundTasks(session);

  assert.equal(imageTaskClose(emitted)?.status, "completed");
  const report = session.pendingImageReports.get("msg_report");
  assert.equal(report?.delivered, true);
  assert.equal(report?.path, "/tmp/one.png");
});

test("does not render a settled image from history during another task's reconcile", async () => {
  const synthetic = imageHistoryMessage({
    path: "/tmp/one.png",
    inboxId: "msg_settled",
  });
  const api = createFakeOpenCodeApi({
    message: {
      list: async ({ type }: { type?: string }) => ({
        data: type === "synthetic" ? [synthetic] : [],
      }),
    },
    experimental: { job: { list: async () => [] } },
  });
  const { emitted, event, router, session } = backgroundFixture(api);
  await startImageTask(event, { path: "/tmp/one" });
  router.interruptBackgroundTasks(session, "Thread stopped");
  await startImageTask(event, {
    callId: "call_image_2",
    jobId: "image_2",
    path: "/tmp/two",
  });
  await router.finish(session, "completed");
  session.active = createActiveTurn("turn-2", session.providerThreadId);

  await router.reconcileBackgroundTasks(session);

  assert.equal(imageRowOpen(emitted), undefined);
});

test("settles an image task from the job list", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bb-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stem = join(dir, "cat");
  writeFileSync(`${stem}.png`, "");
  const api = createFakeOpenCodeApi({
    message: { list: async () => ({ data: [] }) },
    experimental: {
      job: {
        list: async () => [
          { kind: "image", id: "image_1", status: "completed", path: stem },
        ],
      },
    },
  });
  const { emitted, event, router, session } = backgroundFixture(api);
  await startImageTask(event, { path: stem });
  await router.finish(session, "completed");
  await router.reconcileBackgroundTasks(session);

  assert.equal(imageTaskClose(emitted)?.status, "completed");
  const report = session.pendingImageReports.get("job:image_1");
  assert.equal(report?.delivered, true);
  assert.equal(report?.path, `${stem}.png`);
});
