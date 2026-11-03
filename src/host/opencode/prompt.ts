import { pathToFileURL } from "node:url";
import type { SessionPromptInput } from "@opencode/client";
import {
  dynamicToolSchema,
  removeCommandMentionsFromPromptInput,
  type DynamicTool,
  type PermissionMode,
  type PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  inputRecord,
  isSubagentTool,
  stringValue,
  type OpenCodePermissionReply,
  type OpenCodeRecord,
} from "../types.ts";
import { pathUnderRoots } from "./native-skills.ts";

type RecordValue = OpenCodeRecord;

// OpenCode's auto-approve client replies once so it does not persist a rule;
// `always` does persist matching permission requests. BB full mode intentionally
// uses that broader behavior, while accept-edits is resolved by BB's approval UI.
export function automaticPermissionReply(
  permissionMode: PermissionMode | undefined,
  disableSubagents: boolean,
  action: string,
): OpenCodePermissionReply | undefined {
  if (disableSubagents && isSubagentTool(action)) return "reject";
  if (permissionMode === "auto") return "once";
  if (permissionMode === "full") return "always";
  return undefined;
}

export function approvalPermissionReply(
  decision: unknown,
): OpenCodePermissionReply {
  return decision === "allow_for_session"
    ? "always"
    : decision === "allow_once"
      ? "once"
      : "reject";
}

export const PERMISSION_DENIED_MESSAGE =
  "The user denied this request in BB. Do not retry it; continue without it or ask the user how to proceed.";

/**
 * `POST .../permission/{id}/reply` body. A bare reject makes OpenCode abort
 * the whole step; a reject with a message is returned to the model as the
 * tool result so the agent can continue, matching BB's deny semantics.
 */
export function permissionReplyBody(decision: OpenCodePermissionReply) {
  return decision === "reject"
    ? { decision, message: PERMISSION_DENIED_MESSAGE }
    : { decision };
}

export const SUBAGENT_DISABLED_TOOL_ERROR =
  "[bb] Native subagents (task tool) are disabled in this BB thread. Do all work directly in this session with your other tools instead of delegating.";

export function subagentDisabledToolError(underlying?: unknown): string {
  const detail =
    typeof underlying === "string" && underlying.trim()
      ? underlying.trim()
      : "";
  if (!detail || detail.includes("Native subagents"))
    return SUBAGENT_DISABLED_TOOL_ERROR;
  return `${SUBAGENT_DISABLED_TOOL_ERROR}\n${detail}`;
}

export function toolFailureError(
  toolName: string,
  disableSubagents: boolean,
  underlying?: unknown,
): string {
  const fallback =
    typeof underlying === "string" && underlying.trim()
      ? underlying
      : "OpenCode tool failed";
  if (disableSubagents && isSubagentTool(toolName))
    return subagentDisabledToolError(underlying);
  return fallback;
}

type PromptFile = NonNullable<SessionPromptInput["files"]>[number];
type PromptSkill = NonNullable<SessionPromptInput["skills"]>[number];

function isCommandMention(mention: unknown): boolean {
  const resource = inputRecord(inputRecord(mention).resource);
  return (
    resource.kind === "command" &&
    resource.source === "command" &&
    resource.trigger === "/"
  );
}

/**
 * Whether the input carries a slash command mention at all. Avoids fetching
 * OpenCode's command catalog for ordinary prompts.
 */
export function hasCommandMention(input: readonly RecordValue[]): boolean {
  return input.some(
    (part) =>
      part.type === "text" &&
      Array.isArray(part.mentions) &&
      part.mentions.some(isCommandMention),
  );
}

/**
 * The first slash command BB accepted from its command menu. Only commands
 * OpenCode currently lists are routed to `session.command`; anything else
 * stays ordinary prompt text.
 */
export function selectedCommandMention(
  input: readonly RecordValue[],
  knownCommands: ReadonlySet<string>,
): { name: string } | undefined {
  for (const part of input) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const mentions = Array.isArray(part.mentions) ? part.mentions : [];
    for (const mention of mentions) {
      if (!isCommandMention(mention)) continue;
      const resource = inputRecord(mention.resource);
      const name = stringValue(resource.name);
      const start = mention.start;
      const end = mention.end;
      if (!name || !knownCommands.has(name)) continue;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start >= end ||
        end > part.text.length ||
        part.text.slice(start, end) !== `/${name}`
      )
        continue;
      return { name };
    }
  }
  return undefined;
}

function skillMentionResource(mention: RecordValue): RecordValue | undefined {
  const resource = inputRecord(mention.resource);
  if (
    resource.kind !== "command" ||
    resource.source !== "skill" ||
    resource.trigger !== "/"
  )
    return undefined;
  return resource;
}

/** Whether the input has a mention that `promptBody` can treat as a skill. */
export function hasSkillMention(input: readonly RecordValue[]): boolean {
  for (const part of input) {
    if (part.type !== "text" || !Array.isArray(part.mentions)) continue;
    if (part.mentions.some((mention) => skillMentionResource(mention)))
      return true;
  }
  return false;
}

