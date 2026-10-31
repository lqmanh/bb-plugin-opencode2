// OpenCode's event stream does not replay, so turns that ended while it was
// disconnected must be settled from the session's recorded outcome.
import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeServer, sessions } from "./support/host-api.js";

function fakeSession(id: string, startedAt: number) {
  return {
    bbThreadId: `thr_${id}`,
    providerThreadId: id,
    active: { startedAt, promptDelivered: true },
  };
}

test("settles turns OpenCode finished while the event stream was down", async () => {
  const now = Date.now();
  const server = new OpenCodeServer();
  const finished: [string, string, string | undefined][] = [];
  const info: Record<string, unknown> = {
    ses_done: { outcome: "succeeded", time: { idle: now - 20_000 } },
    ses_failed: { outcome: "failed", time: { idle: now - 20_000 } },
    // Idle from an earlier turn: this turn has not been picked up yet.
    ses_stale: { outcome: "succeeded", time: { idle: now - 120_000 } },
    // Went idle a moment ago: trailing events may still be in flight.
    ses_recent: { outcome: "succeeded", time: { idle: now - 1_000 } },
  };
  Object.assign(server, {
    api: async () => ({
      session: {
        active: async () => ({ ses_running: {} }),
        get: async ({ sessionID }: { sessionID: string }) => info[sessionID],
      },
    }),
    finish: (
      session: { providerThreadId: string; active?: unknown },
      status: string,
      error?: string,
    ) => {
      finished.push([session.providerThreadId, status, error]);
      session.active = undefined;
    },
  });
  sessions.clear();
  for (const id of ["ses_done", "ses_failed", "ses_running", "ses_recent"])
    sessions.set(`thr_${id}`, fakeSession(id, now - 60_000) as never);
  sessions.set(
    "thr_ses_stale",
    fakeSession("ses_stale", now - 60_000) as never,
  );
  try {
    await server.reconcileActiveTurns(now);
  } finally {
    sessions.clear();
  }
  assert.deepEqual(
    finished.map(([id, status]) => [id, status]),
    [
      ["ses_done", "completed"],
      ["ses_failed", "failed"],
    ],
  );
  assert.match(finished[1][2] ?? "", /disconnected/);
});

test("leaves young turns alone", async () => {
  const now = Date.now();
  const server = new OpenCodeServer();
  let requested = false;
  Object.assign(server, {
    api: async () => {
      requested = true;
      return {};
    },
  });
  sessions.clear();
  sessions.set("thr_new", fakeSession("ses_new", now - 1_000) as never);
  try {
    await server.reconcileActiveTurns(now);
  } finally {
    sessions.clear();
  }
  assert.equal(requested, false);
});
