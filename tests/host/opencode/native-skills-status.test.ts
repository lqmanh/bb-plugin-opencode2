import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retryWithMockTimers } from "../../support/async.ts";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import { OpenCodeServer } from "../../support/host-api.js";
import {
  bbSkillsPluginPackage,
  nativeSkillsLocationsDir,
} from "../../../src/host/opencode/native-skills.ts";

const expectedPackage = bbSkillsPluginPackage();
const activePlugin = {
  id: "opencode-bb-skills",
  source: { type: "package", target: expectedPackage, version: "1.6.0" },
  features: { server: true },
  state: { status: "active" },
};
const configEntry = (
  packageSpec = expectedPackage,
  locationsDir = "/expected",
) => ({
  package: packageSpec,
  options: { locationsDir },
});

type Config = { plugins: unknown[] };

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  config?: Config | ((locationsDir: string) => Config),
) {
  const root = await mkdtemp(join(tmpdir(), "native-skills-status-"));
  const configDir = join(root, "opencode");
  const dataDir = join(root, "data");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const locationsDir = nativeSkillsLocationsDir(dataDir);
  const value = typeof config === "function" ? config(locationsDir) : config;
  if (value !== undefined)
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify(value),
      "utf8",
    );
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    delete process.env.BB_OPENCODE_BB_SKILLS_PACKAGE;
    await rm(root, { recursive: true, force: true });
  });
  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  return { server, locationsDir };
}

function fakeApi(plugins: unknown[]) {
  return createFakeOpenCodeApi({
    plugin: { list: async () => ({ data: plugins }) },
  });
}

test("reports config statuses without a plugin lookup", async (t) => {
  const { server } = await fixture(t);
  Object.assign(server, {
    api: async () => {
      throw new Error("plugin list should not run");
    },
  });
  assert.deepEqual(await server.nativeSkillsStatus(), {
    status: "not_configured",
    packageSpec: expectedPackage,
    version: "1.6.0",
  });

  const outdated = await fixture(t, (dir: string) => ({
    plugins: [
      configEntry(
        "github:lqmanh/bb-plugin-opencode2#v1.0.0::path:opencode-bb-skills",
        dir,
      ),
    ],
  }));
  assert.partialDeepStrictEqual(await outdated.server.nativeSkillsStatus(), {
    status: "outdated",
    configuredPackage:
      "github:lqmanh/bb-plugin-opencode2#v1.0.0::path:opencode-bb-skills",
    packageSpec: expectedPackage,
  });

  const stale = await fixture(t, {
    plugins: [configEntry(expectedPackage, "/stale")],
  });
  assert.partialDeepStrictEqual(await stale.server.nativeSkillsStatus(), {
    status: "outdated",
    configuredLocationsDir: "/stale",
    locationsDir: stale.locationsDir,
  });
});

test("reports active and failed plugins", async (t) => {
  const { server } = await fixture(t, (dir: string) => ({
    plugins: [configEntry(expectedPackage, dir)],
  }));
  Object.assign(server, { api: fakeApi([activePlugin]) });
  assert.deepEqual(await server.nativeSkillsStatus(), {
    status: "active",
    packageSpec: expectedPackage,
    version: "1.6.0",
  });

  const failed = await fixture(t, (dir: string) => ({
    plugins: [configEntry(expectedPackage, dir)],
  }));
  Object.assign(failed.server, {
    api: fakeApi([
      {
        ...activePlugin,
        state: { status: "failed", error: "skills plugin crashed" },
      },
    ]),
  });
  assert.partialDeepStrictEqual(await failed.server.nativeSkillsStatus(), {
    status: "failed",
    error: "skills plugin crashed",
  });
});

test("reports not loaded after the cold retry", async (t) => {
  const { server } = await fixture(t, (dir: string) => ({
    plugins: [configEntry(expectedPackage, dir)],
  }));
  let calls = 0;
  Object.assign(server, {
    api: createFakeOpenCodeApi({
      plugin: {
        list: async () => {
          calls += 1;
          return { data: [] };
        },
      },
    }),
  });
  assert.partialDeepStrictEqual(
    await retryWithMockTimers(() => server.nativeSkillsStatus()),
    { status: "not_loaded" },
  );
  assert.equal(calls, 5);
});

test("a development override skips the outdated check", async (t) => {
  process.env.BB_OPENCODE_BB_SKILLS_PACKAGE = "/tmp/dev-skills";
  const { server } = await fixture(t, {
    plugins: [configEntry("/tmp/dev-skills", "/stale")],
  });
  Object.assign(server, {
    api: fakeApi([
      {
        ...activePlugin,
        source: { type: "package", target: "/tmp/dev-skills" },
      },
    ]),
  });
  assert.deepEqual(await server.nativeSkillsStatus(), {
    status: "active",
    packageSpec: "/tmp/dev-skills",
  });
});
