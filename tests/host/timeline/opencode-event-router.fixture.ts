import type { OpenCodeClient } from "@opencode/client";
import {
  createActiveTurn,
  OpenCodeEventRouter,
} from "../../support/host-api.js";
import { createFakeOpenCodeApi } from "../../support/opencode-client.fixture.ts";
import { createTestSession } from "../../support/session.fixture.ts";
import type {
  ActiveTurn,
  OpenCodeRecord,
  SessionState,
} from "../../../src/host/types.ts";

export const emptyApi = createFakeOpenCodeApi();

export function sessionFixture(
  api: () => Promise<OpenCodeClient>,
  hooks?: NonNullable<ConstructorParameters<typeof OpenCodeEventRouter>[3]>,
  overrides: {
    active?: Partial<ActiveTurn> | null;
    session?: Partial<SessionState>;
  } = {},
) {
  const emitted: OpenCodeRecord[] = [];
  const active: ActiveTurn = {
    ...createActiveTurn("turn-1"),
    promptIds: new Set(["msg_user"]),
    inputDelivered: true,
    ...(overrides.active ?? {}),
  };
  const session = createTestSession({
    active: overrides.active === null ? undefined : active,
    ...overrides.session,
  });
  const lookup = new Map([[session.providerThreadId, session]]);
  const router = new OpenCodeEventRouter(
    api,
    (_threadId, deltas) => emitted.push(...deltas),
    lookup,
    hooks,
  );
  const event = (type: string, data: OpenCodeRecord = {}) =>
    router.handleEvent({
      type,
      data: { sessionID: session.providerThreadId, ...data },
    });
  return { active, emitted, event, lookup, router, session };
}

export function sessionWithTurnDiff(
  files: OpenCodeRecord[],
  onDiff?: (input: OpenCodeRecord) => void,
) {
  return sessionFixture(
    createFakeOpenCodeApi({
      session: {
        diff: async (input: OpenCodeRecord) => {
          onDiff?.(input);
          return files;
        },
      },
    }),
  );
}

export function usageFixture(
  api: () => Promise<OpenCodeClient> = emptyApi,
  hooks?: NonNullable<ConstructorParameters<typeof OpenCodeEventRouter>[3]>,
  session: Partial<SessionState> = {},
) {
  return sessionFixture(api, hooks, {
    session: {
      providerThreadId: "ses_parent",
      contextWindow: 1000,
      disableSubagents: false,
      ...session,
    },
  });
}

export function backgroundFixture(
  api: () => Promise<OpenCodeClient> = emptyApi,
  hooks?: NonNullable<ConstructorParameters<typeof OpenCodeEventRouter>[3]>,
  session: Partial<SessionState> = {},
) {
  return sessionFixture(api, hooks, {
    session: { disableSubagents: false, ...session },
  });
}

export function formApi(
  form: {
    reply?: (input: OpenCodeRecord) => Promise<void>;
    cancel?: (input: OpenCodeRecord) => Promise<void>;
    list?: () => Promise<OpenCodeRecord[]>;
  } = {},
) {
  return createFakeOpenCodeApi({
    session: {
      form: { reply: async () => {}, cancel: async () => {}, ...form },
    },
  });
}

export function permissionApi(reply: (input: OpenCodeRecord) => Promise<void>) {
  return createFakeOpenCodeApi({ permission: { reply } });
}

