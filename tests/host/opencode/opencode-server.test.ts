import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OpenCodeServer,
  sessions,
  sessionsByProviderId,
} from "../../support/host-api.js";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import { createTestSession } from "../../support/session.fixture.ts";
import {
  ARCHIVED_SESSION_MESSAGE,
  type BackgroundTaskRecord,
  type SessionState,
} from "../../../src/host/types.ts";

test("follows checkpoint cursors even when a page is shorter than the requested limit", async () => {
  const inputs: { limit?: number; order?: string; cursor?: string }[] = [];
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      message: {
        list: async (input: {
          limit?: number;
          order?: string;
          cursor?: string;
        }) => {
          inputs.push(input);
          return inputs.length === 1
            ? {
                data: [{ id: "msg-1", type: "user" }],
                cursor: { next: "next" },
              }
            : {
                data: [{ id: "msg-2", type: "assistant" }],
                cursor: {},
              };
        },
      },
    }),
  });

  assert.deepEqual(await server.listSessionMessageIds("session"), [
    { id: "msg-1", type: "user" },
    { id: "msg-2", type: "assistant" },
  ]);
  assert.equal(inputs[1].limit, 200);
  assert.equal(inputs[1].cursor, "next");
  assert.equal("order" in inputs[1], false);
});

test("rewinds with the SDK session revert methods", async () => {
  const calls: string[] = [];
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      message: {
        list: async () => ({
          data: [
            { id: "msg_u1", type: "user" },
            { id: "msg_a1", type: "assistant" },
            { id: "msg_u2", type: "user" },
          ],
          cursor: {},
        }),
      },
      session: {
        interrupt: async () => {
          calls.push("interrupt");
        },
        revert: {
          clear: async () => {
            calls.push("clear");
          },
          stage: async (input: { messageID: string; files?: boolean }) => {
            calls.push(`stage:${input.messageID}:${input.files}`);
          },
          commit: async () => {
            calls.push("commit");
          },
        },
      },
    }),
  });

  await server.rewindSessionRetainingThrough("session", "msg_u1");
  assert.deepEqual(calls, ["interrupt", "stage:msg_u2:true", "commit"]);

  calls.length = 0;
  await server.rewindSessionRetainingThrough("session", "msg_u2");
  assert.deepEqual(calls, ["clear"]);
});

test("persists the BB thread session mapping for stateless rewinds", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "opencode2-sessions-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  await server.rememberSessionRegistration("bb-thread", {
    providerThreadId: "ses_123",
    cwd: "/repo",
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  });
  assert.deepEqual(await server.lookupSessionRegistration("bb-thread"), {
    providerThreadId: "ses_123",
    cwd: "/repo",
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  });

  // A fresh server over the same data dir still resolves the mapping, so a
  // restarted worker can tell an in-place rewind from a true fork.
  const restarted = new OpenCodeServer();
  restarted.setDataDir(dataDir);
  assert.equal(
    (await restarted.lookupSessionRegistration("bb-thread"))?.providerThreadId,
    "ses_123",
  );
  await restarted.forgetSessionRegistration("bb-thread");
  assert.equal(
    await restarted.lookupSessionRegistration("bb-thread"),
    undefined,
  );
});

test("resolves an MCP startup wait from mcp.status.changed", async () => {
  let status = "starting";
  let listCalls = 0;
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      mcp: {
        list: async () => {
          listCalls += 1;
          return { data: [{ name: "bb_tools", status: { status } }] };
        },
      },
    }),
  });

  const waiting = server.waitForMcpServer("bb_tools", "/repo", 5_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(listCalls, 1);

  status = "connected";
  await server.handleEvent({
    type: "mcp.status.changed",
    data: { server: "bb_tools" },
  });

  assert.equal(await waiting, true);
  assert.equal(listCalls, 2);
});

test("serializes MCP registry mutations without dropping persisted entries", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "opencode2-registry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "opencode2-mcp-registry.json");
  await writeFile(
    path,
    JSON.stringify({
      existing: { serverName: "bb_existing", cwd: "/existing" },
    }),
  );

  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  await Promise.all([
    server.rememberMcpRegistration("session-a", {
      serverName: "bb_a",
      cwd: "/a",
    }),
    server.rememberMcpRegistration("session-b", {
      serverName: "bb_b",
      cwd: "/b",
    }),
    server.rememberMcpRegistration("session-c", {
      serverName: "bb_c",
      cwd: "/c",
    }),
  ]);

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored, {
    existing: { serverName: "bb_existing", cwd: "/existing" },
    "session-a": { serverName: "bb_a", cwd: "/a" },
    "session-b": { serverName: "bb_b", cwd: "/b" },
    "session-c": { serverName: "bb_c", cwd: "/c" },
  });

  await Promise.all([
    server.forgetMcpRegistration("session-a"),
    server.forgetMcpRegistration("session-b"),
  ]);
  const remaining = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(remaining, {
    existing: { serverName: "bb_existing", cwd: "/existing" },
    "session-c": { serverName: "bb_c", cwd: "/c" },
  });
});

