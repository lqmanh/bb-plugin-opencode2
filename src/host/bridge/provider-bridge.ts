import { errorMessage } from "../../shared/errors.ts";
import {
  BRIDGE_JSON_RPC_ERRORS,
  commandListParamsSchema,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  ProviderRequestDecodeError,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  THREAD_DELTA_GRAMMAR_V3,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  emit,
  handleRuntimeResponse,
  nextBridgeSequence,
  notify,
  rejectPendingRuntimeRequests,
  sendError,
  sendResult,
} from "./bridge-runtime.ts";
import {
  DYNAMIC_TOOLS_MCP_ARG,
  runDynamicToolsMcpStdioChild,
} from "./dynamic-tools-mcp.ts";
import {
  agentSessionOption,
  mapModel,
  modelCatalogEntry,
  modelRefFromOptions,
  sameModelRef,
} from "../opencode/models.ts";
import { steerAcceptedDelta } from "../opencode/opencode-requests.ts";
import {
  installationRun,
  installationStatus,
  providerHealth,
} from "../opencode/maintenance.ts";
import { nativeSkillFilePath } from "../opencode/native-skills.ts";
import {
  openCodeServer,
  type OpenCodeServer,
} from "../opencode/opencode-server.ts";
import { providerUsageAggregate } from "../opencode/opencode-usage.ts";
import {
  hasCommandMention,
  hasSkillMention,
  promptBody,
  selectedCommandMention,
  withoutCommandMention,
} from "../opencode/prompt.ts";
import {
  ensureSessionModel,
  prepareTurn,
  publishAgentOption,
  registerSession,
  releaseDynamicTools,
  sessionFromParams,
  shutdownSessions,
  unregisterSession,
} from "../session/session-manager.ts";
import {
  removeMcpServer,
  sessions,
  sessionsByProviderId,
} from "../session/session-teardown.ts";
import {
  isManualCompactionTurn,
  manualCompactionStartDeltas,
} from "../timeline/timeline.ts";
import {
  createActiveTurn,
  inputRecord,
  stringValue,
  type OpenCodeRecord,
  type SessionState,
} from "../types.ts";

type RecordValue = OpenCodeRecord;

type StopSessionClient = Pick<
  OpenCodeServer,
  "stopBackgroundTasks" | "finish" | "clearBackgroundTasks"
> & {
  api(): Promise<{
    session: {
      interrupt(input: { sessionID: string }): Promise<unknown>;
    };
  }>;
};

/** `release` leaves OpenCode work alone; `interrupt` stops it, background included. */
export async function stopSessionForIntent(
  session: SessionState | undefined,
  intent: "interrupt" | "release",
  client: StopSessionClient = openCodeServer,
) {
  if (!session) return;
  if (intent === "release") {
    client.clearBackgroundTasks(session);
    return;
  }
  await client.stopBackgroundTasks(session);
  const api = await client.api().catch(() => undefined);
  if (api)
    await api.session
      .interrupt({ sessionID: session.providerThreadId })
      .catch(() => {});
  await client.finish(session, "interrupted");
}

let configuredSkillFiles: Map<string, string> | undefined;
let configuredSkillNames: Set<string> | undefined;

function nativeSkillsOption(params: RecordValue): boolean | undefined {
  const value = inputRecord(
    inputRecord(params.options).providerOptions,
  ).nativeSkills;
  return typeof value === "boolean" ? value : undefined;
}

const PARAM_SCHEMAS = {
  initialize: initializeParamsSchema,
  "model/list": modelListParamsSchema,
  "commands/list": commandListParamsSchema,
  "provider/health": providerMaintenanceParamsSchema,
  "provider/usage": providerMaintenanceParamsSchema,
  "provider/installation/status": providerInstallationStatusParamsSchema,
  "provider/installation/run": providerInstallationRunParamsSchema,
  "thread/start": threadStartParamsSchema,
  "thread/resume": threadResumeParamsSchema,
  "thread/fork": threadForkParamsSchema,
  "thread/stop": threadStopParamsSchema,
  "thread/discard": threadDiscardParamsSchema,
  "thread/archive": threadArchiveParamsSchema,
  "thread/unarchive": threadUnarchiveParamsSchema,
  "thread/name/set": threadNameSetParamsSchema,
  "turn/start": turnStartParamsSchema,
  "turn/steer": turnSteerParamsSchema,
  "skills/configure": skillsConfigureParamsSchema,
} as const;

