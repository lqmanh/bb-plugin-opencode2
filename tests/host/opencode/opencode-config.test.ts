// The OpenCode global-config edit must be minimal and idempotent.
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  addBbToolsRule,
  bbSkillsPluginPackage,
  ensureBbToolsRule,
  ensurePluginEntry,
  isBbSkillsPluginPackage,
  removePluginEntries,
  removePluginEntriesFromConfig,
  upsertPluginEntry,
} from "../../support/host-api.js";

const cases: Record<string, string> = {
  "no permissions key": `{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": "notify",
  "plugins": [],
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
  }
}
`,
  "existing rules": `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" }
  ],
  "autoupdate": true
}
`,
  "empty permissions": `{
  "permissions": [],
  "autoupdate": true
}
`,
  "jsonc with comments and trailing comma": `// my config
{
  /* keep me */
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }, // ask first
  ],
  "theme": "dark", // trailing
}
`,
  "jsonc object without permissions": `{
  // keep this comment
  "theme": "dark",
}
`,
  "empty object": "{}\n",
};

for (const [name, original] of Object.entries(cases)) {
  test(`adds one rule last: ${name}`, () => {
    const added = addBbToolsRule(original);
    assert.ok(added);
    // Only additions: every original character survives in order.
    let cursor = 0;
    for (const ch of original) {
      cursor = added.indexOf(ch, cursor);
      assert.notEqual(cursor, -1);
      cursor++;
    }
    const parsed = parse(added) as { permissions: unknown[] };
    assert.deepEqual(parsed.permissions.at(-1), {
      action: "bb_opencode2_*",
      resource: "*",
      effect: "deny",
    });
    const { permissions: _, ...rest } = parsed;
    const { permissions: __, ...before } = parse(original) as {
      permissions?: unknown;
    };
    assert.deepEqual(rest, before);
    assert.equal(addBbToolsRule(added), undefined, "idempotent");
  });
}

test("writes only on change and keeps the file mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-config-"));
  const path = join(dir, "opencode.json");
  const original = cases["no permissions key"];
  writeFileSync(path, original);
  chmodSync(path, 0o600);
  assert.equal(await ensureBbToolsRule(path), "added");
  assert.equal(await ensureBbToolsRule(path), "unchanged");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

const OLD_PACKAGE =
  "github:lqmanh/bb-plugin-opencode2#v1.3.0::path:opencode-bb-skills";
const PACKAGE = bbSkillsPluginPackage();
const ENTRY = {
  package: PACKAGE,
  options: {
    locationsDir: "/home/me/.bb/runtime/opencode-bb-skills/locations",
  },
};

test("adds an opencode-bb-skills object without disturbing existing plugin entries", () => {
  const original = `{
  "plugins": ["user-plugin", { "package": "acme", "options": { "strict": true } }],
  "theme": "dark"
}
`;
  const added = upsertPluginEntry(original, isBbSkillsPluginPackage, ENTRY);
  assert.ok(added);
  const parsed = JSON.parse(added);
  assert.deepEqual(parsed.plugins, [
    "user-plugin",
    { package: "acme", options: { strict: true } },
    ENTRY,
  ]);
  assert.equal(
    upsertPluginEntry(added, isBbSkillsPluginPackage, ENTRY),
    undefined,
    "idempotent",
  );
});

test("adds a plugins key when the config has none", () => {
  const added = upsertPluginEntry(
    `{ "theme": "dark" }\n`,
    isBbSkillsPluginPackage,
    ENTRY,
  );
  assert.ok(added);
  assert.deepEqual(JSON.parse(added).plugins, [ENTRY]);
});

test("replaces old string, object, and duplicate opencode-bb-skills entries", () => {
  const original = `{
  "plugins": [
    "${OLD_PACKAGE}",
    "user-plugin",
    { "package": "${OLD_PACKAGE}", "options": { "locationsDir": "/old" } },
    { "package": "${PACKAGE}", "options": { "locationsDir": "/old" } },
  ],
}
`;
  const added = upsertPluginEntry(original, isBbSkillsPluginPackage, ENTRY);
  assert.ok(added);
  const parsed = parse(added) as { plugins: unknown[] };
  assert.deepEqual(parsed.plugins, ["user-plugin", ENTRY]);
  assert.equal(
    upsertPluginEntry(added, isBbSkillsPluginPackage, ENTRY),
    undefined,
  );
});