test("caches the command catalog until a command.updated event", async () => {
  let calls = 0;
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      command: {
        list: async () => {
          calls += 1;
          return {
            data: [
              { name: "init", description: "guided setup" },
              { name: "review" },
            ],
          };
        },
      },
    }),
  });

  assert.deepEqual(await server.commands("/repo"), [
    { name: "init", description: "guided setup" },
    { name: "review", description: "" },
  ]);
  await server.commands("/repo");
  assert.equal(calls, 1);

  await server.handleEvent({ type: "command.updated", data: {} });
  await server.commands("/repo");
  assert.equal(calls, 2);
});

test("forwards archive state and consumes its own archive event", async () => {
  const updates: Record<string, unknown>[] = [];
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      session: {
        update: async (input: Record<string, unknown>) => {
          updates.push(input);
        },
      },
    }),
  });
  const session = createTestSession({
    bbThreadId: "bb-archive",
    providerThreadId: "ses_archive",
  });
  sessionsByProviderId.set(session.providerThreadId, session);
  try {
    await server.setSessionArchived(session.providerThreadId, true);
    assert.deepEqual(updates, [{ sessionID: "ses_archive", archived: true }]);

    // The event caused by BB's own update must not look like an external
    // archive to the lifecycle handler.
    await server.handleEvent({
      type: "session.archived",
      data: { sessionID: session.providerThreadId },
    });
    assert.equal(session.terminalError, undefined);

    // Unarchiving through BB clears the externally archived state directly.
    session.terminalError = ARCHIVED_SESSION_MESSAGE;
    session.terminalKind = "archived";
    await server.setSessionArchived(session.providerThreadId, false);
    assert.equal(session.terminalError, undefined);
    assert.equal(session.terminalKind, undefined);
  } finally {
    sessionsByProviderId.delete(session.providerThreadId);
  }
});

test("backgrounds the OpenCode session for a live or persisted thread", async () => {
  const calls: string[] = [];
  const server = new OpenCodeServer();
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      session: {
        background: async ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID);
        },
      },
    }),
  });
  sessions.clear();
  sessions.set(
    "thr_live",
    createTestSession({ bbThreadId: "thr_live", providerThreadId: "ses_live" }),
  );
  try {
    assert.deepEqual(await server.backgroundSession("thr_live"), { ok: true });
  } finally {
    sessions.clear();
  }
  assert.deepEqual(calls, ["ses_live"]);
});

test("stops running background shells and child sessions once", async () => {
  const removed: string[] = [];
  const interrupted: string[] = [];
  const closed: string[] = [];
  const server = new OpenCodeServer();
  const tasks = new Map([
    [
      "bg:shell",
      {
        id: "bg:shell",
        kind: "shell",
        shellId: "shell_1",
        settled: false,
      },
    ],
    [
      "bg:child",
      {
        id: "bg:child",
        kind: "subagent",
        childSessionId: "ses_child",
        settled: false,
      },
    ],
  ]);
  const session = createTestSession({
    providerThreadId: "ses_parent",
    backgroundTasks: tasks as unknown as Map<string, BackgroundTaskRecord>,
  });
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      shell: {
        remove: async ({ id }: { id: string }) => {
          removed.push(id);
        },
      },
      session: {
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          interrupted.push(sessionID);
        },
      },
    }),
    eventRouter: {
      interruptBackgroundTasks: (_session: SessionState, reason: string) => {
        closed.push(reason);
        for (const task of tasks.values()) task.settled = true;
      },
    },
  });

  await server.stopBackgroundTasks(session);
  await server.stopBackgroundTasks(session);

  assert.deepEqual(removed, ["shell_1"]);
  assert.deepEqual(interrupted, ["ses_child"]);
  assert.deepEqual(closed, ["Thread stopped"]);
});

test("backgrounds a thread from the persisted session registry", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "opencode2-background-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  await server.rememberSessionRegistration("thr_persisted", {
    providerThreadId: "ses_persisted",
    cwd: "/repo",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  });
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      session: {
        background: async ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID);
        },
      },
    }),
  });

  assert.deepEqual(await server.backgroundSession("thr_persisted"), {
    ok: true,
  });
  assert.deepEqual(calls, ["ses_persisted"]);
});