function providerSessionId(session: { id?: unknown }): string {
  const id = stringValue(session.id);
  if (!id) throw new Error("OpenCode did not return a session ID");
  return id;
}

function nextTurnId(): string {
  return `turn_${Date.now()}_${nextBridgeSequence()}`;
}

/**
 * Only commands OpenCode currently lists are dispatched as commands. A stale
 * BB mention stays ordinary text instead of failing the turn.
 */
async function selectedSessionCommand(
  session: SessionState,
  input: RecordValue[],
): Promise<{ name: string } | undefined> {
  if (!hasCommandMention(input)) return undefined;
  try {
    return selectedCommandMention(
      input,
      await openCodeServer.commandNames(session.cwd),
    );
  } catch {
    return undefined;
  }
}

/**
 * Route a turn's input to an OpenCode command or a normal prompt: strip the
 * plan mention, look up the command, and build the prompt body.
 */
async function prepareTurnInput(
  session: SessionState,
  input: RecordValue[],
  planMode: boolean,
) {
  const promptInput = planMode ? withoutCommandMention(input, "plan") : input;
  const command = planMode
    ? undefined
    : await selectedSessionCommand(session, promptInput);
  const bodyInput = command
    ? withoutCommandMention(promptInput, command.name)
    : promptInput;
  // Only a turn that mentions a skill needs the native registry. Fetch it
  // lazily so ordinary turns do not pay for an extra round trip.
  const nativeSkills = hasSkillMention(bodyInput)
    ? await openCodeServer.nativeSkillsState(session.cwd)
    : undefined;
  const body = promptBody(bodyInput, {
    configuredSkillNames,
    disableSubagents: session.disableSubagents,
    nativeSkills,
    nativeSkillRoots: openCodeServer.bbCatalogRoots(),
    skillFiles: configuredSkillFiles,
  });
  return { command, body };
}

async function ensureNativeSkillsForParams(params: RecordValue): Promise<void> {
  if (!configuredSkillNames) return;
  const cwd = stringValue(params.cwd);
  const enabled = nativeSkillsOption(params);
  if (!cwd || enabled === undefined) return;
  await openCodeServer.ensureNativeSkills(cwd, enabled);
}

async function configureSession(
  params: RecordValue,
  providerThreadId: string,
  forceModel: boolean,
): Promise<SessionState> {
  const session = sessionFromParams(params, providerThreadId);
  try {
    await registerSession(session);
    if (forceModel) {
      await ensureSessionModel(session, session.model, true);
    }
    return session;
  } catch (error) {
    await unregisterSession(session, "OpenCode session setup failed");
    throw error;
  }
}

function parseProviderParams(method: string, params: unknown): RecordValue {
  const schema = PARAM_SCHEMAS[method as keyof typeof PARAM_SCHEMAS];
  if (!schema) return inputRecord(params);
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ProviderRequestDecodeError(
      `Invalid ${method} params: ${path}${issue?.message ?? "validation failed"}`,
    );
  }
  return parsed.data as RecordValue;
}

