import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseSessionTools,
  removeMcpServers,
} from "../../support/host-api.js";
import { createFakeOpenCodeClient } from "../../support/opencode-client.fixture.ts";
import { createTestSession } from "../../support/session.fixture.ts";
import type { OpenCodeRecord, SessionState } from "../../../src/host/types.ts";

function fakeSession(id: string): SessionState {
  return createTestSession({
    bbThreadId: `thr_${id}`,
    providerThreadId: id,
    cwd: `/repo/${id}`,
  });
}

function fakeProxy(serverName: string, close: () => void) {
  return { serverName, config: {} as never, close };
}

test("releaseSessionTools swallows a failed removal", async () => {
  const events: string[] = [];
  const session = fakeSession("ses_1");
  session.dynamicToolProxy = fakeProxy("bb_1", () => events.push("close"));

  const removed = await releaseSessionTools(session, "replaced", async () => {
    events.push("api");
    return createFakeOpenCodeClient({
      experimental: {
        mcp: {
          remove: async () => {
            events.push("remove");
            throw new Error("server is gone");
          },
        },
      },
    });
  });

  assert.equal(removed, false);
  assert.deepEqual(events, ["close", "api", "remove"]);
  assert.equal(session.dynamicToolProxy, undefined);
});

test("removeMcpServers runs removals in parallel and keeps only successful IDs", async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const servers = ["ses_a", "ses_b", "ses_c"].map((providerThreadId) => ({
    providerThreadId,
    serverName: `bb_${providerThreadId}`,
    cwd: "/repo",
  }));
  const client = createFakeOpenCodeClient({
    experimental: {
      mcp: {
        remove: async (
          input: OpenCodeRecord,
          options?: { signal?: AbortSignal },
        ) => {
          started.push(input.server);
          assert.ok(options?.signal instanceof AbortSignal);
          if (input.server === "bb_ses_a") await firstGate;
          if (input.server === "bb_ses_b") throw new Error("server is gone");
        },
      },
    },
  });

  const removing = removeMcpServers(client, servers);

  // All removals start before the first one resolves: one batch, not a loop.
  assert.deepEqual(started.sort(), ["bb_ses_a", "bb_ses_b", "bb_ses_c"]);

  releaseFirst();
  assert.deepEqual(await removing, ["ses_a", "ses_c"]);
});
