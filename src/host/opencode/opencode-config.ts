import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The package's UMD entry leaves relative requires that the plugin bundler
// does not copy; the ESM build resolves and bundles its implementation chunks.
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodePath,
  getNodeValue,
  modify,
  parseTree,
  SyntaxKind,
  type Node,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";
import { writeFileAtomic } from "../session/persistence.ts";
import { BB_TOOLS_DENY_RULE } from "./opencode-requests.ts";

/**
 * OpenCode attaches MCP servers to a directory, so its own sessions (TUI,
 * web) in a BB workspace would list every BB thread's tool server. One deny
 * rule in OpenCode's global config hides them there; BB sessions override it
 * with a later session-level allow for their own server.
 *
 * The edit is textual so the rest of the user's file (formatting, comments,
 * key order) is left byte-for-byte alone: the rule is appended to an
 * existing top-level `permissions` array (last match wins, so it must come
 * last), or a `permissions` key holding only this rule is added.
 */
export function globalConfigPath(env = process.env): string {
  const dir = join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
  );
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}

export type PluginEntry = {
  package: string;
  options?: Record<string, unknown>;
};

export type PluginMatcher = (packageSpec: string) => boolean;

function parseDocument(text: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (!root || root.type !== "object" || errors.length > 0)
    throw new Error("OpenCode config is not valid JSON");
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredArray(root: Node, name: string): Node | undefined {
  const value = findNodeAtLocation(root, [name]);
  if (!value) return undefined;
  if (value.type !== "array")
    throw new Error(`OpenCode config has a non-array ${name} value`);
  return value;
}

function optionalArray(root: Node, name: string): Node | undefined {
  const value = findNodeAtLocation(root, [name]);
  return value?.type === "array" ? value : undefined;
}

function pluginEntry(value: unknown): PluginEntry | undefined {
  if (typeof value === "string") return value ? { package: value } : undefined;
  if (!isRecord(value)) return undefined;
  const packageSpec = value.package;
  if (typeof packageSpec !== "string" || !packageSpec) return undefined;
  const options = value.options;
  if (options !== undefined && !isRecord(options)) return undefined;
  return {
    package: packageSpec,
    ...(options ? { options } : {}),
  };
}

function matchingPluginEntries(array: Node, matches: PluginMatcher) {
  return (array.children ?? []).flatMap((node, index) => {
    const value = pluginEntry(getNodeValue(node));
    return value && matches(value.package) ? [{ index, value }] : [];
  });
}

function samePluginEntry(left: PluginEntry, right: PluginEntry): boolean {
  return (
    left.package === right.package &&
    JSON.stringify(left.options ?? {}) === JSON.stringify(right.options ?? {})
  );
}

function isBbToolsRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(BB_TOOLS_DENY_RULE).every(
      ([key, expected]) => value[key] === expected,
    )
  );
}

function editConfig(
  text: string,
  path: readonly (string | number)[],
  value: unknown,
  options: { isArrayInsertion?: boolean } = {},
): string {
  return applyEdits(text, modify(text, [...path], value, options));
}

function appendArrayValue(text: string, array: Node, value: unknown): string {
  return editConfig(
    text,
    [...getNodePath(array), array.children?.length ?? 0],
    value,
    { isArrayInsertion: true },
  );
}

// jsonc-parser 3.3.1's modify() removal corrupts some arrays (for example
// [1,2] -> [12]) and can leave an invalid closing bracket. Remove from the
// parsed node offsets instead, descending so earlier offsets stay valid.
function nextToken(text: string, offset: number) {
  const scanner = createScanner(text, true);
  scanner.setPosition(offset);
  const kind = scanner.scan();
  return kind === SyntaxKind.EOF
    ? undefined
    : { kind, offset: scanner.getTokenOffset() };
}

function removeArrayElement(text: string, array: Node, index: number): string {
  const element = array.children?.[index];
  if (!element) return text;
  let start = element.offset;
  let end = element.offset + element.length;
  while (start > array.offset + 1 && /\s/u.test(text[start - 1])) start--;
  const after = nextToken(text, end);
  if (after?.kind === SyntaxKind.CommaToken) {
    end = after.offset + 1;
    while (end < text.length && /[ \t]/u.test(text[end])) end++;
  } else {
    const previous = index > 0 ? array.children?.[index - 1] : undefined;
    if (previous) {
      const before = nextToken(text, previous.offset + previous.length);
      if (before?.kind === SyntaxKind.CommaToken) {
        start = before.offset;
        while (start > array.offset + 1 && /[ \t]/u.test(text[start - 1]))
          start--;
      }
    }
  }
  return text.slice(0, start) + text.slice(end);
}

