import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../src/server/index.ts";

async function loadProvider(
  options: Parameters<typeof createFakePluginHost>[0] = {},
) {
  const fake = createFakePluginHost({
    pluginId: "opencode2",
    experimental_hostEntry: true,
    ...options,
  });
  await plugin(fake.bb);
  return fake;
}

test("registers OpenCode v2 as an installed checkpoint-capable provider with every BB permission mode", async () => {
  const { harness } = await loadProvider();

  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  assert.ok(provider);
  assert.equal(provider.displayName, "OpenCode v2");
  assert.equal(provider.experimental_visibility, "installed");
  assert.equal(provider.capabilities.fork, "checkpoint");
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.equal(provider.capabilities.supportsThreadRename, true);
  assert.equal(provider.capabilities.supportsThreadArchive, true);
  assert.deepEqual(provider.composerActions, ["plan"]);
  assert.deepEqual(provider.capabilities.permissionModes, [
    "accept-edits",
    "auto",
    "full",
  ]);
  assert.deepEqual(harness.experimental_hostRpcCalls, []);
  const rpcMethods = harness.inspection.registrations.rpcMethods;
  assert.ok(rpcMethods.includes("getStatus"));
  assert.ok(!rpcMethods.includes("getModelSelection"));
  assert.ok(!rpcMethods.includes("saveModelSelection"));
  assert.deepEqual(harness.inspection.registrations.services, []);
  assert.deepEqual(provider.capabilities.reasoningLevels, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("derives provider options from the subagent setting", async () => {
  const { harness } = await loadProvider();

  const provider = harness.inspection.registrations.providerRegistrations.find(
    (registration) => registration.id === "opencode2",
  );
  assert.ok(provider?.deriveProviderOptions);
  assert.deepEqual(
    provider.deriveProviderOptions({
      threadId: "thread_1",
      projectId: "project_1",
      model: "openai/gpt-5",
      permissionMode: "auto",
      settings: { subagentsDisabled: true },
    }),
    { disableSubagents: true },
  );
});

test("registers the background action RPC and routes it to the thread host", async () => {
  const { harness } = await loadProvider({
    sdk: {
      threads: {
        list: (async () => [
          {
            id: "thr_1",
            providerId: "opencode2",
            environmentHostId: "host_1",
          },
        ]) as never,
      },
    },
    experimental_callHostRpc: () => ({ ok: true }),
  });

  assert.ok(
    harness.inspection.registrations.rpcMethods.includes("backgroundThread"),
  );
  assert.deepEqual(
    await harness.behavior.callRpc("backgroundThread", { threadId: "thr_1" }),
    { ok: true },
  );
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
  assert.equal(
    harness.inspection.experimental_hostRpcCalls[0].method,
    "backgroundSession",
  );
  assert.deepEqual(harness.inspection.experimental_hostRpcCalls[0].input, {
    threadId: "thr_1",
  });
  assert.equal(
    harness.inspection.experimental_hostRpcCalls[0].hostId,
    "host_1",
  );
});
