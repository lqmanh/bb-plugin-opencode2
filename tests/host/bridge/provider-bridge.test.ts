import assert from "node:assert/strict";
import test from "node:test";
import { stopSessionForIntent } from "../../support/host-api.js";
import { createTestSession } from "../../support/session.fixture.ts";

function stopClient(calls: string[]) {
  return {
    async stopBackgroundTasks() {
      calls.push("stop-background");
    },
    async api() {
      return {
        session: {
          async interrupt({ sessionID }: { sessionID: string }) {
            calls.push(`interrupt:${sessionID}`);
          },
        },
      };
    },
    async finish() {
      calls.push("finish");
    },
    clearBackgroundTasks() {
      calls.push("clear");
    },
  };
}

const session = createTestSession({ providerThreadId: "ses_1" });

test("interrupt stops background work before the parent session", async () => {
  const calls: string[] = [];
  await stopSessionForIntent(session, "interrupt", stopClient(calls));
  assert.deepEqual(calls, ["stop-background", "interrupt:ses_1", "finish"]);
});

test("release leaves provider work alone but stops local tracking", async () => {
  const calls: string[] = [];
  await stopSessionForIntent(session, "release", stopClient(calls));
  assert.deepEqual(calls, ["clear"]);
});