/** Remove a `/command` mention while keeping every other mention aligned. */
export function withoutCommandMention(
  input: readonly RecordValue[],
  name: string,
): RecordValue[] {
  return removeCommandMentionsFromPromptInput(input as PromptInput[], {
    trigger: "/",
    name,
  }) as RecordValue[];
}

export function promptBody(
  input: RecordValue[],
  opts?: {
    configuredSkillNames?: ReadonlySet<string>;
    disableSubagents?: boolean;
    nativeSkills?: ReadonlyMap<string, string | undefined>;
    nativeSkillRoots?: ReadonlySet<string>;
    skillFiles?: ReadonlyMap<string, string>;
  },
): Pick<SessionPromptInput, "text" | "files" | "skills"> {
  const text: string[] = [];
  const files: PromptFile[] = [];
  for (const part of input) {
    if (part.type === "text") text.push(part.text);
    if (part.type === "localFile" || part.type === "localImage") {
      files.push({
        uri: pathToFileURL(part.path).href,
        ...(part.name ? { name: part.name } : {}),
      });
    }
    if (part.type === "image") files.push({ uri: part.url });
  }
  // Native subagent enforcement is permission-reject only (see
  // automaticPermissionReply). The prompt is sent unchanged; when a
  // task/subagent call fails while disabled, toolFailureError surfaces the
  // warning on that failure result instead.
  void opts?.disableSubagents;
  const body = text.join("\n");
  const skills: PromptSkill[] = [];
  let textOffset = 0;
  let sawText = false;
  for (const part of input) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (sawText) textOffset += 1;
    const mentions = Array.isArray(part.mentions) ? part.mentions : [];
    for (const mention of mentions) {
      const resource = skillMentionResource(mention);
      if (!resource) continue;
      const id = stringValue(resource.name);
      const start =
        typeof mention.start === "number" && Number.isFinite(mention.start)
          ? mention.start
          : undefined;
      const end =
        typeof mention.end === "number" && Number.isFinite(mention.end)
          ? mention.end
          : undefined;
      if (!id || start === undefined || end === undefined || end < start)
        continue;
      // BB offers two kinds of skill: its own configured roots, and the
      // agent's native skills (OpenCode's own discovery, which BB lists
      // through resolveNativeRoots). Anything else is plain text.
      const configured = opts?.configuredSkillNames?.has(id) === true;
      const native = opts?.nativeSkills?.has(id) === true;
      const hasFile = opts?.skillFiles?.has(id) === true;
      const hasSkillSets =
        opts?.configuredSkillNames !== undefined ||
        opts?.nativeSkills !== undefined;
      if (hasSkillSets && !configured && !native && !hasFile) continue;
      const promptMention = {
        start: textOffset + start,
        end: textOffset + end,
        text: part.text.slice(start, end),
      };
      const nativeIsBb = pathUnderRoots(
        opts?.nativeSkills?.get(id),
        opts?.nativeSkillRoots,
      );
      // A BB-configured skill must only use the native path when the registry
      // entry came from BB's own catalog. A colliding native skill, or a
      // missing plugin entry, keeps the file fallback so the BB skill wins.
      const canUseNative =
        !hasSkillSets || (native && (!configured || nativeIsBb));
      if (!canUseNative) {
        const skillFile = opts.skillFiles?.get(id);
        if (skillFile)
          files.push({
            uri: pathToFileURL(skillFile).href,
            name: `${id}/SKILL.md`,
          });
        continue;
      }
      skills.push({ id, mention: promptMention });
    }
    textOffset += part.text.length;
    sawText = true;
  }
  return {
    text: body,
    ...(files.length ? { files } : {}),
    ...(skills.length ? { skills } : {}),
  };
}

export function enabledDynamicTools(
  rawTools: unknown,
  disallowedTools: ReadonlySet<string>,
): DynamicTool[] {
  const parsed = dynamicToolSchema.array().safeParse(rawTools ?? []);
  if (!parsed.success) return [];
  const names = new Set<string>();
  return parsed.data.filter((tool) => {
    if (disallowedTools.has(tool.name) || names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}

function dynamicToolKey(tool: DynamicTool) {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? null,
  });
}

/**
 * BB re-sends session construction (resume) around turns even when nothing
 * changed. Re-registering the MCP bridge each time makes OpenCode kill and
 * respawn the tool child per message and leaves dead "Connection closed"
 * entries behind when cleanup races. Only the visible tool catalog matters to
 * OpenCode, so skip re-registration when it is unchanged.
 */
export function sameDynamicTools(
  a: readonly DynamicTool[],
  b: readonly DynamicTool[],
): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(dynamicToolKey).sort();
  const right = b.map(dynamicToolKey).sort();
  return left.every((entry, index) => entry === right[index]);
}