async function handle(request: RecordValue) {
  const params = parseProviderParams(String(request.method), request.params);
  switch (request.method) {
    case "initialize":
      sendResult(request.id, {
        ok: true,
        protocolVersion: 2,
        capabilities: {
          sessionRestore: true,
          threadArchive: true,
          threadRename: true,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "queue",
          skills: { configure: true },
          commands: { list: true },
        },
      });
      return;
    case "provider/health": {
      sendResult(request.id, {
        supported: true,
        health: await providerHealth(params.cwd ?? process.cwd()),
      });
      return;
    }
    case "provider/usage": {
      sendResult(
        request.id,
        await providerUsageAggregate(
          () => openCodeServer.api(),
          params.cwd ?? process.cwd(),
        ),
      );
      return;
    }
    case "provider/installation/status":
      sendResult(
        request.id,
        await installationStatus(params.checkUpdates !== false),
      );
      return;
    case "provider/installation/run":
      sendResult(request.id, await installationRun(params.action));
      return;
    case "commands/list": {
      sendResult(request.id, {
        commands: await openCodeServer.commands(String(params.cwd)),
      });
      return;
    }
    case "model/list": {
      const cwd = params.cwd ?? process.cwd();
      const catalog = await openCodeServer.modelCatalog(cwd, true);
      const models = catalog.models
        .map((model) => {
          const entry = modelCatalogEntry(model);
          return { model, entry, id: entry.id };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      // Mark OpenCode's own default; fall back to the first listed model when
      // the default is unknown.
      const defaultId = models.some(({ id }) => id === catalog.defaultId)
        ? catalog.defaultId
        : models[0]?.id;
      // Agents come from this workspace, so project-level agents show up.
      const agentOption = agentSessionOption(
        await openCodeServer.primaryAgents(cwd).catch(() => []),
      );
      sendResult(request.id, {
        models: models.map(({ model, entry, id }) =>
          mapModel(
            model,
            id === defaultId,
            agentOption ? [agentOption] : [],
            entry,
          ),
        ),
        selectedOnlyModels: [],
      });
      return;
    }
    case "thread/start": {
      openCodeServer.clearThreadBroken(String(params.threadId));
      const selected = modelRefFromOptions(params.options);
      const api = await openCodeServer.api();
      await ensureNativeSkillsForParams(params);
      const result = await api.session.create({
        location: { directory: String(params.cwd) },
        ...(selected ? { model: selected } : {}),
      });
      const providerThreadId = providerSessionId(result);
      try {
        await configureSession(params, providerThreadId, false);
      } catch (error) {
        await api.session
          .remove({ sessionID: providerThreadId })
          .catch(() => {});
        throw error;
      }
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, { providerThreadId, sessionRestorable: true });
      const started = sessions.get(String(params.threadId));
      if (started) void publishAgentOption(started);
      return;
    }
    case "thread/resume": {
      openCodeServer.clearThreadBroken(String(params.threadId));
      await openCodeServer.start();
      await ensureNativeSkillsForParams(params);
      await configureSession(params, params.providerThreadId, true);
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId: params.providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, {
        providerThreadId: params.providerThreadId,
        sessionRestorable: true,
      });
      const resumed = sessions.get(String(params.threadId));
      if (resumed) void publishAgentOption(resumed);
      return;
    }
    case "thread/fork": {
      const api = await openCodeServer.api();
      await ensureNativeSkillsForParams(params);
      const existing = sessions.get(params.threadId);
      const checkpointId = stringValue(params.sourceProviderCheckpointId);
      // BB reuses the same BB thread ID when rewinding (or editing a past
      // message and resending): truncate the OpenCode session in place via
      // revert so files are restored and the session ID is preserved. A fork
      // for a *new* BB thread copies history into a child session instead.
      const sameThreadRewind =
        !!existing &&
        existing.providerThreadId === params.sourceProviderThreadId &&
        !!checkpointId;
      let statelessRewindUsage: SessionState["usage"] | undefined;
      let statelessRewind = false;
      if (!sameThreadRewind && !existing && checkpointId) {
        // No live session: this worker restarted, or another worker owns the
        // thread. A persisted same-thread mapping still identifies an
        // in-place rewind. Without one (a genuinely new BB thread, or a
        // source session held under another BB thread) fall through to fork
        // so a copy is made instead of truncating history that isn't ours.
        const sourceInMemory = sessionsByProviderId.get(
          params.sourceProviderThreadId,
        );
        if (!sourceInMemory) {
          const persisted = await openCodeServer
            .lookupSessionRegistration(params.threadId)
            .catch(() => undefined);
          if (
            persisted &&
            persisted.providerThreadId === params.sourceProviderThreadId
          ) {
            statelessRewind = true;
            statelessRewindUsage = { ...persisted.usage };
          }
        }
      }
      if ((sameThreadRewind || statelessRewind) && checkpointId) {
        if (existing?.active) {
          await api.session
            .interrupt({ sessionID: existing.providerThreadId })
            .catch(() => {});
          await openCodeServer.finish(existing, "interrupted");
        }
        await openCodeServer.rewindSessionRetainingThrough(
          params.sourceProviderThreadId,
          checkpointId,
        );
        const rewound = sessionFromParams(
          params,
          params.sourceProviderThreadId,
        );
        rewound.usage =
          existing?.usage ?? statelessRewindUsage ?? rewound.usage;
        try {
          await registerSession(rewound);
          if (existing) {
            if (rewound.model && !sameModelRef(existing.model, rewound.model)) {
              await ensureSessionModel(rewound, rewound.model, true);
            } else {
              rewound.model = existing.model ?? rewound.model;
            }
          } else if (rewound.model) {
            // Stateless rewind (no live session to compare against): converge
            // on BB's current selection like thread/resume does.
            await ensureSessionModel(rewound, rewound.model, true);
          }
        } catch (error) {
          await unregisterSession(rewound, "OpenCode rewind setup failed");
          throw error;
        }
        notify("thread/identity", {
          threadId: params.threadId,
          providerThreadId: params.sourceProviderThreadId,
          sessionRestorable: true,
        });
        sendResult(request.id, {
          providerThreadId: params.sourceProviderThreadId,
          sessionRestorable: true,
        });
        void publishAgentOption(rewound);
        return;
      }
      const boundary = await openCodeServer.forkBoundaryRetainingThrough(
        params.sourceProviderThreadId,
        checkpointId,
      );
      const result = await api.session.fork({
        sessionID: params.sourceProviderThreadId,
        ...boundary,
      });
      const providerThreadId = providerSessionId(result);
      try {
        await configureSession(params, providerThreadId, true);
      } catch (error) {
        await api.session
          .remove({ sessionID: providerThreadId })
          .catch(() => {});
        throw error;
      }
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId,
        sessionRestorable: true,
      });
      emit(params.threadId, [{ kind: "session.reset" }]);
      sendResult(request.id, { providerThreadId, sessionRestorable: true });
      const forked = sessions.get(params.threadId);
      if (forked) void publishAgentOption(forked);
      return;
    }
    case "thread/name/set": {
      const session = sessions.get(params.threadId);
      if (session) session.expectedTitle = params.title;
      try {
        const api = await openCodeServer.api();
        await api.session.update({
          sessionID: params.providerThreadId,
          title: params.title,
        });
      } catch (error) {
        if (session && session.expectedTitle === params.title)
          session.expectedTitle = undefined;
        throw error;
      }
      sendResult(request.id, { ok: true });
      return;
    }
    case "thread/archive":
    case "thread/unarchive": {
      await openCodeServer.setSessionArchived(
        String(params.providerThreadId),
        request.method === "thread/archive",
      );
      sendResult(request.id, { ok: true });
      return;
    }
    case "turn/start": {
      const session = sessions.get(params.threadId);
      if (!session)
        throw new Error(
          openCodeServer.threadBrokenReason(params.threadId) ??
            "No active OpenCode session",
        );
      if (session.terminalError) throw new Error(session.terminalError);
      if (session.active) throw new Error("An OpenCode turn is already active");
      const active = createActiveTurn(nextTurnId(), session.providerThreadId);
      session.active = active;
      if (isManualCompactionTurn(params.input)) {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        active.manualCompaction = { itemId: messageId };
        active.interaction.opened.set(messageId, { type: "compaction" });
        emit(
          session.bbThreadId,
          manualCompactionStartDeltas(
            params.clientRequestId,
            active.interaction.providerTurnId,
            messageId,
          ),
        );
        sendResult(request.id, { threadId: params.threadId });
        void (async () => {
          try {
            const api = await openCodeServer.api();
            await api.session.compact({
              sessionID: session.providerThreadId,
              id: messageId,
              delivery: "steer",
            });
          } catch (error) {
            if (session.active === active)
              await openCodeServer.finish(
                session,
                "failed",
                errorMessage(error),
              );
          }
        })();
        return;
      }
      emit(session.bbThreadId, [
        // Order matters: BB records turn/input/accepted only against an
        // already-started turn. Emitting input.accepted first (both carry the
        // same providerTurnId) makes the assembler scope the accepted event to
        // a turn BB hasn't started yet, so it is dropped, the turn keeps zero
        // accepted inputs, and BB hides Edit message / rejects edit-message
        // with "not accepted into exactly one turn".
        {
          kind: "turn.open",
          providerTurnId: active.interaction.providerTurnId,
        },
        {
          kind: "input.accepted",
          clientRequestId: params.clientRequestId,
          providerTurnId: active.interaction.providerTurnId,
        },
      ]);
      sendResult(request.id, { threadId: params.threadId });
      // The beta prompt schema does not accept per-prompt `system` or `tools`.
      // BB instructions use the session entry installed above; `disallowedTools`
      // is enforced while building the BB dynamic MCP catalog, while native
      // OpenCode tool filtering has no supported beta API surface.
      // OpenCode reasoning effort is a model variant, and the prompt endpoint
      // accepts no model: switch the session model first so the effort picker
      // reaches OpenCode, then prompt.
      // BB's plan mode is a `/plan` mention on the input; the OpenCode command
      // of that name is not executed, the session switches to the `plan` agent.
      const planMode = inputRecord(params.options).promptMode === "plan";
      // Track the user message ID optimistically so turn.boundary always
      // carries a providerCheckpointId for rewind/edit, even if the prompt
      // response is slow. The response ID should match; keep the latest. A
      // command turn has no message ID and replaces this with its inbox ID.
      const promptId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      active.checkpointId = promptId;
      active.promptIds = new Set([promptId]);
      void (async () => {
        try {
          await prepareTurn(session, params.options);
          const { command, body } = await prepareTurnInput(
            session,
            params.input,
            planMode,
          );
          const api = await openCodeServer.api();
          if (command) {
            // `session.command` returns no message ID. Keep the turn waiting
            // for the first inbox message and adopt that as its checkpoint.
            active.checkpointId = undefined;
            active.promptIds = new Set();
            active.awaitingCommandCheckpoint = true;
            await api.session.command({
              sessionID: session.providerThreadId,
              name: command.name,
              ...body,
              delivery: "steer",
            });
            active.promptDelivered = true;
            return;
          }
          const result = await api.session.prompt({
            sessionID: session.providerThreadId,
            id: promptId,
            ...body,
            delivery: "steer",
          });
          const id = stringValue(result.id);
          if (id && session.active === active) {
            active.checkpointId = id;
            active.promptIds?.add(id);
          }
          active.promptDelivered = true;
        } catch (error) {
          if (session.active === active) {
            // The optimistic prompt ID was never created in OpenCode, so it
            // must not leak into a failed turn boundary as a checkpoint.
            // Otherwise a later edit/rewind would fail with "checkpoint not
            // found" for an ID OpenCode never stored.
            active.checkpointId = undefined;
            await openCodeServer.finish(session, "failed", errorMessage(error));
          }
        }
      })();
      return;
    }
    case "turn/steer": {
      const session = sessions.get(params.threadId);
      if (!session)
        throw new Error(
          openCodeServer.threadBrokenReason(params.threadId) ??
            "No active OpenCode session",
        );
      if (session.terminalError) throw new Error(session.terminalError);
      const clientRequestId = stringValue(params.clientRequestId);
      if (!clientRequestId)
        throw new Error("Missing clientRequestId for steered input");
      // With steerMode "queue" BB keeps the follow-up row as "Steer pending"
      // until the bridge confirms acceptance, so always close the loop with
      // input.accepted (mirrors turn/start and the Codex bridge).
      let active = session.active;
      const openedTurn = !active;
      if (!active) {
        active = createActiveTurn(nextTurnId(), session.providerThreadId);
        session.active = active;
        emit(session.bbThreadId, [
          {
            kind: "turn.open",
            providerTurnId: active.interaction.providerTurnId,
          },
        ]);
      }
      const planMode = inputRecord(params.options).promptMode === "plan";
      try {
        await prepareTurn(session, params.options, { newTurn: openedTurn });
        const promptId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        // Register before sending: OpenCode may report delivery first.
        (active.promptIds ??= new Set()).add(promptId);
        const api = await openCodeServer.api();
        const { command, body } = await prepareTurnInput(
          session,
          params.input,
          planMode,
        );
        let id: string | undefined = promptId;
        if (command) {
          active.promptIds.delete(promptId);
          active.awaitingCommandCheckpoint = true;
          await api.session.command({
            sessionID: session.providerThreadId,
            name: command.name,
            ...body,
            delivery: "steer",
          });
          id = undefined;
        } else {
          const result = await api.session.prompt({
            sessionID: session.providerThreadId,
            id: promptId,
            ...body,
            delivery: "steer",
          });
          id = stringValue(result.id) ?? promptId;
        }
        if (session.active !== active) {
          throw new Error(
            "OpenCode turn ended before steered input was accepted",
          );
        }
        if (id) {
          active.checkpointId = id;
          active.promptIds.add(id);
        }
        active.promptDelivered = true;
        emit(session.bbThreadId, [
          steerAcceptedDelta(
            clientRequestId,
            active.interaction.providerTurnId,
          ),
        ]);
        sendResult(request.id, { threadId: params.threadId });
        return;
      } catch (error) {
        if (openedTurn && session.active === active) {
          await openCodeServer.finish(session, "failed", errorMessage(error));
        }
        throw error;
      }
    }
    case "thread/stop": {
      // Release leaves OpenCode work and its task rows alone. BB core settles
      // dangling rows after the host releases the thread; clearing local
      // tracking here avoids a duplicate close on late completion.
      await stopSessionForIntent(sessions.get(params.threadId), params.intent);
      sendResult(request.id, { ok: true });
      return;
    }
    case "thread/discard": {
      openCodeServer.clearThreadBroken(String(params.threadId));
      const session = sessions.get(params.threadId);
      const providerThreadId =
        session?.providerThreadId ?? stringValue(params.providerThreadId);
      if (session) {
        session.closing = true;
        const api = await openCodeServer.api().catch(() => undefined);
        if (api)
          await api.session
            .remove({ sessionID: session.providerThreadId })
            .catch(() => {
              session.closing = false;
            });
        await releaseDynamicTools(session, "The BB thread was discarded");
      } else if (providerThreadId) {
        // No local session (another host worker owns the thread, or this
        // worker restarted since setup): still remove the per-session MCP
        // bridge so OpenCode does not keep a dead server entry behind.
        const orphan =
          await openCodeServer.lookupMcpRegistration(providerThreadId);
        const api = await openCodeServer.api().catch(() => undefined);
        if (orphan && api) {
          try {
            await removeMcpServer(api, orphan);
            await openCodeServer.forgetMcpRegistration(providerThreadId);
          } catch {
            // Keep the registry entry so a later discard can retry.
          }
        }
        if (api)
          await api.session
            .remove({ sessionID: providerThreadId })
            .catch(() => {});
      }
      if (session) openCodeServer.clearSession(session);
      else if (providerThreadId)
        openCodeServer.clearChildSessions(providerThreadId);
      sessions.delete(params.threadId);
      if (providerThreadId) sessionsByProviderId.delete(providerThreadId);
      // Drop the persisted mapping so a later thread/fork for this BB thread
      // ID cannot mistake a new session for an in-place rewind target.
      await openCodeServer
        .forgetSessionRegistration(params.threadId)
        .catch(() => {});
      sendResult(request.id, { ok: true });
      return;
    }
    case "skills/configure": {
      const configured = skillsConfigureParamsSchema.parse(params);
      configuredSkillNames = new Set(
        configured.roots.flatMap((root) =>
          root.skills.map((skill) => skill.name),
        ),
      );
      configuredSkillFiles = new Map(
        configured.roots.flatMap((root) =>
          root.skills.map(
            (skill) =>
              [skill.name, nativeSkillFilePath(root.path, skill.name)] as const,
          ),
        ),
      );
      openCodeServer.setConfiguredSkillRoots(configured.roots);
      sendResult(request.id, { ok: true });
      return;
    }
    default:
      sendError(
        request.id,
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method "${request.method}"`,
      );
  }
}

function handleParsedMessage(raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const input = raw as RecordValue;
  if (handleRuntimeResponse(input)) return;
  if (
    input.id === undefined ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string"
  )
    return;
  runBridgeRequest({
    request: input as { id: string | number; method: string; params?: object },
    handleRequest: handle,
    sendError,
  });
}

const handleLine = createBridgeLineHandler({ handleParsedMessage });

// OpenCode launches this same bundled host artifact as the per-thread MCP
// child. The provider bridge export remains inert in that process.
if (process.argv.includes(DYNAMIC_TOOLS_MCP_ARG)) {
  runDynamicToolsMcpStdioChild();
}

let shutdownPromise: Promise<void> | undefined;

export function shutdownBridge(
  reason = "OpenCode bridge stopped",
): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      rejectPendingRuntimeRequests(reason);
      await shutdownSessions(reason).catch(() => {});
      await openCodeServer.stop();
    })();
  }
  return shutdownPromise;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: ({ dataDir }) => {
    openCodeServer.setDataDir(dataDir);
  },
  onClose: () => {
    void shutdownBridge("BB runtime disconnected");
  },
  onSigterm: () => {
    void shutdownBridge();
  },
  onSigint: () => {
    void shutdownBridge();
  },
});
