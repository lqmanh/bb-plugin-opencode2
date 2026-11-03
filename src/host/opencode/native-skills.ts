import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import rootPackage from "../../../package.json" with { type: "json" };
import { writeJsonFileAtomic } from "../session/persistence.ts";

export const BB_PLUGIN_VERSION = rootPackage.version;
export const BB_SKILLS_PLUGIN_PATH = "opencode-bb-skills";
export const BB_SKILLS_REPOSITORY = "github:lqmanh/bb-plugin-opencode2";
const LOCATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type NativeSkillRoot = {
  id: string;
  path: string;
  skills: readonly { name: string; description: string }[];
};

export type NativeSkillDescriptor = {
  name: string;
  description: string;
  path: string;
};

export type NativeSkillCatalog = {
  version: 1;
  location: { directory: string; canonical: string };
  catalogHash: string;
  skills: NativeSkillDescriptor[];
};

export function nativeSkillFilePath(root: string, name: string): string {
  return join(root, name, "SKILL.md");
}

export function pathUnderRoots(
  path: string | undefined,
  roots: ReadonlySet<string> | undefined,
): boolean {
  if (!path || !roots) return false;
  const normalizedPath = path.replaceAll("\\", "/");
  for (const root of roots) {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (
      normalizedPath === normalizedRoot ||
      normalizedPath.startsWith(`${normalizedRoot}/`)
    )
      return true;
  }
  return false;
}

/**
 * The OpenCode plugin is installed from this repository and pinned to the BB
 * plugin version. `BB_OPENCODE_BB_SKILLS_PACKAGE` is a development override
 * for a local checkout; production uses the version tag.
 */
export function bbSkillsPluginPackage(env = process.env): string {
  const override = env.BB_OPENCODE_BB_SKILLS_PACKAGE?.trim();
  if (override) return override;
  return `${BB_SKILLS_REPOSITORY}#v${BB_PLUGIN_VERSION}::path:${BB_SKILLS_PLUGIN_PATH}`;
}

/** Whether a configured package spec belongs to the BB skills plugin. */
export function isBbSkillsPluginPackage(packageSpec: string): boolean {
  const spec = packageSpec.trim().replaceAll("\\", "/");
  const local = spec.replace(/\/+$/u, "");
  if (
    local === BB_SKILLS_PLUGIN_PATH ||
    local.endsWith(`/${BB_SKILLS_PLUGIN_PATH}`)
  )
    return true;
  const pathMarker = `::path:${BB_SKILLS_PLUGIN_PATH}`;
  const markerIndex = spec.indexOf(pathMarker);
  if (markerIndex < 0) return false;
  const pathTail = spec.slice(markerIndex + pathMarker.length);
  if (pathTail && !pathTail.startsWith("/")) return false;
  if (
    spec.startsWith(`${BB_SKILLS_REPOSITORY}#`) ||
    spec.startsWith(`${BB_SKILLS_REPOSITORY}::`)
  )
    return true;
  const repository = BB_SKILLS_REPOSITORY.replace(/^github:/u, "");
  return [
    `https://github.com/${repository}`,
    `git+https://github.com/${repository}`,
    `git+ssh://git@github.com/${repository}`,
    `ssh://git@github.com/${repository}`,
  ].some((prefix) => spec.startsWith(prefix));
}

export function nativeSkillsRoot(dataDir: string): string {
  return join(dataDir, "runtime", BB_SKILLS_PLUGIN_PATH);
}

export function nativeSkillsLocationsDir(dataDir: string): string {
  return join(nativeSkillsRoot(dataDir), "locations");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function locationHash(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 32);
}

async function normalizedLocation(
  cwd: string,
): Promise<{ directory: string; canonical: string }> {
  const directory = resolve(cwd);
  const canonical = await realpath(directory).catch(() => directory);
  return { directory, canonical };
}

export async function buildNativeSkillCatalog(
  cwd: string,
  roots: readonly NativeSkillRoot[],
): Promise<NativeSkillCatalog> {
  const location = await normalizedLocation(cwd);
  const candidates = roots.flatMap((root) =>
    root.skills.map((skill) => ({
      skill,
      path: nativeSkillFilePath(root.path, skill.name),
    })),
  );
  const present = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      exists: await exists(candidate.path),
    })),
  );
  const byName = new Map<string, NativeSkillDescriptor>();
  for (const candidate of present) {
    if (!candidate.exists) continue;
    byName.set(candidate.skill.name, {
      name: candidate.skill.name,
      description: candidate.skill.description,
      path: candidate.path,
    });
  }
  const skills = [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return {
    version: 1,
    location,
    catalogHash: createHash("sha256")
      .update(JSON.stringify(skills))
      .digest("hex"),
    skills,
  };
}

export async function writeNativeSkillsLocation(
  dataDir: string,
  cwd: string,
  roots: readonly NativeSkillRoot[],
): Promise<string[]> {
  const catalog = await buildNativeSkillCatalog(cwd, roots);
  const names = catalog.skills.map((skill) => skill.name);
  if (catalog.skills.length === 0) {
    await removeNativeSkillsLocation(dataDir, cwd);
    return names;
  }
  const directory = nativeSkillsLocationsDir(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${locationHash(catalog.location.canonical)}.json`,
  );
  const previous = await readFile(path, "utf8")
    .then((text) => JSON.parse(text) as { catalogHash?: unknown })
    .catch(() => undefined);
  if (previous?.catalogHash === catalog.catalogHash) {
    // Keep the location fresh for the prune pass without waking watchers.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return names;
  }
  await writeJsonFileAtomic(path, catalog);
  return names;
}

export async function removeNativeSkillsLocation(
  dataDir: string,
  cwd: string,
): Promise<void> {
  const location = await normalizedLocation(cwd);
  await unlink(
    join(
      nativeSkillsLocationsDir(dataDir),
      `${locationHash(location.canonical)}.json`,
    ),
  ).catch(() => {});
}

/** Drop catalogs for workspaces that have not been refreshed recently. */
export async function pruneNativeSkillsLocations(
  dataDir: string,
): Promise<void> {
  const directory = nativeSkillsLocationsDir(dataDir);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const cutoff = Date.now() - LOCATION_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs > cutoff) continue;
    await unlink(path).catch(() => {});
  }
}

/** Remove every catalog for this host; used when the setting is turned off. */
export async function removeNativeSkillsRoot(dataDir: string): Promise<void> {
  await rm(nativeSkillsRoot(dataDir), { recursive: true, force: true });
}
