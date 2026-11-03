import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../session/persistence.ts";
import { DYNAMIC_MCP_SERVER_PREFIX } from "./opencode-requests.ts";

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
export const BB_TOOLS_RULE = `{ "action": "${DYNAMIC_MCP_SERVER_PREFIX}*", "resource": "*", "effect": "deny" }`;

const RULE_PATTERN = new RegExp(
  `\\{\\s*"action"\\s*:\\s*"${DYNAMIC_MCP_SERVER_PREFIX}\\*"\\s*,\\s*"resource"\\s*:\\s*"\\*"\\s*,\\s*"effect"\\s*:\\s*"deny"\\s*\\}`,
);

export function globalConfigPath(env = process.env): string {
  const dir = join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
  );
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}

type ArraySpan = {
  /** `[` and `]` of a top-level array. */
  open: number;
  close: number;
  keyStart: number;
};

type Scan = {
  /** Index of the root object's closing brace. */
  rootClose: number;
  /** Top-level arrays by key. The first occurrence wins. */
  arrays: Map<string, ArraySpan>;
};

/** Minimal JSONC scan: string- and comment-aware brace matching. */
function scan(text: string): Scan | undefined {
  let depth = 0;
  let rootClose = -1;
  let pendingKey: { name: string; start: number } | undefined;
  let lastString: { value: string; start: number } | undefined;
  const arrays = new Map<string, ArraySpan>();
  const openArrays: Array<{
    key?: string;
    open: number;
    keyStart: number;
    depth: number;
  }> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      let value = "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
        value += text[i];
      }
      lastString = { value, start };
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return undefined;
      i++;
      continue;
    }
    if (ch === ":") {
      pendingKey = lastString && {
        name: lastString.value,
        start: lastString.start,
      };
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (ch === "[" && depth === 1 && pendingKey) {
        openArrays.push({
          key: pendingKey.name,
          open: i,
          keyStart: pendingKey.start,
          depth,
        });
      }
      depth++;
      pendingKey = undefined;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (ch === "]") {
        const top = openArrays[openArrays.length - 1];
        if (top && top.depth === depth) {
          openArrays.pop();
          if (top.key && !arrays.has(top.key)) {
            arrays.set(top.key, {
              open: top.open,
              close: i,
              keyStart: top.keyStart,
            });
          }
        }
      }
      if (ch === "}" && depth === 0) rootClose = i;
      continue;
    }
    if (ch === ",") pendingKey = undefined;
  }
  return rootClose >= 0 && depth === 0 ? { rootClose, arrays } : undefined;
}

/** Last significant character before `index`, skipping whitespace and comments. */
function previousSignificant(text: string, index: number): number {
  const stripped = text
    .slice(0, index)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  for (let i = index - 1; i >= 0; i--) if (!/\s/.test(stripped[i])) return i;
  return -1;
}

/** First significant character at or after `index`, skipping whitespace and comments. */
function nextSignificant(text: string, index: number): number {
  for (let i = index; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (text[i] === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i + 2);
      if (newline < 0) return text.length;
      i = newline;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return text.length;
      i = end + 1;
      continue;
    }
    return i;
  }
  return text.length;
}

function lineIndent(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

function trimRange(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : undefined;
}

/** Top-level comma-separated ranges inside a JSONC array. */
function arrayElements(
  text: string,
  open: number,
  close: number,
): { start: number; end: number }[] {
  const elements: { start: number; end: number }[] = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i];
    if (ch === '"') {
      for (i++; i < close && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < close && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0 || i >= close) break;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      const range = trimRange(text, start, i);
      if (range) elements.push(range);
      start = i + 1;
    }
  }
  const last = trimRange(text, start, close);
  if (last) elements.push(last);
  return elements;
}

export type PluginEntry = {
  package: string;
  options?: Record<string, unknown>;
};

export type PluginMatcher = (packageSpec: string) => boolean;

