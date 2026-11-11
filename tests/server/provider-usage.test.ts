import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { OpenCodeClient } from "@opencode/client";
import {
  createFakePluginHost,
  makeHostResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { createFakeOpenCodeClient } from "../support/opencode-client.fixture.ts";
import plugin from "../../src/server/index.ts";
import { immediate } from "../support/async.ts";
import {
  aggregateUsageSnapshots,
  getProviderUsage,
  listProviderUsage,
  providerUsageAggregate,
  usageSourceStatus,
} from "../../src/host/opencode/opencode-usage.ts";
import {
  parseUsageResourceId,
  providerUsageRpcContract,
  usageResourceFromSnapshot,
  usageResourceId,
  usageResources,
  type ProviderUsageResourcePayload,
} from "../../src/server/provider-usage.ts";
import {
  OPENCODE_PROVIDER_ID,
  type UsageErrorCode,
  type UsageSnapshot,
} from "../../src/shared/settings-contract.ts";

type RpcCall = {
  rpcID: string;
  method: string;
  location?: { directory?: string };
  input?: unknown;
};

const providers = [
  {
    providerID: "anthropic",
    providerName: "Anthropic",
    accountLabel: "a@example.com",
    accountKey: "anthropic:a",
  },
  { providerID: "openai", providerName: "OpenAI", accountKey: null },
];

const usagePlugin = {
  id: "opencode-usage",
  source: { type: "package", target: "opencode-usage", version: "1.2.3" },
  features: { rpc: true },
  state: { status: "active" },
};

const rpcNotRegistered = {
  type: "rpc.unavailable",
  message: "RPC is unavailable: opencode-usage",
};

type FakeApiOptions = {
  plugins?: unknown[] | ((call: number) => unknown[]);
  pluginError?: unknown;
  output?: unknown;
  rpcError?: unknown | ((call: number) => unknown);
};

function fakeApi(options: FakeApiOptions): {
  api: () => Promise<OpenCodeClient>;
  pluginCalls: unknown[];
  rpcCalls: RpcCall[];
} {
  const pluginCalls: unknown[] = [];
  const rpcCalls: RpcCall[] = [];
  const client = createFakeOpenCodeClient({
    plugin: {
      list: async (input: unknown) => {
        const call = pluginCalls.length;
        pluginCalls.push(input);
        if (options.pluginError !== undefined) throw options.pluginError;
        const plugins =
          typeof options.plugins === "function"
            ? options.plugins(call)
            : (options.plugins ?? []);
        return { data: plugins };
      },
    },
    rpc: {
      call: async (input: RpcCall) => {
        const call = rpcCalls.length;
        rpcCalls.push(input);
        const error =
          typeof options.rpcError === "function"
            ? options.rpcError(call)
            : options.rpcError;
        if (error !== undefined) throw error;
        return { output: options.output };
      },
    },
  });
  return { api: async () => client, pluginCalls, rpcCalls };
}

function sourceStatus(options: FakeApiOptions, cwd = "/repo") {
  return usageSourceStatus(fakeApi(options).api, cwd);
}

/** Run a call through its retry delays under fake timers. */
async function drainRetries<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  pending.then(done, done);
  for (let attempt = 0; attempt < 50; attempt++) {
    await immediate();
    if (settled) break;
    mock.timers.tick(1_000);
  }
  return pending;
}

async function withMockTimers<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    return await run();
  } finally {
    mock.timers.reset();
  }
}

