import { Plugin, type Skill } from "@opencode/plugin";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_PREFIX = "[opencode-bb-skills]";
const DEFAULT_POLL_INTERVAL_MS = 15_000;

type CatalogSkill = {
  name?: unknown;
  description?: unknown;
  path?: unknown;
};

type Catalog = {
  version?: unknown;
  location?: { directory?: unknown; canonical?: unknown };
  skills?: unknown;
};

type CatalogLocation = {
  directory: string;
  project?: { canonical?: string };
};

export type BbSkillsPluginOptions = {
  /** Catalog poll interval; tests use a short value. */
  pollIntervalMs?: number;
};

export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function skillsKey(skills: readonly Skill.Info[]): string {
  return JSON.stringify(
    skills.map((skill) => [
      skill.id,
      skill.path,
      skill.description,
      skill.content,
    ]),
  );
}

export async function loadDirectoryCatalog(
  directory: string,
  location: CatalogLocation,
): Promise<Catalog | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let catalog: Catalog;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, entry.name), "utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      catalog = parsed as Catalog;
    } catch {
      continue;
    }
    if (catalog.version !== 1) continue;
    const entryLocation = catalog.location ?? {};
    if (
      entryLocation.directory === location.directory ||
      (entryLocation.canonical !== undefined &&
        entryLocation.canonical === location.project?.canonical)
    ) {
      return catalog;
    }
  }
  return undefined;
}

export async function materializeSkills(
  catalog: Catalog | undefined,
): Promise<Skill.Info[]> {
  const catalogSkills = Array.isArray(catalog?.skills)
    ? (catalog.skills as CatalogSkill[])
    : [];
  const skills = await Promise.all(
    catalogSkills.map(async (skill): Promise<Skill.Info | undefined> => {
      if (
        !skill ||
        typeof skill.name !== "string" ||
        !skill.name ||
        typeof skill.path !== "string" ||
        !skill.path
      )
        return undefined;
      let content: string;
      try {
        content = await readFile(skill.path, "utf8");
      } catch (error) {
        console.error(`${LOG_PREFIX} cannot read ${skill.path}`, error);
        return undefined;
      }
      return {
        id: skill.name,
        name: skill.name,
        description:
          typeof skill.description === "string" ? skill.description : "",
        path: skill.path,
        content: stripFrontmatter(content),
      } as Skill.Info;
    }),
  );
  return skills.filter((skill): skill is Skill.Info => skill !== undefined);
}

async function readCatalog(
  locationsDir: string,
  location: CatalogLocation,
): Promise<{ skills: Skill.Info[]; key: string }> {
  const catalog = await loadDirectoryCatalog(locationsDir, location);
  const skills = await materializeSkills(catalog);
  return { skills, key: skillsKey(skills) };
}

async function applySkills(
  context: Plugin.Context,
  getSkills: () => Skill.Info[],
) {
  return context.skill.transform((editor) => {
    const skills = getSkills();
    const existing = new Set(editor.list().map((skill) => skill.id));
    for (const skill of skills) {
      if (existing.has(skill.id)) {
        console.error(
          `${LOG_PREFIX} overriding overlapping native skill ${skill.id}`,
        );
      }
      editor.add(skill);
    }
  });
}

function watchDirectory(
  directory: string,
  onChange: () => void,
  pollIntervalMs: number,
) {
  let watcher: FSWatcher | undefined;
  const attach = () => {
    if (watcher) return;
    try {
      watcher = watch(directory, { persistent: false }, onChange);
    } catch {
      // The host may create the directory after the plugin loads.
    }
  };
  attach();
  const timer = setInterval(() => {
    attach();
    onChange();
  }, pollIntervalMs);
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}

export function createBbSkillsPlugin(
  options: BbSkillsPluginOptions = {},
): Plugin.Plugin {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return Plugin.define({
    id: "opencode-bb-skills",
    async setup(context) {
      const locationsDir = context.options?.locationsDir;
      if (typeof locationsDir !== "string" || locationsDir.length === 0) {
        throw new Error(`${LOG_PREFIX} missing locationsDir plugin option`);
      }

      let { skills, key } = await readCatalog(locationsDir, context.location);
      const registration = await applySkills(context, () => skills);
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;

      const refresh = async () => {
        if (disposed) return;
        try {
          const next = await readCatalog(locationsDir, context.location);
          if (next.key === key) return;
          key = next.key;
          skills = next.skills;
          await context.skill.reload();
        } catch (error) {
          console.error(`${LOG_PREFIX} catalog refresh failed`, error);
        }
      };

      const schedule = () => {
        if (disposed) return;
        if (reloadTimer !== undefined) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => void refresh(), 100);
      };

      // A directory watcher gives fast updates; polling also covers a
      // locations directory created after setup and missed watcher events.
      const unwatch = watchDirectory(locationsDir, schedule, pollIntervalMs);
      return async () => {
        disposed = true;
        if (reloadTimer !== undefined) clearTimeout(reloadTimer);
        unwatch();
        await registration.dispose();
      };
    },
  });
}

export default createBbSkillsPlugin();
