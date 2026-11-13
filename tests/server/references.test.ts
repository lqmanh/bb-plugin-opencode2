import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../src/server/index.ts";
import { encodeReferenceId } from "../../src/shared/references.ts";

const docsId = encodeReferenceId({
  hostId: "host_1",
  directory: "/repo",
  alias: "docs",
});

const references = [
  {
    name: "docs",
    path: "/refs/docs",
    description: "Product docs",
  },
  {
    name: "guides",
    path: "/refs/guides",
    description: "How-to guides",
  },
  {
    name: "secret",
    path: "/refs/secret",
    hidden: true,
  },
];

async function loadProvider(options: {
  threadProvider?: string;
  threadHost?: string | null;
  threadPath?: string | null;
  projectSources?: Array<{
    hostId: string;
    path: string;
    isDefault: boolean;
  }>;
  host?: (call: ExperimentalFakeHostRpcCall) => unknown;
}) {
  const hostCalls: ExperimentalFakeHostRpcCall[] = [];
  const threadCalls: unknown[] = [];
  const fake = createFakePluginHost({
    pluginId: "opencode2",
    sdk: {
      threads: {
        list: (async (input: unknown) => {
          threadCalls.push(input);
          return [
            {
              providerId: options.threadProvider ?? "opencode2",
              environmentHostId: options.threadHost ?? "host_1",
              environmentPath: options.threadPath ?? "/repo",
            },
          ];
        }) as never,
      },
      projects: {
        get: (async () => ({
          id: "proj_1",
          sources: options.projectSources ?? [
            { hostId: "host_1", path: "/project", isDefault: true },
          ],
        })) as never,
      },
    },
    experimental_callHostRpc: async (call) => {
      hostCalls.push(call);
      if (options.host) return options.host(call);
      return { references };
    },
  });
  await plugin(fake.bb);
  const provider = fake.harness.registrations.mentionProviders.find(
    (item) => item.id === "reference",
  );
  assert.ok(provider, "reference mention provider is registered");
  assert.deepEqual(provider.triggers, ["@"]);
  return { provider, hostCalls, threadCalls };
}

test("lists visible references for an OpenCode thread", async () => {
  const { provider, hostCalls } = await loadProvider({});
  const context = {
    trigger: "@" as const,
    projectId: "proj_1",
    threadId: "thr_1",
  };
  const items = await provider.search({ ...context, query: "doc" });

  assert.deepEqual(items, [
    {
      id: docsId,
      title: "docs",
      subtitle: "Product docs",
    },
  ]);
  assert.deepEqual(
    (await provider.search({ ...context, query: "product" })).map(
      (item) => item.title,
    ),
    ["docs"],
  );
  assert.equal(hostCalls.length, 2);
  assert.equal(hostCalls[0]?.hostId, "host_1");
  assert.deepEqual(hostCalls[0]?.input, { directory: "/repo" });
});

test("lists visible references for a new thread from the default project source", async () => {
  const { provider, hostCalls, threadCalls } = await loadProvider({
    projectSources: [
      { hostId: "host_2", path: "/other", isDefault: false },
      { hostId: "host_1", path: "/default", isDefault: true },
    ],
  });
  const items = await provider.search({
    trigger: "@",
    query: "",
    projectId: "proj_1",
    threadId: null,
  });

  assert.deepEqual(
    items.map((item) => item.title),
    ["docs", "guides"],
  );
  assert.equal(threadCalls.length, 0);
  assert.equal(hostCalls[0]?.hostId, "host_1");
  assert.deepEqual(hostCalls[0]?.input, { directory: "/default" });
});

test("lists nothing for an existing thread on another provider", async () => {
  const { provider, hostCalls } = await loadProvider({
    threadProvider: "codex",
  });
  const items = await provider.search({
    trigger: "@",
    query: "",
    projectId: "proj_1",
    threadId: "thr_1",
  });

  assert.deepEqual(items, []);
  assert.equal(hostCalls.length, 0);
});

test("returns no items when the host fails", async () => {
  const { provider } = await loadProvider({
    host: () => {
      throw new Error("host offline");
    },
  });
  assert.deepEqual(
    await provider.search({
      trigger: "@",
      query: "",
      projectId: "proj_1",
      threadId: "thr_1",
    }),
    [],
  );
});

test("resolves a reference to alias, path, and description", async () => {
  const { provider, hostCalls } = await loadProvider({
    host: () => ({
      reference: {
        name: "docs",
        path: "/refs/docs",
        description: "Product docs",
      },
    }),
  });
  const result = await provider.resolve(docsId);

  assert.match(result.context, /OpenCode reference @docs/);
  assert.match(result.context, /Path: \/refs\/docs/);
  assert.match(result.context, /Description: Product docs/);
  assert.deepEqual(hostCalls[0]?.input, {
    directory: "/repo",
    alias: "docs",
  });
});

test("returns a not-found note when the reference is gone or resolve fails", async () => {
  const missing = await loadProvider({
    host: () => ({ reference: null }),
  });
  assert.match(
    (await missing.provider.resolve(docsId)).context,
    /reference @docs was not found/i,
  );

  const failed = await loadProvider({
    host: () => {
      throw new Error("host offline");
    },
  });
  assert.match(
    (await failed.provider.resolve(docsId)).context,
    /reference @docs was not found/i,
  );

  const malformed = await loadProvider({});
  assert.match(
    (await malformed.provider.resolve("not-a-reference")).context,
    /reference was not found/i,
  );
  assert.equal(malformed.hostCalls.length, 0);
});