function retryWithMockTimers<T>(run: () => Promise<T>): Promise<T> {
  return withMockTimers(() => drainRetries(run()));
}

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    providerID: "anthropic",
    providerName: "Anthropic",
    accountLabel: "a@example.com",
    accountKey: "anthropic:a",
    fetchedAt: 1234,
    windows: [
      {
        id: "rolling",
        label: "5h",
        percent: 42,
        resetsAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function usageError(code: UsageErrorCode, message: string): UsageSnapshot {
  return snapshot({ error: { code, message } });
}

test("lists providers without fetching quota and reports unusable plugins", async () => {
  const list = fakeApi({ output: { providers } });

  assert.deepEqual(await listProviderUsage(list.api, "/repo"), {
    available: true,
    providers,
  });
  assert.deepEqual(list.rpcCalls, [
    {
      rpcID: "opencode-usage",
      method: "list",
      location: { directory: "/repo" },
      input: {},
    },
  ]);

  const failed = fakeApi({ rpcError: new Error("rpc unavailable") });
  assert.equal((await listProviderUsage(failed.api, "/repo")).available, false);

  const invalid = fakeApi({
    output: { providers: [{ providerID: "anthropic" }] },
  });
  const result = await listProviderUsage(invalid.api, "/repo");
  assert.equal(result.available, false);
  assert.deepEqual(result.providers, []);
  assert.match(result.error ?? "", /invalid response/);
});

test("reports the opencode-usage source status", async () => {
  const cwd = "/usage-status";
  const active = fakeApi({ plugins: [usagePlugin], output: { providers } });
  assert.deepEqual(await usageSourceStatus(active.api, cwd), {
    status: "active",
    sourceType: "package",
    source: "opencode-usage",
    version: "1.2.3",
    providerCount: 2,
  });
  assert.deepEqual(active.pluginCalls, [{ location: { directory: cwd } }]);

  assert.deepEqual(
    await sourceStatus(
      { plugins: [usagePlugin], output: { providers: [] } },
      cwd,
    ),
    {
      status: "no_accounts",
      sourceType: "package",
      source: "opencode-usage",
      version: "1.2.3",
      providerCount: 0,
    },
  );

  assert.deepEqual(
    await sourceStatus(
      {
        plugins: [
          {
            ...usagePlugin,
            source: { type: "local", path: "/tmp/opencode-usage" },
          },
        ],
        output: { providers },
      },
      cwd,
    ),
    {
      status: "active",
      sourceType: "local",
      source: "/tmp/opencode-usage",
      providerCount: 2,
    },
  );

  assert.deepEqual(
    await retryWithMockTimers(() =>
      sourceStatus({ rpcError: rpcNotRegistered }, cwd),
    ),
    {
      status: "not_installed",
      providerCount: 0,
    },
  );

  const failed = await sourceStatus(
    {
      plugins: [usagePlugin],
      rpcError: { type: "internal", message: "quota backend down" },
    },
    cwd,
  );
  assert.partialDeepStrictEqual(failed, {
    status: "unavailable",
    sourceType: "package",
    version: "1.2.3",
    providerCount: 0,
  });
  assert.match(failed.error ?? "", /quota backend down/);
});

test("reports a custom usage implementation without plugin metadata", async () => {
  assert.deepEqual(await sourceStatus({ output: { providers } }), {
    status: "active",
    providerCount: 2,
  });

  const failed = await sourceStatus({
    rpcError: { type: "internal", message: "custom usage failed" },
  });
  assert.equal(failed.status, "unavailable");
});

test("treats a listed opencode-usage plugin as installed when its RPC fails", async () => {
  assert.partialDeepStrictEqual(
    await retryWithMockTimers(() =>
      sourceStatus(
        { plugins: [usagePlugin], rpcError: rpcNotRegistered },
        "/usage-listed",
      ),
    ),
    {
      status: "unavailable",
      sourceType: "package",
      version: "1.2.3",
    },
  );
});

test("does not retry invalid payloads or untyped failures", async () => {
  const plugins = [
    {
      id: "custom-usage",
      source: { type: "local", path: "/tmp/custom-usage" },
      features: { server: true },
      state: { status: "active" },
    },
  ];

  const invalidApi = fakeApi({ plugins, output: { invalid: true } });
  const invalid = await usageSourceStatus(invalidApi.api, "/usage-no-retry");
  assert.equal(invalid.status, "unavailable");
  assert.match(invalid.error ?? "", /invalid response/);
  assert.equal(invalidApi.rpcCalls.length, 1);

  const untypedApi = fakeApi({
    plugins,
    rpcError: new Error("fetch failed"),
  });
  const untyped = await usageSourceStatus(untypedApi.api, "/usage-no-retry");
  assert.equal(untyped.status, "unavailable");
  assert.match(untyped.error ?? "", /fetch failed/);
  assert.equal(untypedApi.rpcCalls.length, 1);
});

test("retries a cold rpc.unavailable after refreshing plugin metadata", async (t) => {
  const scenarios = [
    {
      name: "empty plugin list",
      api: () =>
        fakeApi({
          plugins: (call) => (call === 0 ? [] : [usagePlugin]),
          output: { providers },
          rpcError: (call: number) =>
            call === 0 ? rpcNotRegistered : undefined,
        }),
    },
    {
      name: "failed plugin lookup",
      api: () =>
        fakeApi({
          pluginError: new Error("plugin list failed"),
          output: { providers },
          rpcError: (call: number) =>
            call === 0 ? rpcNotRegistered : undefined,
        }),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const api = scenario.api();
      assert.partialDeepStrictEqual(
        await retryWithMockTimers(() =>
          usageSourceStatus(api.api, `/cold-${scenario.name}`),
        ),
        { status: "active", providerCount: 2 },
      );
      assert.equal(api.rpcCalls.length, 2);
    });
  }
});

test("stops on a listed usage plugin that failed", async () => {
  const api = fakeApi({
    plugins: [
      {
        ...usagePlugin,
        state: { status: "failed", error: "usage plugin crashed" },
      },
    ],
    rpcError: rpcNotRegistered,
  });

  assert.partialDeepStrictEqual(await usageSourceStatus(api.api, "/failed"), {
    status: "unavailable",
    error: "usage plugin crashed",
  });
  assert.equal(api.rpcCalls.length, 0);
});

test("suppresses retries per cwd for 5 minutes", () =>
  withMockTimers(async () => {
    const cwd = "/usage-retry-cache";
    const settings = fakeApi({ plugins: [], rpcError: rpcNotRegistered });
    assert.deepEqual(await drainRetries(usageSourceStatus(settings.api, cwd)), {
      status: "not_installed",
      providerCount: 0,
    });
    assert.ok(settings.rpcCalls.length > 1);

    // The bridge usage path shares the suppression.
    const bridge = fakeApi({ rpcError: rpcNotRegistered });
    assert.deepEqual(await providerUsageAggregate(bridge.api, cwd), {
      supported: false,
    });
    assert.equal(bridge.rpcCalls.length, 1);

    mock.timers.tick(5 * 60_000 + 1);
    const refreshed = fakeApi({ rpcError: rpcNotRegistered });
    assert.deepEqual(
      await drainRetries(providerUsageAggregate(refreshed.api, cwd)),
      {
        supported: false,
      },
    );
    assert.ok(refreshed.rpcCalls.length > 1);
  }));

test("gets one snapshot, propagates bypassCache, and rejects unusable responses", async () => {
  const get = fakeApi({ output: { providers: [snapshot()] } });

  assert.deepEqual(
    await getProviderUsage(get.api, "anthropic", {
      bypassCache: true,
      cwd: "/repo",
    }),
    snapshot(),
  );
  assert.deepEqual(get.rpcCalls[0].input, {
    providerID: "anthropic",
    bypassCache: true,
  });

  const invalid = fakeApi({
    output: { providers: [{ providerID: "anthropic" }] },
  });
  await assert.rejects(
    getProviderUsage(invalid.api, "anthropic"),
    /invalid response/,
  );

  const missing = fakeApi({ output: { providers: [snapshot()] } });
  await assert.rejects(
    getProviderUsage(missing.api, "openai"),
    /no longer available/,
  );
});

test("aggregates compatibility usage for all provider states", async () => {
  assert.deepEqual(aggregateUsageSnapshots([]), { supported: false });

  assert.deepEqual(
    aggregateUsageSnapshots([
      snapshot(),
      usageError("failed", "quota endpoint failed"),
    ]),
    {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: "OpenCode",
        windows: [
          {
            label: "Anthropic · 5h",
            usedPercent: 42,
            resetsAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
  );

  assert.deepEqual(
    aggregateUsageSnapshots([usageError("expired", "expired")]),
    {
      supported: true,
      usage: { status: "expired" },
    },
  );
  assert.deepEqual(
    aggregateUsageSnapshots([usageError("unavailable", "logged out")]),
    { supported: true, usage: { status: "unauthenticated" } },
  );
  assert.deepEqual(
    aggregateUsageSnapshots([
      usageError("failed", "one"),
      usageError("unavailable", "two"),
    ]),
    {
      supported: true,
      usage: {
        status: "error",
        accountEmail: null,
        planLabel: "OpenCode",
        message: "one; two",
      },
    },
  );

  const success = fakeApi({ output: { providers: [snapshot()] } });
  assert.equal((await providerUsageAggregate(success.api)).supported, true);
  assert.deepEqual(success.rpcCalls[0].input, {});

  const unavailable = fakeApi({ rpcError: true });
  assert.deepEqual(await providerUsageAggregate(unavailable.api), {
    supported: false,
  });

  const invalid = fakeApi({
    output: { providers: [{ providerID: "anthropic" }] },
  });
  assert.deepEqual(await providerUsageAggregate(invalid.api), {
    supported: false,
  });
});

test("maps listed providers to shared resources with round-trippable ids", () => {
  assert.deepEqual(Object.keys(providerUsageRpcContract), [
    "provider-usage.v1.listResources",
    "provider-usage.v1.getResource",
  ]);

  const resources = usageResources([
    { hostId: "host_1", usage: { available: false, providers: [] } },
    { hostId: "host_2", usage: { available: true, providers } },
  ]);

  assert.deepEqual(resources, [
    {
      id: usageResourceId("host_2", "anthropic"),
      providerId: OPENCODE_PROVIDER_ID,
      label: "Anthropic",
      accountKey: "anthropic:a",
      scope: { kind: "shared" },
    },
    {
      id: usageResourceId("host_2", "openai"),
      providerId: OPENCODE_PROVIDER_ID,
      label: "OpenAI",
      accountKey: null,
      scope: { kind: "shared" },
    },
  ]);

  const id = usageResourceId("host_2", "anthropic");
  assert.deepEqual(parseUsageResourceId(id), {
    hostId: "host_2",
    providerID: "anthropic",
  });
  assert.equal(parseUsageResourceId("not json"), undefined);
  assert.equal(parseUsageResourceId(JSON.stringify(["host_2"])), undefined);
});

test("maps snapshots to source usage windows and errors", () => {
  const resource = usageResourceFromSnapshot(
    snapshot({
      windows: [
        {
          id: "rolling",
          label: "5h",
          percent: 42,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "weekly",
          label: "1w",
          percent: 10,
          resetsAt: "2026-01-07T00:00:00.000Z",
        },
        {
          id: "monthly",
          label: "1mo",
          percent: 1,
          resetsAt: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "weekly",
          label: "2w",
          percent: 5,
          resetsAt: "2026-01-15T00:00:00.000Z",
        },
        {
          id: "rolling",
          label: "2h",
          percent: 6,
          resetsAt: "2026-01-01T02:00:00.000Z",
        },
        {
          id: "rolling",
          label: "1d",
          percent: 7,
          resetsAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    }),
  );

  assert.equal(resource.accountKey, "anthropic:a");
  assert.equal(resource.observedAt, 1234);
  assert.equal(resource.usage.status, "ok");
  if (resource.usage.status !== "ok") return;
  assert.equal(resource.usage.planLabel, "a@example.com");
  assert.deepEqual(
    resource.usage.windows.map((window) => [window.kind, window.label]),
    [
      ["five-hour", "5h"],
      ["weekly", "1w"],
      ["custom", "1mo"],
      ["custom", "2w"],
      ["custom", "2h"],
      ["daily", "1d"],
    ],
  );

  const errorResource = (code: UsageErrorCode, message: string) =>
    usageResourceFromSnapshot(usageError(code, message));

  assert.deepEqual(errorResource("expired", "expired"), {
    accountKey: "anthropic:a",
    observedAt: null,
    usage: {
      status: "expired",
      plan: null,
      accountEmail: null,
      planLabel: "a@example.com",
    },
  });
  assert.deepEqual(errorResource("unavailable", "logged out"), {
    accountKey: "anthropic:a",
    observedAt: null,
    usage: {
      status: "unauthenticated",
      plan: null,
      accountEmail: null,
      planLabel: "a@example.com",
    },
  });
  assert.deepEqual(errorResource("failed", "quota failed"), {
    accountKey: "anthropic:a",
    observedAt: null,
    usage: {
      status: "error",
      plan: null,
      accountEmail: null,
      planLabel: "a@example.com",
      message: "quota failed",
    },
  });
});

async function loadProvider(
  respond: (call: ExperimentalFakeHostRpcCall) => unknown,
) {
  const hostCalls: ExperimentalFakeHostRpcCall[] = [];
  const fake = createFakePluginHost({
    pluginId: "opencode2",
    experimental_callHostRpc: async (call) => {
      hostCalls.push(call);
      return respond(call);
    },
  });
  fake.harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: "host_1", name: "Host One", status: "connected" }),
  ]);
  await plugin(fake.bb);
  return { harness: fake.harness, hostCalls };
}

test("serves usage through the registered RPCs", async () => {
  const status = {
    status: "ready" as const,
    statusMessage: null,
    installedVersion: "2.2.7",
    latestVersion: "2.2.7",
    minimumSupportedVersion: "2.2.7",
    loginCommand: "opencode2 auth login",
  };
  const usage = {
    status: "active" as const,
    sourceType: "package" as const,
    source: "opencode-usage",
    version: "0.4.0",
    providerCount: 2,
  };
  const { harness, hostCalls } = await loadProvider((call) => {
    if (call.hostId === "host_missing") throw new Error("host is gone");
    switch (call.method) {
      case "usage/list":
        return { available: true, providers };
      case "usage/get":
        return snapshot();
      case "getStatus":
        return status;
      case "usage/status":
        return usage;
      default:
        assert.fail(`Unexpected method ${call.method}`);
    }
  });

  assert.equal(
    harness.registrations.providerRegistrations[0]?.maintenance?.usage,
    true,
  );
  assert.deepEqual(
    await harness.callRpc("provider-usage.v1.listResources", {}),
    {
      label: "OpenCode v2",
      resources: [
        {
          id: usageResourceId("host_1", "anthropic"),
          providerId: OPENCODE_PROVIDER_ID,
          label: "Anthropic",
          accountKey: "anthropic:a",
          scope: { kind: "shared" },
        },
        {
          id: usageResourceId("host_1", "openai"),
          providerId: OPENCODE_PROVIDER_ID,
          label: "OpenAI",
          accountKey: null,
          scope: { kind: "shared" },
        },
      ],
    },
  );
  assert.equal(hostCalls[0]?.hostId, "host_1");
  assert.deepEqual(hostCalls[0]?.input, {});

  const resource = (await harness.callRpc("provider-usage.v1.getResource", {
    resourceId: usageResourceId("host_1", "anthropic"),
    refresh: true,
  })) as ProviderUsageResourcePayload;
  assert.equal(resource.accountKey, "anthropic:a");
  assert.equal(resource.observedAt, 1234);
  assert.equal(resource.usage.status, "ok");
  if (resource.usage.status !== "ok") return;
  assert.deepEqual(resource.usage.windows[0], {
    kind: "five-hour",
    id: "rolling",
    label: "5h",
    usedPercent: 42,
    resetsAt: "2026-01-01T00:00:00.000Z",
    model: null,
    cost: null,
  });
  assert.deepEqual(hostCalls[1]?.input, {
    providerID: "anthropic",
    bypassCache: true,
  });

  await assert.rejects(
    harness.callRpc("provider-usage.v1.getResource", {
      resourceId: usageResourceId("host_missing", "anthropic"),
      refresh: false,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "not_found");
      assert.match((error as Error).message, /host is gone/);
      return true;
    },
  );

  assert.deepEqual(await harness.callRpc("getStatus", {}), {
    hosts: [
      {
        hostId: "host_1",
        hostName: "Host One",
        status,
        usage,
      },
    ],
  });

  const unavailable = await loadProvider(() => ({
    available: false,
    providers: [],
  }));
  assert.deepEqual(
    await unavailable.harness.callRpc("provider-usage.v1.listResources", {}),
    { resources: [] },
  );
});
