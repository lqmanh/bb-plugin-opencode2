import { existsSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

type Scan = {
  /** Index of the root object's closing brace. */
  rootClose: number;
  /** `[` and `]` of a top-level `permissions` array, if present. */
  permissions?: { open: number; close: number; keyStart: number };
};

/** Minimal JSONC scan: string- and comment-aware brace matching. */
function scan(text: string): Scan | undefined {
  let depth = 0;
  let rootClose = -1;
  let pendingKey: { name: string; start: number } | undefined;
  let lastString: { value: string; start: number } | undefined;
  let permissions: Scan["permissions"];
  let permissionsDepth = -1;
  let permissionsOpen = -1;
  let permissionsKeyStart = -1;
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
      if (ch === "[" && depth === 1 && pendingKey?.name === "permissions") {
        permissionsDepth = depth;
        permissionsOpen = i;
        permissionsKeyStart = pendingKey.start;
      }
      depth++;
      pendingKey = undefined;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (
        ch === "]" &&
        depth === permissionsDepth &&
        permissionsOpen >= 0 &&
        !permissions
      )
        permissions = {
          open: permissionsOpen,
          close: i,
          keyStart: permissionsKeyStart,
        };
      if (ch === "}" && depth === 0) rootClose = i;
      continue;
    }
    if (ch === ",") pendingKey = undefined;
  }
  return rootClose >= 0 && depth === 0 ? { rootClose, permissions } : undefined;
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

function lineIndent(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

/** Insert the rule; returns the new text, or undefined when unchanged. */
export function addBbToolsRule(text: string): string | undefined {
  if (RULE_PATTERN.test(text)) return undefined;
  const parsed = scan(text);
  if (!parsed) throw new Error("OpenCode config is not valid JSON");
  if (parsed.permissions) {
    const { open, close } = parsed.permissions;
    const keyIndent = lineIndent(text, parsed.permissions.keyStart);
    const last = previousSignificant(text, close);
    const empty = last === open;
    const separator = empty || text[last] === "," ? "" : ",";
    const item = `\n${keyIndent}  ${BB_TOOLS_RULE}`;
    const before = text.slice(0, last + 1) + separator + item;
    // Keep whatever followed the last element (newline + indent) before `]`.
    const tail = text.slice(last + 1, close);
    return (
      before +
      (tail.includes("\n") ? tail : `\n${keyIndent}`) +
      text.slice(close)
    );
  }
  const last = previousSignificant(text, parsed.rootClose);
  const emptyRoot = text[last] === "{";
  const gap = text.slice(last + 1, parsed.rootClose);
  const entry = `\n  "permissions": [\n    ${BB_TOOLS_RULE}\n  ]`;
  return (
    text.slice(0, last + 1) +
    (emptyRoot || text[last] === "," ? "" : ",") +
    entry +
    (gap.includes("\n") ? gap : "\n") +
    text.slice(parsed.rootClose)
  );
}

/**
 * Add the BB-tools deny rule to this host's OpenCode global config when it is
 * missing. Writes only when the file changes, atomically and with the file's
 * mode kept.
 */
export async function ensureBbToolsRule(
  path = globalConfigPath(),
): Promise<"added" | "unchanged"> {
  let text: string | undefined;
  let mode = 0o644;
  try {
    text = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o777;
  } catch {}
  const next = addBbToolsRule(text ?? "{}\n");
  if (next === undefined) return "unchanged";
  const temp = `${path}.bb-${process.pid}.tmp`;
  await writeFile(temp, next, { mode });
  await rename(temp, path);
  return "added";
}
