import assert from "node:assert/strict";
import test from "node:test";
import { stopSessionForIntent } from "../../support/host-api.js";
import { createTestSession } from "../../support/session.fixture.ts";

function stopClient(calls: string[]) {
  return {
    async stopBackgroundTasks() {
      calls.push("stop-background");
    },
    async cancelImageJobs() {
      calls.push("cancel-images");
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

test("interrupt stops background work before and after the parent session", async () => {
  const calls: string[] = [];
  const session = createTestSession({ providerThreadId: "ses_1" });
  session.pendingReportIds = new Set(["msg_report"]);
  await stopSessionForIntent(session, "interrupt", stopClient(calls));
  assert.deepEqual(calls, [
    "stop-background",
    "cancel-images",
    "interrupt:ses_1",
    "cancel-images",
    "finish",
  ]);
  assert.equal(session.suppressReportWake, true);
  assert.equal(session.pendingReportIds.size, 0);
});

test("release leaves provider work alone but stops local tracking", async () => {
  const calls: string[] = [];
  const session = createTestSession({ providerThreadId: "ses_1" });
  await stopSessionForIntent(session, "release", stopClient(calls));
  assert.deepEqual(calls, ["clear"]);
});
