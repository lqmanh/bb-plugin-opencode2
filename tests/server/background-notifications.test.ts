import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { nextTick } from "../support/async.ts";
import {
  registerBackgroundCompletionNotifications,
  shouldNotifyBackgroundCompletion,
} from "../../src/server/background-notifications.ts";

const ready = {
  providerId: "opencode2",
  parentThreadId: null,
  archivedAt: null,
  visibility: "visible" as const,
  status: "idle",
  lastReadAt: 100,
  latestAttentionAt: 50,
  activeBackgroundCount: 0,
  completionSequence: 10,
  completionCreatedAt: 200,
  lastNotifiedSequence: 0,
};

test("notifies only for a new idle completion on a currently read thread", () => {
  assert.equal(shouldNotifyBackgroundCompletion(ready), true);
  assert.equal(
    shouldNotifyBackgroundCompletion({ ...ready, activeBackgroundCount: 1 }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({ ...ready, status: "active" }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({ ...ready, lastReadAt: null }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({
      ...ready,
      lastReadAt: 50,
      latestAttentionAt: 100,
    }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({
      ...ready,
      completionCreatedAt: 50,
    }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({
      ...ready,
      completionSequence: 10,
      lastNotifiedSequence: 10,
    }),
    false,
  );
  assert.equal(
    shouldNotifyBackgroundCompletion({ ...ready, providerId: "codex" }),
    false,
  );
});

test("marks an idle OpenCode thread unread once per completion", async () => {
  const marked: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "opencode2",
    sdk: {
      threads: {
        list: (async () => [
          {
            id: "thr_1",
            activity: {
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
            },
            lastReadAt: 100,
            latestAttentionAt: 50,
            status: "idle",
          },
        ]) as never,
        events: {
          list: (async () => [
            {
              seq: 10,
              createdAt: 200,
              type: "item/backgroundTask/completed",
            },
          ]) as never,
        },
        markUnread: (async ({ threadId }: { threadId: string }) => {
          marked.push(threadId);
        }) as never,
      },
    },
  });
  registerBackgroundCompletionNotifications(bb);
  const thread = {
    id: "thr_1",
    providerId: "opencode2",
    parentThreadId: null,
    archivedAt: null,
    visibility: "visible",
    status: "idle",
    lastReadAt: 100,
    latestAttentionAt: 50,
  };
  await harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: thread as never,
    sequence: 1,
  });
  await nextTick();
  await harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: thread as never,
    sequence: 2,
  });
  await nextTick();

  assert.deepEqual(marked, ["thr_1"]);
});
