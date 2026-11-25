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
    active?: (Partial<ActiveTurn> & { providerTurnId?: string }) | null;
    session?: Partial<SessionState>;
  } = {},
) {
  const emitted: OpenCodeRecord[] = [];
  const session = createTestSession(overrides.session);
  const { providerTurnId, ...activeOverrides } = overrides.active ?? {};
  const active: ActiveTurn = {
    ...createActiveTurn(providerTurnId ?? "turn-1", session.providerThreadId),
    promptIds: new Set(["msg_user"]),
    inputDelivered: true,
    ...activeOverrides,
  };
  session.active = overrides.active === null ? undefined : active;
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
  sessionID?: string;
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
  await event("session.tool.input.started", { id: callId, name: "subagent" });
  await event("session.tool.called", {
    id: callId,
    input: {
      agent: options.agent ?? "explore",
      description: options.description ?? "List files",
      prompt: options.prompt ?? "ls",
      ...(options.sessionID ? { sessionID: options.sessionID } : {}),
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

/** A synthetic inbox item carrying a background report. */
async function enqueueSynthetic(
  event: Event,
  inboxID: string,
  payload: OpenCodeRecord,
) {
  await event("session.inbox.enqueued", {
    inboxID,
    item: { type: "synthetic", payload, delivery: "steer" },
  });
}

function backgroundResult(attributes: string, text: string) {
  return `<background-result ${attributes}>\n${text}\n</background-result>`;
}

export type SubagentReportOptions = {
  text?: string;
  state?: "running" | "completed" | "error" | "cancelled";
  inboxId?: string;
};

export async function subagentReport(
  event: Event,
  options: SubagentReportOptions = {},
) {
  const childId = "ses_child";
  const state = options.state ?? "completed";
  const text = options.text ?? "Done.";
  const running =
    state === "running"
      ? "\n\nBackground work still running:\n- shell (shell_1): sleep 20"
      : "";
  await enqueueSynthetic(event, options.inboxId ?? `msg_${childId}_${state}`, {
    text: backgroundResult(
      `kind="subagent" sessionID="${childId}" state="${state}" description="List files"`,
      `${text}${running}`,
    ),
    metadata: {
      source: "subagent",
      childID: childId,
      agent: "explore",
      state: "completed",
    },
  });
}

export type ImageStartOptions = {
  callId?: string;
  jobId?: string;
  prompt?: string;
  path?: string;
  success?: boolean;
  fail?: boolean;
};

export async function startImageTask(
  event: Event,
  options: ImageStartOptions = {},
) {
  const callId = options.callId ?? "call_image";
  const jobId = options.jobId ?? "image_1";
  await event("session.tool.input.started", {
    id: callId,
    name: "generate_image",
  });
  await event("session.tool.called", {
    id: callId,
    input: { prompt: options.prompt ?? "A cat" },
  });
  const succeed = async () =>
    event("session.tool.success", {
      id: callId,
      content: [{ type: "text", text: "Image job started." }],
      metadata: {
        jobID: jobId,
        path: options.path ?? "/tmp/image",
        model: "mock/image",
      },
    });
  if (options.fail) {
    await event("session.tool.failed", {
      id: callId,
      error: { message: "Image generation denied" },
    });
  } else if (options.success ?? true) {
    await succeed();
  }
  return { callId, jobId, succeed };
}

export type ImageReportOptions = {
  jobId?: string;
  state?: "completed" | "error" | "cancelled";
  path?: string;
  text?: string;
  inboxId?: string;
};

export async function imageReport(
  event: Event,
  options: ImageReportOptions = {},
) {
  const jobId = options.jobId ?? "image_1";
  const state = options.state ?? "completed";
  const path = options.path ?? "/tmp/image.png";
  const inboxId = options.inboxId ?? `msg_${jobId}_${state}`;
  const text =
    options.text ??
    `Image request finished. Saved image: ${path} (mock/image).`;
  await enqueueSynthetic(event, inboxId, {
    text: backgroundResult(`kind="image" id="${jobId}" state="${state}"`, text),
    metadata: {
      source: "generate_image",
      jobID: jobId,
      state,
      path: path.replace(/\.[^.]+$/, ""),
      model: "mock/image",
    },
  });
  return { inboxId };
}

export async function deliverImageReport(event: Event, inboxId: string) {
  await event("session.inbox.delivered", { inboxID: inboxId });
}

export function imageHistoryMessage(
  options: { jobId?: string; path?: string; inboxId?: string } = {},
) {
  const jobId = options.jobId ?? "image_1";
  const path = options.path ?? "/tmp/image.png";
  return {
    type: "synthetic",
    id: options.inboxId ?? `msg_${jobId}_completed`,
    text: backgroundResult(
      `kind="image" id="${jobId}" state="completed"`,
      `Image request finished. Saved image: ${path} (mock/image).`,
    ),
    metadata: {
      source: "generate_image",
      jobID: jobId,
      state: "completed",
      path: path.replace(/\.[^.]+$/, ""),
    },
  };
}

function itemDelta(
  emitted: OpenCodeRecord[],
  kind: "item.open" | "item.close",
  type: string,
  from = 0,
  match: (item: OpenCodeRecord | undefined) => boolean = () => true,
) {
  return emitted
    .slice(from)
    .find(
      (delta) =>
        delta.kind === kind && delta.item?.type === type && match(delta.item),
    );
}

export function imageTaskOpen(emitted: OpenCodeRecord[]) {
  return itemDelta(
    emitted,
    "item.open",
    "backgroundTask",
    0,
    (item) => item?.taskType === "local_image",
  );
}

export function imageTaskClose(emitted: OpenCodeRecord[], from = 0) {
  return itemDelta(
    emitted,
    "item.close",
    "backgroundTask",
    from,
    (item) => item?.taskType === "local_image",
  );
}

export function imageRowOpen(emitted: OpenCodeRecord[]) {
  return itemDelta(emitted, "item.open", "imageGeneration");
}

export function imageRowClose(emitted: OpenCodeRecord[], from = 0) {
  return itemDelta(emitted, "item.close", "imageGeneration", from);
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
      await enqueueSynthetic(event, `msg_${shellId}_${state}`, {
        text: backgroundResult(
          `kind="shell" id="${shellId}" state="${state}" command="${options.command ?? "true"}"`,
          text,
        ),
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
  return itemDelta(emitted, "item.open", "backgroundTask");
}

export function backgroundTaskClose(emitted: OpenCodeRecord[], from = 0) {
  return itemDelta(emitted, "item.close", "backgroundTask", from);
}

export function delegationClose(emitted: OpenCodeRecord[], from = 0) {
  return itemDelta(emitted, "item.close", "delegation", from);
}