export function usagePayload(
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
) {
  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

export async function registerChild(
  event: (type: string, data?: OpenCodeRecord) => Promise<void>,
  callId = "call_sub",
  childId = "ses_child",
) {
  await event("session.tool.input.started", { id: callId, name: "subagent" });
  await event("session.tool.called", {
    id: callId,
    input: { agent: "explore", description: "List files", prompt: "ls" },
  });
  await event("session.tool.progress", {
    id: callId,
    metadata: { sessionID: childId, status: "running" },
  });
}

export function latestUsage(emitted: OpenCodeRecord[]) {
  return emitted.filter((delta) => delta.kind === "usage").at(-1);
}

export function latestContext(emitted: OpenCodeRecord[]) {
  return emitted.filter((delta) => delta.kind === "contextWindow").at(-1);
}

type Event = (type: string, data?: OpenCodeRecord) => Promise<void>;

export type ShellStartOptions = {
  callId?: string;
  shellId?: string;
  command?: string;
  background?: boolean;
  progress?: boolean;
  shellStarted?: boolean;
  outputFile?: string;
  success?: boolean;
  successText?: string;
  successMetadata?: OpenCodeRecord;
};

export async function startShellTask(
  event: Event,
  options: ShellStartOptions = {},
) {
  const callId = options.callId ?? "call_shell";
  const shellId = options.shellId ?? "shell_1";
  const background = options.background ?? true;
  await event("session.tool.input.started", { id: callId, name: "bash" });
  await event("session.tool.called", {
    id: callId,
    input: {
      command: options.command ?? "true",
      ...(background ? { background: true } : {}),
    },
  });
  if (options.shellStarted)
    await event("session.shell.started", {
      shell: {
        id: shellId,
        ...(options.outputFile ? { file: options.outputFile } : {}),
      },
    });
  if (options.progress)
    await event("session.tool.progress", {
      id: callId,
      metadata: { shellID: shellId, status: "running" },
    });
  const succeed = async () =>
    event("session.tool.success", {
      id: callId,
      content: [
        {
          type: "text",
          text: options.successText ?? "Command moved to the background.",
        },
      ],
      metadata: options.successMetadata ?? {
        status: "running",
        shellID: shellId,
      },
    });
  if (options.success ?? true) await succeed();
  return { callId, shellId, succeed };
}

export type SubagentStartOptions = {
  callId?: string;
  childId?: string;
  agent?: string;
  description?: string;
  prompt?: string;
  background?: boolean;
  progress?: boolean;
  success?: boolean;
  successText?: string;
  successMetadata?: OpenCodeRecord;
};

export async function startSubagentTask(
  event: Event,
  options: SubagentStartOptions = {},
) {
  const callId = options.callId ?? "call_sub";
  const childId = options.childId ?? "ses_child";
  const background = options.background ?? true;
  await event("session.tool.input.started", { id: callId, name: "subagent" });
  await event("session.tool.called", {
    id: callId,
    input: {
      agent: options.agent ?? "explore",
      description: options.description ?? "List files",
      prompt: options.prompt ?? "ls",
      ...(background ? { background: true } : {}),
    },
  });
  if (options.progress)
    await event("session.tool.progress", {
      id: callId,
      metadata: { sessionID: childId, status: "running" },
    });
  const succeed = async () =>
    event("session.tool.success", {
      id: callId,
      content: [
        {
          type: "text",
          text: options.successText ?? "working in the background",
        },
      ],
      metadata: options.successMetadata ?? {
        sessionID: childId,
        status: "running",
      },
    });
  if (options.success ?? true) await succeed();
  return { callId, childId, succeed };
}

export type ShellCompletionOptions = {
  via: "synthetic" | "session.shell.ended" | "shell.exited";
  shellId?: string;
  text?: string;
  state?: string;
  status?: string;
  exit?: number;
  command?: string;
};

export async function completeShell(
  event: Event,
  options: ShellCompletionOptions,
) {
  const shellId = options.shellId ?? "shell_1";
  const text = options.text ?? "";
  const state = options.state ?? "completed";
  const exit = options.exit ?? 0;
  const status = options.status ?? "exited";
  switch (options.via) {
    case "synthetic":
      await event("session.synthetic", {
        text: `<shell id="${shellId}" state="${state}" command="${options.command ?? "true"}">\n${text}\n</shell>`,
        metadata: { source: "shell", shellID: shellId, state, exit },
      });
      return;
    case "session.shell.ended":
      await event("session.shell.ended", {
        shell: { id: shellId, status, exit },
        output: {
          output: text,
          cursor: text.length,
          size: text.length,
          truncated: false,
        },
      });
      return;
    case "shell.exited":
      await event("shell.exited", { id: shellId, status, exit });
  }
}

export function backgroundTaskOpen(emitted: OpenCodeRecord[]) {
  return emitted.find(
    (delta) =>
      delta.kind === "item.open" && delta.item?.type === "backgroundTask",
  );
}

export function backgroundTaskClose(emitted: OpenCodeRecord[], from = 0) {
  return emitted
    .slice(from)
    .find(
      (delta) =>
        delta.kind === "item.close" && delta.item?.type === "backgroundTask",
    );
}

export function delegationClose(emitted: OpenCodeRecord[], from = 0) {
  return emitted
    .slice(from)
    .find(
      (delta) =>
        delta.kind === "item.close" && delta.item?.type === "delegation",
    );
}