function removeArrayValues(
  text: string,
  array: Node,
  indices: readonly number[],
): string {
  let next = text;
  for (const index of [...indices].sort((left, right) => right - left)) {
    next = removeArrayElement(next, array, index);
  }
  return next;
}

/** Insert the rule; returns the new text, or undefined when unchanged. */
export function addBbToolsRule(text: string): string | undefined {
  const root = parseDocument(text);
  const permissions = requiredArray(root, "permissions");
  if (!permissions)
    return editConfig(text, ["permissions"], [BB_TOOLS_DENY_RULE]);
  if (
    (permissions.children ?? []).some((node) =>
      isBbToolsRule(getNodeValue(node)),
    )
  )
    return undefined;
  return appendArrayValue(text, permissions, BB_TOOLS_DENY_RULE);
}

/**
 * Add or replace the entries matching `matches` with one object entry. String
 * entries from older BB builds and hand-written object entries are replaced.
 */
export function upsertPluginEntry(
  text: string,
  matches: PluginMatcher,
  entry: PluginEntry,
): string | undefined {
  const root = parseDocument(text);
  const plugins = requiredArray(root, "plugins");
  if (!plugins) return editConfig(text, ["plugins"], [entry]);

  const matchesEntries = matchingPluginEntries(plugins, matches);
  if (matchesEntries.length === 1) {
    const [{ index, value }] = matchesEntries;
    return samePluginEntry(value, entry)
      ? undefined
      : editConfig(text, [...getNodePath(plugins), index], entry);
  }
  if (matchesEntries.length === 0)
    return appendArrayValue(text, plugins, entry);

  const next = removeArrayValues(
    text,
    plugins,
    matchesEntries.map(({ index }) => index),
  );
  const nextPlugins = requiredArray(parseDocument(next), "plugins");
  if (!nextPlugins) throw new Error("OpenCode config lost its plugins array");
  return appendArrayValue(next, nextPlugins, entry);
}

/** Remove every plugin entry whose package matches `matches`. */
export function removePluginEntries(
  text: string,
  matches: PluginMatcher,
): string | undefined {
  const root = parseDocument(text);
  const plugins = optionalArray(root, "plugins");
  if (!plugins) return undefined;
  const matchesEntries = matchingPluginEntries(plugins, matches);
  if (matchesEntries.length === 0) return undefined;
  return removeArrayValues(
    text,
    plugins,
    matchesEntries.map(({ index }) => index),
  );
}

let configQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = configQueue.then(operation, operation);
  configQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function withConfigLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return serialize(async () => {
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.bb-opencode2.lock`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          return await operation();
        } finally {
          await handle.close().catch(() => {});
          await rm(lockPath, { force: true }).catch(() => {});
        }
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 50 + Math.random() * 100),
        );
      }
    }
    throw new Error("Timed out waiting for the OpenCode config lock");
  });
}

async function readConfig(
  path: string,
): Promise<{ text: string; mode: number }> {
  try {
    const [text, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    return { text, mode: info.mode & 0o777 };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { text: "{}\n", mode: 0o644 };
    throw error;
  }
}

async function updateConfig(
  path: string,
  update: (text: string) => string | undefined,
): Promise<boolean> {
  return withConfigLock(path, async () => {
    const config = await readConfig(path);
    const next = update(config.text);
    if (next === undefined) return false;
    await writeFileAtomic(path, next, config.mode);
    return true;
  });
}

/**
 * Add the BB-tools deny rule to this host's OpenCode global config when it is
 * missing. Writes only when the file changes, atomically and with the file's
 * mode kept.
 */
export async function ensureBbToolsRule(
  path = globalConfigPath(),
): Promise<"added" | "unchanged"> {
  return (await updateConfig(path, addBbToolsRule)) ? "added" : "unchanged";
}

/** Ensure one matching plugin object entry; writes only on change. */
export async function ensurePluginEntry(
  path: string,
  matches: PluginMatcher,
  entry: PluginEntry,
): Promise<"changed" | "unchanged"> {
  const changed = await updateConfig(path, (text) =>
    upsertPluginEntry(text, matches, entry),
  );
  return changed ? "changed" : "unchanged";
}

/** Remove matching plugin entries; writes only when the file changes. */
export async function removePluginEntriesFromConfig(
  path: string,
  matches: PluginMatcher,
): Promise<"removed" | "unchanged"> {
  const removed = await updateConfig(path, (text) =>
    removePluginEntries(text, matches),
  );
  return removed ? "removed" : "unchanged";
}