/** Remove comments and trailing commas so one array element can be parsed. */
function stripJsonc(text: string): string {
  let result = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      result += text.slice(start, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i + 2);
      result += " ";
      if (newline < 0) break;
      i = newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      result += " ";
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (ch === ",") {
      const next = nextSignificant(text, i + 1);
      if (text[next] === "}" || text[next] === "]") {
        i++;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function parsePluginElement(
  text: string,
  element: { start: number; end: number },
): PluginEntry | undefined {
  const cleaned = stripJsonc(text.slice(element.start, element.end)).trim();
  if (!cleaned) return undefined;
  try {
    const value: unknown = JSON.parse(cleaned);
    if (typeof value === "string")
      return value ? { package: value } : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const record = value as Record<string, unknown>;
    const packageSpec = record.package;
    if (typeof packageSpec !== "string" || !packageSpec) return undefined;
    const options = record.options;
    if (
      options !== undefined &&
      (!options || typeof options !== "object" || Array.isArray(options))
    )
      return undefined;
    return {
      package: packageSpec,
      ...(options ? { options: options as Record<string, unknown> } : {}),
    };
  } catch {
    return undefined;
  }
}

function matchingPluginEntries(
  text: string,
  span: ArraySpan,
  matches: PluginMatcher,
): { range: { start: number; end: number }; value: PluginEntry }[] {
  return arrayElements(text, span.open, span.close).flatMap((range) => {
    const value = parsePluginElement(text, range);
    return value && matches(value.package) ? [{ range, value }] : [];
  });
}

function formatPluginEntry(entry: PluginEntry): string {
  const options =
    entry.options && Object.keys(entry.options).length
      ? `, "options": ${JSON.stringify(entry.options)}`
      : "";
  return `{ "package": ${JSON.stringify(entry.package)}${options} }`;
}

function samePluginEntry(left: PluginEntry, right: PluginEntry): boolean {
  return (
    left.package === right.package &&
    JSON.stringify(left.options ?? {}) === JSON.stringify(right.options ?? {})
  );
}

function appendArrayElement(
  text: string,
  span: ArraySpan,
  element: string,
): string {
  const keyIndent = lineIndent(text, span.keyStart);
  const last = previousSignificant(text, span.close);
  const empty = last === span.open;
  const separator = empty || text[last] === "," ? "" : ",";
  const item = `\n${keyIndent}  ${element}`;
  const before = text.slice(0, last + 1) + separator + item;
  const tail = text.slice(last + 1, span.close);
  return (
    before +
    (tail.includes("\n") ? tail : `\n${keyIndent}`) +
    text.slice(span.close)
  );
}

function addRootArray(
  text: string,
  parsed: Scan,
  key: string,
  element: string,
): string {
  const last = previousSignificant(text, parsed.rootClose);
  const emptyRoot = text[last] === "{";
  const gap = text.slice(last + 1, parsed.rootClose);
  const keyIndent = lineIndent(text, parsed.rootClose);
  const entry = `\n${keyIndent}  "${key}": [\n${keyIndent}    ${element}\n${keyIndent}  ]`;
  return (
    text.slice(0, last + 1) +
    (emptyRoot || text[last] === "," ? "" : ",") +
    entry +
    (gap.includes("\n") ? gap : "\n") +
    text.slice(parsed.rootClose)
  );
}

/** Insert the rule; returns the new text, or undefined when unchanged. */
export function addBbToolsRule(text: string): string | undefined {
  if (RULE_PATTERN.test(text)) return undefined;
  const parsed = scan(text);
  if (!parsed) throw new Error("OpenCode config is not valid JSON");
  const permissions = parsed.arrays.get("permissions");
  if (permissions) return appendArrayElement(text, permissions, BB_TOOLS_RULE);
  return addRootArray(text, parsed, "permissions", BB_TOOLS_RULE);
}

function removeArrayElements(
  text: string,
  elements: readonly { start: number; end: number }[],
  span: ArraySpan,
): string {
  // Remove from the end so each earlier element keeps its original offsets.
  // This also lets adjacent removals consume the right separator commas.
  const sorted = [...elements].sort((left, right) => right.start - left.start);
  let next = text;
  let removed = 0;
  for (const element of sorted) {
    const range = elementRemovalRange(next, element, {
      ...span,
      close: span.close - removed,
    });
    next = next.slice(0, range.start) + next.slice(range.end);
    removed += range.end - range.start;
  }
  return next;
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
  const parsed = scan(text);
  if (!parsed) throw new Error("OpenCode config is not valid JSON");
  const element = formatPluginEntry(entry);
  const plugins = parsed.arrays.get("plugins");
  if (!plugins) return addRootArray(text, parsed, "plugins", element);

  const matchesEntries = matchingPluginEntries(text, plugins, matches);
  if (matchesEntries.length === 1) {
    const match = matchesEntries[0]!;
    if (samePluginEntry(match.value, entry)) return undefined;
    return (
      text.slice(0, match.range.start) + element + text.slice(match.range.end)
    );
  }

  const next = matchesEntries.length
    ? removeArrayElements(
        text,
        matchesEntries.map(({ range }) => range),
        plugins,
      )
    : text;
  const reparsed = scan(next);
  if (!reparsed) throw new Error("OpenCode config is not valid JSON");
  const nextPlugins = reparsed.arrays.get("plugins");
  if (!nextPlugins) throw new Error("OpenCode config lost its plugins array");
  return appendArrayElement(next, nextPlugins, element);
}

/** Remove every plugin entry whose package matches `matches`. */
export function removePluginEntries(
  text: string,
  matches: PluginMatcher,
): string | undefined {
  const parsed = scan(text);
  if (!parsed) throw new Error("OpenCode config is not valid JSON");
  const plugins = parsed.arrays.get("plugins");
  if (!plugins) return undefined;
  const matchesEntries = matchingPluginEntries(text, plugins, matches);
  if (matchesEntries.length === 0) return undefined;
  return removeArrayElements(
    text,
    matchesEntries.map(({ range }) => range),
    plugins,
  );
}

function elementRemovalRange(
  text: string,
  element: { start: number; end: number },
  span: ArraySpan,
): { start: number; end: number } {
  let start = element.start;
  let end = element.end;
  while (start > span.open + 1 && /\s/.test(text[start - 1])) start--;
  const after = nextSignificant(text, end);
  if (text[after] === ",") {
    end = after + 1;
    while (end < span.close && /[ \t]/.test(text[end])) end++;
  } else {
    const before = previousSignificant(text, start);
    if (text[before] === ",") {
      start = before;
      while (start > span.open + 1 && /[ \t]/.test(text[start - 1])) start--;
    }
  }
  return { start, end };
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
