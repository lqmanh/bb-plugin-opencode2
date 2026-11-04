// The native-skills view is a local, BB-owned catalog the OpenCode plugin reads.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BB_PLUGIN_VERSION,
  bbSkillsPluginPackage,
  buildNativeSkillCatalog,
  isBbSkillsPluginPackage,
  nativeSkillsLocationsDir,
  nativeSkillsRoot,
  OpenCodeServer,
  removeNativeSkillsRoot,
  writeNativeSkillsLocation,
} from "../../support/host-api.js";

function skill(root: string, name: string, description: string, body = "body") {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

test("builds an effective catalog from every root, last description wins", async () => {
  const base = mkdtempSync(join(tmpdir(), "oc-native-skills-"));
  try {
    const first = join(base, "first");
    const second = join(base, "second");
    for (const [root, description] of [
      [first, "first description"],
      [second, "second description"],
    ] as const) {
      skill(root, "inline-vis", description);
      skill(root, "tasks", `${description} tasks`);
    }
    const workspace = join(base, "workspace");
    mkdirSync(workspace, { recursive: true });
    const catalog = await buildNativeSkillCatalog(workspace, [
      {
        id: "one",
        path: first,
        skills: [
          { name: "inline-vis", description: "first description" },
          { name: "tasks", description: "first description tasks" },
        ],
      },
      {
        id: "two",
        path: second,
        skills: [
          { name: "inline-vis", description: "second description" },
          { name: "missing", description: "missing" },
        ],
      },
    ]);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.location.directory, resolve(workspace));
    assert.equal(catalog.location.canonical, realpathSync(workspace));
    assert.deepEqual(
      catalog.skills.map((entry) => entry.name),
      ["inline-vis", "tasks"],
    );
    assert.equal(catalog.skills[0]?.description, "second description");
    assert.equal(catalog.skills[1]?.description, "first description tasks");
    assert.ok(catalog.skills.every((entry) => entry.path.endsWith("SKILL.md")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pins the plugin package to the BB version and path", () => {
  const packageSpec = bbSkillsPluginPackage({});
  assert.equal(
    packageSpec,
    `github:lqmanh/bb-plugin-opencode2#v${BB_PLUGIN_VERSION}::path:opencode-bb-skills`,
  );
  assert.equal(isBbSkillsPluginPackage(packageSpec), true);
  assert.equal(
    isBbSkillsPluginPackage(
      "github:lqmanh/bb-plugin-opencode2#main::path:opencode-bb-skills",
    ),
    true,
  );
  assert.equal(
    isBbSkillsPluginPackage("/Users/me/checkout/opencode-bb-skills"),
    true,
  );
  assert.equal(
    isBbSkillsPluginPackage("github:lqmanh/bb-plugin-opencode2#v1.4.0"),
    false,
  );
  assert.equal(isBbSkillsPluginPackage("github:acme/other"), false);
  assert.equal(
    bbSkillsPluginPackage({
      BB_OPENCODE_BB_SKILLS_PACKAGE: "/tmp/opencode-bb-skills",
    }),
    "/tmp/opencode-bb-skills",
  );
});

test("host and bridge workers share one catalog root", () => {
  const pluginRoot = join(tmpdir(), "oc-native-shared");
  assert.equal(
    nativeSkillsLocationsDir(join(pluginRoot, "host-data")),
    join(pluginRoot, "runtime", "opencode-bb-skills", "locations"),
  );
  assert.equal(
    nativeSkillsLocationsDir(join(pluginRoot, "bridge-data")),
    join(pluginRoot, "runtime", "opencode-bb-skills", "locations"),
  );
});

test("writes and removes a per-location catalog", async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), "oc-native-location-"));
  const dataDir = join(pluginRoot, "host-data");
  mkdirSync(dataDir, { recursive: true });
  try {
    const skills = join(pluginRoot, "skills");
    skill(skills, "review", "Review changes");
    const workspace = join(pluginRoot, "workspace");
    mkdirSync(workspace, { recursive: true });

    const names = await writeNativeSkillsLocation(dataDir, workspace, [
      {
        id: "one",
        path: skills,
        skills: [{ name: "review", description: "Review changes" }],
      },
    ]);
    assert.deepEqual(names, ["review"]);
    const files = readdirSync(nativeSkillsLocationsDir(dataDir));
    assert.equal(files.length, 1);
    const catalog = JSON.parse(
      readFileSync(join(nativeSkillsLocationsDir(dataDir), files[0]!), "utf8"),
    );
    assert.equal(catalog.location.canonical, realpathSync(workspace));
    assert.equal(catalog.skills[0].name, "review");

    await removeNativeSkillsRoot(dataDir);
    assert.throws(() => readdirSync(nativeSkillsRoot(dataDir)));
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("enabling writes one pinned object entry and disabling removes it", async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), "oc-native-enable-"));
  const dataDir = join(pluginRoot, "host-data");
  mkdirSync(dataDir, { recursive: true });
  const configHome = mkdtempSync(join(tmpdir(), "oc-native-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  const server = new OpenCodeServer();
  server.setDataDir(dataDir);
  try {
    const configPath = join(configHome, "opencode", "opencode.json");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(configPath, `{ "plugins": ["user-plugin"] }\n`);

    const enabled = await server.setNativeSkillsEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.error, undefined);
    assert.ok(enabled.packageSpec);
    assert.equal(
      enabled.locationsDir,
      join(pluginRoot, "runtime", "opencode-bb-skills", "locations"),
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.plugins, [
      "user-plugin",
      {
        package: enabled.packageSpec,
        options: { locationsDir: enabled.locationsDir },
      },
    ]);

    assert.equal(
      (await server.setNativeSkillsEnabled(true)).packageSpec,
      enabled.packageSpec,
    );
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).plugins.length,
      2,
    );

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          plugins: [
            "user-plugin",
            {
              package:
                "github:lqmanh/bb-plugin-opencode2#v1.3.0::path:opencode-bb-skills",
              options: { locationsDir: "/old/locations" },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await server.setNativeSkillsEnabled(true);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).plugins, [
      "user-plugin",
      {
        package: enabled.packageSpec,
        options: { locationsDir: enabled.locationsDir },
      },
    ]);

    const disabled = await server.setNativeSkillsEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).plugins, [
      "user-plugin",
    ]);
    assert.throws(() => readdirSync(nativeSkillsRoot(dataDir)));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("versioned package files move together", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  const pluginPackage = JSON.parse(
    readFileSync(
      new URL("../../../opencode-bb-skills/package.json", import.meta.url),
      "utf8",
    ),
  ) as { version?: unknown };
  assert.equal(rootPackage.version, BB_PLUGIN_VERSION);
  assert.equal(pluginPackage.version, BB_PLUGIN_VERSION);
});
