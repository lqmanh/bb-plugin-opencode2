import type { Plugin, Skill } from "@opencode/plugin";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBbSkillsPlugin } from "../src/server/index.ts";

type Editor = {
  list(): readonly Skill.Info[];
  add(skill: Skill.Info): void;
};

function writeSkill(
  root: string,
  name: string,
  description: string,
  body = `# ${name}`,
) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
}

function writeCatalog(
  locationsDir: string,
  workspace: string,
  catalogHash: string,
  skills: string[],
) {
  writeFileSync(
    join(locationsDir, "one.json"),
    JSON.stringify({
      version: 1,
      location: {
        directory: join(workspace, "..", "other-workspace"),
        canonical: workspace,
      },
      catalogHash,
      skills: skills.map((name) => ({
        name,
        description: `${name} description`,
        path: join(workspace, "skills", name, "SKILL.md"),
      })),
    }),
  );
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the plugin");
}

test("registers, refreshes, and removes the matching workspace catalog", async () => {
  const base = mkdtempSync(join(tmpdir(), "oc-bb-skills-plugin-"));
  try {
    const workspace = join(base, "workspace");
    const locations = join(base, "locations");
    const catalog = join(workspace, "skills");
    for (const dir of [workspace, catalog]) mkdirSync(dir, { recursive: true });
    writeSkill(catalog, "alpha", "Alpha");
    writeSkill(catalog, "beta", "Beta");

    const registry = new Map<string, Skill.Info>();
    let transform: ((editor: Editor) => void) | undefined;
    const editor = {
      list: () => [...registry.values()],
      add: (skill: Skill.Info) => {
        registry.set(skill.id, skill);
      },
    };
    const context = {
      options: { locationsDir: locations },
      location: { directory: workspace, project: { canonical: workspace } },
      skill: {
        transform: async (callback: (editor: Editor) => void) => {
          transform = callback;
          callback(editor);
          return { dispose: async () => {} };
        },
        reload: async () => {
          registry.clear();
          transform?.(editor);
        },
      },
    } as unknown as Plugin.Context;

    const cleanup = await createBbSkillsPlugin({ pollIntervalMs: 150 }).setup(
      context,
    );
    try {
      assert.equal(registry.size, 0);
      mkdirSync(locations, { recursive: true });
      writeCatalog(locations, workspace, "one", ["alpha", "beta"]);
      await waitFor(() => registry.has("alpha") && registry.has("beta"));
      assert.equal(registry.get("alpha")?.content.startsWith("---"), false);

      // Content changes reload even when the catalog metadata hash is unchanged.
      writeSkill(catalog, "alpha", "Alpha", "# alpha v2");
      await waitFor(() =>
        /# alpha v2/.test(registry.get("alpha")?.content ?? ""),
      );

      writeSkill(catalog, "gamma", "Gamma");
      writeCatalog(locations, workspace, "two", ["alpha", "gamma"]);
      await waitFor(() => registry.has("gamma") && !registry.has("beta"));

      rmSync(join(locations, "one.json"));
      await waitFor(() => registry.size === 0);
    } finally {
      await cleanup?.();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("requires a locationsDir option", async () => {
  const context = {
    options: {},
    location: {
      directory: "/tmp/workspace",
      project: { canonical: "/tmp/workspace" },
    },
    skill: {
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
  } as unknown as Plugin.Context;
  await assert.rejects(async () => {
    await createBbSkillsPlugin().setup(context);
  }, /missing locationsDir plugin option/);
});
