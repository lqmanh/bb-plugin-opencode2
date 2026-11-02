// The OpenCode global-config edit must be minimal and idempotent.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addBbToolsRule, ensureBbToolsRule } from "../../support/host-api.js";

const RULE =
  '{ "action": "bb_opencode2_*", "resource": "*", "effect": "deny" }';

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
    assert.equal(added.split(RULE).length, 2);
    if (!name.startsWith("jsonc")) {
      const parsed = JSON.parse(added);
      assert.deepEqual(parsed.permissions.at(-1), {
        action: "bb_opencode2_*",
        resource: "*",
        effect: "deny",
      });
      const { permissions: _, ...rest } = parsed;
      const { permissions: __, ...before } = JSON.parse(original);
      assert.deepEqual(rest, before);
    }
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
