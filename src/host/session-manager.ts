import { fileURLToPath } from "node:url";
import {
  AGENT_OPTION_ID,
  DEFAULT_AGENT,
  SESSION_OPTIONS_STATE_KIND,
  type ModelSettings,
} from "../settings-contract.ts";
import { dynamicToolCallRouter, emit } from "./bridge-runtime.ts";
import {
  startDynamicToolsMcpProxy,
  type DynamicToolCallResult,
} from "./dynamic-tools-mcp.ts";
import {
  agentSessionOption,
  assertModelEnabled,
  modelId,
  modelRefFromOptions,
  resolveModelVariant,
  sameModelRef,
  turnModelRef,
} from "./models.ts";
import {
  BB_INSTRUCTIONS_ENTRY,
  dynamicMcpServerName,
  resolveBbBinDir,
  sessionEnvironmentVariables,
  sessionPermissionRules,
} from "./opencode-requests.ts";
import { openCodeServer } from "./opencode-server.ts";
import { enabledDynamicTools, sameDynamicTools } from "./prompt.ts";
import {
  ARCHIVED_SESSION_MESSAGE,
  errorMessage,
  inputRecord,
  parsePermissionMode,
  stringValue,
  sessions,
  sessionsByProviderId,
  type ModelRef,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

export function sessionFromParams(
  params: RecordValue,
  providerThreadId: string,
  modelSettings: ModelSettings,
): SessionState {
  const disallowedTools = new Set(
    Array.isArray(params.disallowedTools)
      ? params.disallowedTools.filter(
          (tool): tool is string => typeof tool === "string",
        )
      : [],
  );
  const options =
    params.options && typeof params.options === "object"
      ? (params.options as RecordValue)
      : {};
  const bridgeEnvVars: Record<string, string> = {};
  if (
    options.envVars &&
    typeof options.envVars === "object" &&
    !Array.isArray(options.envVars)
  ) {
    for (const [key, value] of Object.entries(
      options.envVars as Record<string, unknown>,
    )) {
      if (typeof value === "string") bridgeEnvVars[key] = value;
    }
  }
  const enabledModels =
    modelSettings.enabledModels === null
      ? null
      : new Set(modelSettings.enabledModels);
  const model = modelRefFromOptions(options);
  assertModelEnabled(model, enabledModels);

  return {
    bbThreadId: String(params.threadId),
    providerThreadId,
    cwd: String(params.cwd),
    permissionMode: parsePermissionMode(options.permissionMode),
    // Preserve the existing policy backstop when a caller explicitly blocks
    // OpenCode's native subagent tools as well as when the plugin setting does.
    disableSubagents:
      modelSettings.disableSubagents !== false ||
      disallowedTools.has("task") ||
      disallowedTools.has("subagent"),
    dynamicTools: enabledDynamicTools(params.dynamicTools, disallowedTools),
    disallowedTools,
    enabledModels,
    instructions: stringValue(options.instructions) ?? "",
    bridgeEnvVars,
    dynamicToolScope: {},
    model,
    agentChoice: nativeAgentChoice(options),
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/** The agent BB's `agent` session option carries, when it sent one. */
function nativeAgentChoice(options: RecordValue) {
  return stringValue(inputRecord(options.sessionOptions)[AGENT_OPTION_ID]);
}

async function installDynamicTools(session: SessionState) {
  if (session.dynamicTools.length === 0) return;
  const proxy = await startDynamicToolsMcpProxy({
    serverName: dynamicMcpServerName(session.providerThreadId),
    sessionId: session.providerThreadId,
    tools: session.dynamicTools,
    entryPath: fileURLToPath(import.meta.url),
    callTool: async ({
      sessionId,
      toolName,
      arguments: toolArguments,
    }): Promise<DynamicToolCallResult> => {
      // Resolve the live session on every call so a reused proxy keeps
      // working after BB re-sends construction (resume) for the same thread.
      const current =
        sessionId !== undefined
          ? sessionsByProviderId.get(sessionId)
          : undefined;
      if (!current || current.bbThreadId !== session.bbThreadId) {
        return { content: "BB thread session not found", isError: true };
      }
      if (!current.active)
        return {
          content: "No active BB turn for this tool call",
          isError: true,
        };
      if (!current.dynamicTools.some((tool) => tool.name === toolName)) {
        return { content: `Tool "${toolName}" is disabled`, isError: true };
      }
      return dynamicToolCallRouter.forward({
        arguments: toolArguments,
        providerThreadId: current.providerThreadId,
        scope: current.dynamicToolScope,
        threadId: current.bbThreadId,
        toolName,
      });
    },
  });
  session.dynamicToolProxy = proxy;
  try {
    // `codemode: false` in the proxy config exposes each BB tool directly.
    const api = await openCodeServer.api();
    await api.experimental.mcp.add({
      server: proxy.serverName,
      location: { directory: session.cwd },
      config: proxy.config,
    });
    // OpenCode starts the MCP child asynchronously, so a turn sent right
    // after setup would not see BB's tools. Wait until it can. This runs only
    // when the server is (re)registered, not on every turn.
    await openCodeServer.waitForMcpServer(proxy.serverName, session.cwd);
    await openCodeServer.rememberMcpRegistration(session.providerThreadId, {
      serverName: proxy.serverName,
      cwd: session.cwd,
    });
  } catch (error) {
    proxy.close();
    session.dynamicToolProxy = undefined;
    throw error;
  }
}

export async function releaseDynamicTools(
  session: SessionState,
  reason: string,
) {
  dynamicToolCallRouter.resolve(session.dynamicToolScope, reason);
  const proxy = session.dynamicToolProxy;
  if (!proxy) return;
  session.dynamicToolProxy = undefined;
  proxy.close();
  try {
    const api = await openCodeServer.api();
    await api.experimental.mcp.remove({
      server: proxy.serverName,
      location: { directory: session.cwd },
    });
    await openCodeServer.forgetMcpRegistration(session.providerThreadId);
  } catch {
    // Keep the registry entry so a later discard can retry the removal.
  }
}

async function installSessionInstructions(session: SessionState) {
  const api = await openCodeServer.api();
  if (session.instructions) {
    await api.experimental.session.instructions.entry.put({
      sessionID: session.providerThreadId,
      key: BB_INSTRUCTIONS_ENTRY,
      value: session.instructions,
    });
    return;
  }
  // Empty instructions remove any entry left on a resumed session. Removing
  // an entry a new session never had reports a 404.
  await api.experimental.session.instructions.entry
    .remove({
      sessionID: session.providerThreadId,
      key: BB_INSTRUCTIONS_ENTRY,
    })
    .catch(() => {});
}

/**
 * Keep OpenCode's session ruleset in step with BB's permission mode. BB can
 * change the mode per turn, so callers pass the turn's mode; an unchanged
 * ruleset is not re-sent.
 */
export async function ensureSessionPermissions(
  session: SessionState,
  permissionMode = session.permissionMode,
  planMode = false,
) {
  const rules = sessionPermissionRules({
    permissionMode,
    disableSubagents: session.disableSubagents,
    dynamicToolServer: dynamicMcpServerName(session.providerThreadId),
    dynamicToolNames: session.dynamicTools.map((tool) => tool.name),
    planMode,
  });
  const key = JSON.stringify(rules);
  if (session.appliedPermissions === key) {
    session.permissionMode = permissionMode;
    return;
  }
  const api = await openCodeServer.api();
  await api.session.update({
    sessionID: session.providerThreadId,
    permissions: rules,
  });
  session.permissionMode = permissionMode;
  session.appliedPermissions = key;
}

async function installSessionEnvironment(session: SessionState) {
  // Best-effort: a session without the BB environment still runs, it just
  // lacks `bb` on PATH for its shells. Never fail session setup for this.
  try {
    const variables = sessionEnvironmentVariables({
      hostEnv: process.env,
      bridgeEnvVars: session.bridgeEnvVars,
      bbBinDir: await resolveBbBinDir(),
    });
    const api = await openCodeServer.api();
    await api.session.environment({
      sessionID: session.providerThreadId,
      variables,
    });
  } catch (error) {
    process.stderr.write(
      `[opencode2] Could not set OpenCode session environment: ${errorMessage(error)}\n`,
    );
  }
}

export async function registerSession(session: SessionState) {
  const previous = sessions.get(session.bbThreadId);
  if (!session.agent && previous?.providerThreadId === session.providerThreadId)
    session.agent = previous.agent;
  const state = await openCodeServer
    .sessionState(session.providerThreadId)
    .catch(() => undefined);
  session.agent ??= state?.agent;
  if (state?.archived) {
    session.terminalError = ARCHIVED_SESSION_MESSAGE;
    session.terminalKind = "archived";
  }
  const reusableProxy =
    previous &&
    previous.providerThreadId === session.providerThreadId &&
    previous.dynamicToolProxy &&
    sameDynamicTools(previous.dynamicTools, session.dynamicTools)
      ? previous.dynamicToolProxy
      : undefined;
  if (previous) {
    previous.active?.abortController.abort();
    if (reusableProxy) {
      // Same OpenCode session and tool catalog: keep the live MCP child
      // instead of re-registering (which respawns it per message). Settle
      // calls started under the previous scope; the proxy serves the new
      // session object through live lookup.
      dynamicToolCallRouter.resolve(
        previous.dynamicToolScope,
        "The BB thread session was replaced",
      );
    } else {
      await releaseDynamicTools(previous, "The BB thread session was replaced");
    }
    sessionsByProviderId.delete(previous.providerThreadId);
  }
  sessions.set(session.bbThreadId, session);
  sessionsByProviderId.set(session.providerThreadId, session);
  if (reusableProxy) session.dynamicToolProxy = reusableProxy;
  try {
    await installSessionInstructions(session);
    await ensureSessionPermissions(session);
    if (!reusableProxy) await installDynamicTools(session);
  } catch (error) {
    sessions.delete(session.bbThreadId);
    sessionsByProviderId.delete(session.providerThreadId);
    await releaseDynamicTools(session, "OpenCode session setup failed");
    throw error;
  }
  await installSessionEnvironment(session);
  // Best-effort: lets a later same-thread rewind (edit/rewind) find this
  // session even after a worker restart. A registry failure only degrades to
  // the old in-memory behavior.
  await openCodeServer
    .rememberSessionRegistration(session.bbThreadId, {
      providerThreadId: session.providerThreadId,
      cwd: session.cwd,
      usage: { ...session.usage },
    })
    .catch((error) => {
      process.stderr.write(
        `[opencode2] Could not persist OpenCode session mapping: ${errorMessage(error)}\n`,
      );
    });
}

export async function unregisterSession(
  session: SessionState,
  reason: string,
): Promise<void> {
  if (sessions.get(session.bbThreadId) === session) {
    sessions.delete(session.bbThreadId);
  }
  if (sessionsByProviderId.get(session.providerThreadId) === session) {
    sessionsByProviderId.delete(session.providerThreadId);
  }
  session.active?.abortController.abort();
  await releaseDynamicTools(session, reason);
  await openCodeServer
    .forgetSessionRegistration(session.bbThreadId)
    .catch(() => {});
}

export async function ensureSessionModel(
  session: SessionState,
  desired?: ModelRef,
  force = false,
) {
  if (!desired) return;
  assertModelEnabled(desired, session.enabledModels);
  const entry = await openCodeServer.lookupModel(session.cwd, modelId(desired));
  if (entry) session.contextWindow = entry.contextWindow;
  // BB levels the model lacks are not sent; compare what OpenCode receives.
  const resolved = resolveModelVariant(desired, entry);
  if (!force && sameModelRef(session.model, resolved)) return;
  const api = await openCodeServer.api();
  // Set the model before the call: OpenCode emits `session.model.selected`
  // while switching, and the router must recognize that event as our own.
  const previous = session.model;
  session.model = resolved;
  try {
    await api.session.switchModel({
      sessionID: session.providerThreadId,
      model: resolved,
    });
  } catch (error) {
    session.model = previous;
    throw error;
  }
}

export async function shutdownSessions(reason: string): Promise<void> {
  const currentSessions = [...sessions.values()];
  sessions.clear();
  sessionsByProviderId.clear();

  const removals = currentSessions.flatMap((session) => {
    session.active?.abortController.abort();
    dynamicToolCallRouter.resolve(session.dynamicToolScope, reason);
    const proxy = session.dynamicToolProxy;
    if (!proxy) return [];
    session.dynamicToolProxy = undefined;
    proxy.close();
    return [
      {
        providerThreadId: session.providerThreadId,
        serverName: proxy.serverName,
        cwd: session.cwd,
      },
    ];
  });

  const api =
    removals.length > 0
      ? await openCodeServer.api().catch(() => undefined)
      : undefined;
  const results = api
    ? await Promise.allSettled(
        removals.map(async ({ providerThreadId, serverName, cwd }) => {
          await api.experimental.mcp.remove(
            { server: serverName, location: { directory: cwd } },
            { signal: AbortSignal.timeout(2_000) },
          );
          return providerThreadId;
        }),
      )
    : [];
  const removedIds = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (removedIds.length > 0) {
    await openCodeServer.forgetMcpRegistrations(removedIds);
  }
}

/**
 * Switch the OpenCode agent to the one picked through BB's `agent` session
 * option. Without a pick, an agent the user chose in OpenCode itself is left
 * alone.
 */
export async function ensureSessionAgent(
  session: SessionState,
  desired?: string,
) {
  if (!desired || session.agent === desired) return;
  try {
    const api = await openCodeServer.api();
    await api.session.switchAgent({
      sessionID: session.providerThreadId,
      agent: desired,
    });
  } catch (error) {
    // A picked agent that no longer exists must not fail every turn.
    if (desired === DEFAULT_AGENT || desired === "plan") throw error;
    process.stderr.write(
      `[opencode2] Could not switch to agent ${desired}: ${errorMessage(error)}\n`,
    );
    return;
  }
  session.agent = desired;
}

/**
 * The agent BB's Agent row should show. During a plan turn it names the agent
 * the next ordinary turn returns to, matching `planAgentTransition`.
 */
export function agentOptionChoice(
  session: Pick<
    SessionState,
    "agent" | "agentChoice" | "planMode" | "agentBeforePlan"
  >,
): string | undefined {
  return session.planMode
    ? (session.agentChoice ?? session.agentBeforePlan)
    : (session.agentChoice ?? session.agent);
}

/**
 * Tell BB which agent this thread is on, so `bb thread options` and the
 * composer can show and change it after the thread exists. The model list only
 * offers the option before a thread does.
 */
export async function publishAgentOption(session: SessionState) {
  const agents = await openCodeServer
    .primaryAgents(session.cwd)
    .catch(() => undefined);
  if (!agents) return;
  const option = agentSessionOption(agents, agentOptionChoice(session));
  const options = option ? [option] : [];
  const serialized = JSON.stringify(options);
  if (session.publishedAgentOptions === serialized) return;
  session.publishedAgentOptions = serialized;
  emit(session.bbThreadId, [
    {
      kind: "extension.state",
      extensionKind: SESSION_OPTIONS_STATE_KIND,
      payload: { options },
    },
  ]);
}

/**
 * Decide which OpenCode agent a turn needs. BB's plan mode maps to OpenCode's
 * `plan` agent for one turn; the next ordinary turn returns to the agent picked
 * through the `agent` session option.
 */
export function planAgentTransition(
  session: Pick<
    SessionState,
    "agent" | "agentChoice" | "planMode" | "agentBeforePlan"
  >,
  planMode: boolean,
  newTurn: boolean,
): string | undefined {
  if (planMode) {
    if (!session.planMode) {
      session.planMode = true;
      session.agentBeforePlan =
        session.agent && session.agent !== "plan" ? session.agent : undefined;
    }
    return "plan";
  }
  // A steer belongs to the running turn; it must not leave plan mode early.
  if (!newTurn) return undefined;
  if (session.planMode) {
    session.planMode = false;
    const restore =
      session.agentChoice ?? session.agentBeforePlan ?? DEFAULT_AGENT;
    session.agentBeforePlan = undefined;
    return restore;
  }
  // The worker may have restarted after a plan turn, leaving OpenCode on the
  // plan agent without the in-memory flag.
  if (session.agent === "plan" && session.agentChoice !== "plan") {
    return session.agentChoice ?? DEFAULT_AGENT;
  }
  return session.agentChoice;
}

/**
 * Whether this turn keeps plan mode's file-edit denies. A steer joins the
 * running turn, and BB only sends `promptMode` on the message that starts the
 * plan, so the session's own flag has to carry the denies over.
 */
export function planPermissionModeForTurn(
  planMode: boolean,
  newTurn: boolean,
  sessionPlanMode: boolean | undefined,
) {
  return planMode || (!newTurn && sessionPlanMode === true);
}

/**
 * Bring the OpenCode session in line with this turn's BB options before
 * prompting: plugin settings, permission mode, agent, and model.
 */
export async function prepareTurn(
  session: SessionState,
  options: unknown,
  turn: { newTurn?: boolean } = {},
) {
  const opts = inputRecord(options);
  const settings = await openCodeServer.readModelSettings(opts.providerOptions);
  session.disableSubagents =
    settings.disableSubagents !== false ||
    session.disallowedTools.has("task") ||
    session.disallowedTools.has("subagent");
  session.enabledModels =
    settings.enabledModels === null ? null : new Set(settings.enabledModels);
  if (!session.nativeSkillNames)
    session.nativeSkillNames = await openCodeServer.nativeSkillNames(
      session.cwd,
    );
  const planMode = opts.promptMode === "plan";
  const newTurn = turn.newTurn !== false;
  await ensureSessionPermissions(
    session,
    parsePermissionMode(opts.permissionMode) ?? session.permissionMode,
    planPermissionModeForTurn(planMode, newTurn, session.planMode),
  );
  // BB sends its native choice only when it changes, so keep it for later turns.
  session.agentChoice = nativeAgentChoice(opts) ?? session.agentChoice;
  const agent = planAgentTransition(session, planMode, newTurn);
  if (agent) await ensureSessionAgent(session, agent);
  void publishAgentOption(session);
  await ensureSessionModel(session, turnModelRef(session, options));
}