test("parses and replaces a commented object entry", () => {
  const original = `{
  // keep this comment
  "plugins": [
    /* old opencode-bb-skills entry */
    {
      "package": "${OLD_PACKAGE}", // pinned by an older version of this plugin
      "options": { "locationsDir": "/old/locations" },
    },
    "user-plugin",
  ],
}
`;
  const added = upsertPluginEntry(original, isBbSkillsPluginPackage, ENTRY);
  assert.ok(added);
  assert.match(added, /keep this comment/);
  assert.doesNotMatch(added, /v1\.3\.0/);
  assert.match(added, /user-plugin/);
  const parsed = parse(added) as { plugins: unknown[] };
  assert.deepEqual(parsed.plugins, [ENTRY, "user-plugin"]);
});

test("removes only the opencode-bb-skills entry and leaves other plugins", () => {
  const original = `{
  "plugins": [
    "${OLD_PACKAGE}",
    { "package": "acme", "options": { "strict": true } },
    "github:lqmanh/bb-plugin-opencode2#v1.4.0",
    "user-plugin",
  ],
}
`;
  const removed = removePluginEntries(original, isBbSkillsPluginPackage);
  assert.ok(removed);
  assert.doesNotMatch(removed, /opencode-bb-skills/);
  assert.match(removed, /github:lqmanh\/bb-plugin-opencode2#v1\.4\.0/);
  assert.match(removed, /acme/);
  assert.match(removed, /user-plugin/);
  assert.equal(
    removePluginEntries(removed, isBbSkillsPluginPackage),
    undefined,
  );
});

test("preserves comments around removed plugin entries", () => {
  const original = `{
  "plugins": [
    "${OLD_PACKAGE}",
    /* keep next */ { "package": "acme", "options": { "strict": true } },
  ],
}
`;
  const removed = removePluginEntries(original, isBbSkillsPluginPackage);
  assert.ok(removed);
  assert.match(removed, /keep next/);
  assert.doesNotMatch(removed, /opencode-bb-skills/);
});

test("replaces or removes the only plugin entry without leaving invalid JSON", () => {
  const added = upsertPluginEntry(
    `{ "plugins": ["${OLD_PACKAGE}"] }\n`,
    isBbSkillsPluginPackage,
    ENTRY,
  );
  assert.ok(added);
  assert.deepEqual(JSON.parse(added).plugins, [ENTRY]);
  const removed = removePluginEntries(added, isBbSkillsPluginPackage);
  assert.ok(removed);
  assert.deepEqual(JSON.parse(removed).plugins, []);
});

test("rejects invalid JSON and non-array config values", () => {
  assert.throws(() => addBbToolsRule(`{ "permissions": [`), /not valid JSON/);
  assert.throws(
    () => addBbToolsRule(`{ "permissions": {} }`),
    /non-array permissions/,
  );
  assert.throws(
    () =>
      upsertPluginEntry(
        `{ "plugins": "user-plugin" }`,
        isBbSkillsPluginPackage,
        ENTRY,
      ),
    /non-array plugins/,
  );
  assert.equal(
    removePluginEntries(
      `{ "plugins": "user-plugin" }`,
      isBbSkillsPluginPackage,
    ),
    undefined,
  );
});

test("ensurePluginEntry writes only on change and remove cleans up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-plugins-"));
  const path = join(dir, "opencode.json");
  try {
    writeFileSync(path, `{ "plugins": ["user-plugin", "${OLD_PACKAGE}"] }\n`);
    assert.equal(
      await ensurePluginEntry(path, isBbSkillsPluginPackage, ENTRY),
      "changed",
    );
    assert.equal(
      await ensurePluginEntry(path, isBbSkillsPluginPackage, ENTRY),
      "unchanged",
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).plugins, [
      "user-plugin",
      ENTRY,
    ]);
    assert.equal(
      await removePluginEntriesFromConfig(path, isBbSkillsPluginPackage),
      "removed",
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).plugins, [
      "user-plugin",
    ]);
    assert.equal(
      await removePluginEntriesFromConfig(path, isBbSkillsPluginPackage),
      "unchanged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
