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

test("opens an image task and renders the result in the turn that receives it", async () => {
  const { emitted, event, router, session } = backgroundFixture(emptyApi);
  await startImageTask(event, {
    jobId: "image_1",
    prompt: "A cat",
    path: "/tmp/cat",
  });

  const open = imageTaskOpen(emitted);
  assert.equal(open?.item?.taskType, "local_image");
  assert.equal(open?.item?.description, "A cat");
  assert.equal(open?.item?.taskStatus, "running");
  assert.equal(open?.presentation?.label?.pending, "Generating image");

  await router.finish(session, "completed");
  const { inboxId } = await imageReport(event, {
    jobId: "image_1",
    path: "/tmp/cat.png",
  });
  const taskClose = imageTaskClose(emitted);
  assert.equal(taskClose?.status, "completed");
  assert.equal(taskClose?.item?.taskStatus, "completed");
  assert.equal(taskClose?.item?.summary, "Image generated");
  assert.equal(imageRowOpen(emitted), undefined);

  await event("session.execution.started");
  await deliverImageReport(event, inboxId);

  assert.equal(imageRowOpen(emitted)?.item?.prompt, "A cat");
  const rowClose = imageRowClose(emitted);
  assert.equal(rowClose?.status, "completed");
  assert.equal(rowClose?.presentation?.title, "A cat");

  const events = experimental_createDeltaAssembler({
    providerId: "opencode2",
  }).assemble({
    threadId: session.bbThreadId,
    deltas: emitted as never,
  });
  const imageStarted = events.filter(
    (event) =>
      event.type === "item/started" &&
      (event as { item?: { type?: string } }).item?.type === "imageGeneration",
  );
  const imageCompleted = events.filter(
    (event) =>
      event.type === "item/completed" &&
      (event as { item?: { type?: string } }).item?.type === "imageGeneration",
  );
  assert.equal(imageStarted.length, 1);
  assert.equal(imageCompleted.length, 1);
  assert.deepEqual(imageStarted[0]?.scope, imageCompleted[0]?.scope);
  const turnStarts = events.filter((event) => event.type === "turn/started");
  assert.deepEqual(imageStarted[0]?.scope, turnStarts.at(-1)?.scope);
  assert.equal(
    (
      imageCompleted[0] as
        { item?: { type?: string; path?: string | null } } | undefined
    )?.item?.path,
    "/tmp/cat.png",
  );

  const duplicateFrom = emitted.length;
  const duplicate = await imageReport(event, {
    jobId: "image_1",
    path: "/tmp/cat.png",
  });
  await deliverImageReport(event, duplicate.inboxId);
  assert.equal(imageRowClose(emitted, duplicateFrom), undefined);
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
  const stem = "/tmp/cat";
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
          metadata: { jobID: "image_1", path: stem, model: "mock/image" },
        },
      },
    ],
  };
  const synthetic = imageHistoryMessage({
    jobId: "image_1",
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
  await startImageTask(event, { success: false, path: stem });
  await router.finish(session, "completed");
  await router.reconcileBackgroundTasks(session);

  assert.equal(imageTaskClose(emitted)?.status, "completed");
  const report = session.pendingImageReports.get("msg_report");
  assert.equal(report?.delivered, true);
  assert.equal(report?.path, "/tmp/one.png");
});

test("does not render a settled image from history during another task's reconcile", async () => {
  const synthetic = imageHistoryMessage({
    jobId: "image_1",
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
  await startImageTask(event, { jobId: "image_1", path: "/tmp/one" });
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

test("settles an image task from the job list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-image-"));
  const stem = join(dir, "cat");
  writeFileSync(`${stem}.png`, "");
  const api = createFakeOpenCodeApi({
    message: { list: async () => ({ data: [] }) },
    experimental: {
      job: {
        list: async () => [
          {
            kind: "image",
            id: "image_1",
            sessionID: "ses_1",
            status: "completed",
            time: { started: 1, completed: 2 },
            path: stem,
            model: "mock/image",
          },
        ],
      },
    },
  });
  try {
    const { emitted, event, router, session } = backgroundFixture(api);
    await startImageTask(event, { jobId: "image_1", path: stem });
    await router.finish(session, "completed");
    await router.reconcileBackgroundTasks(session);

    const close = imageTaskClose(emitted);
    assert.equal(close?.status, "completed");
    const report = session.pendingImageReports.get("job:image_1");
    assert.equal(report?.delivered, true);
    assert.equal(report?.path, `${stem}.png`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
