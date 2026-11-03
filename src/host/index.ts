import {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { opencodeHostContract } from "../shared/settings-contract.ts";
import {
  installationStatus,
  OPENCODE_LOGIN_COMMAND,
  providerHealth,
} from "./opencode/maintenance.ts";
import { openCodeServer } from "./opencode/opencode-server.ts";
import {
  getProviderUsage,
  listProviderUsage,
  usageSourceStatus,
} from "./opencode/opencode-usage.ts";
import { MIN_OPENCODE_VERSION } from "./opencode/opencode-version.ts";
import { shutdownBridge } from "./bridge/provider-bridge.ts";
import { nativeSkillRoots } from "./opencode/opencode-requests.ts";

export {
  createDynamicToolCallRouter,
  handleRuntimeResponse,
  requestRuntime,
} from "./bridge/bridge-runtime.ts";
export {
  DYNAMIC_TOOLS_MCP_ARG,
  handleDynamicToolsMcpRequest,
  startDynamicToolsMcpProxy,
} from "./bridge/dynamic-tools-mcp.ts";
export {
  agentSessionOption,
  mapModel,
  modelCatalogEntry,
  resolveModelVariant,
  modelRefFromOptions,
  sameModelRef,
  turnModelRef,
} from "./opencode/models.ts";
export {
  OpenCodeServer,
  parseOpenCodeServiceUrl,
} from "./opencode/opencode-server.ts";
export {
  mergeChildUsage,
  mergeUsageTotals,
  OpenCodeEventRouter,
  shellExitCode,
  usageDeltas,
  usageTotals,
} from "./timeline/opencode-event-router.ts";
export {
  forkBoundaryRetainingThrough,
  isSensitiveEnvironmentKey,
  nativeSkillRoots,
  nextMessageIdAfterCheckpoint,
  revertTargetRetainingThrough,
  sessionEnvironmentVariables,
  sessionPermissionRules,
  steerAcceptedDelta,
} from "./opencode/opencode-requests.ts";
export {
  approvalPermissionReply,
  automaticPermissionReply,
  enabledDynamicTools,
  hasSkillMention,
  permissionReplyBody,
  promptBody,
  sameDynamicTools,
  selectedCommandMention,
  SUBAGENT_DISABLED_TOOL_ERROR,
  subagentDisabledToolError,
  toolFailureError,
  withoutCommandMention,
} from "./opencode/prompt.ts";
export {
  answerFormFields,
  planFormQuestions,
} from "./opencode/opencode-interactions.ts";
export {
  addBbToolsRule,
  ensureBbToolsRule,
  ensurePluginEntry,
  globalConfigPath,
  removePluginEntries,
  removePluginEntriesFromConfig,
  upsertPluginEntry,
} from "./opencode/opencode-config.ts";
export {
  BB_PLUGIN_VERSION,
  bbSkillsPluginPackage,
  buildNativeSkillCatalog,
  isBbSkillsPluginPackage,
  nativeSkillsLocationsDir,
  nativeSkillsRoot,
  removeNativeSkillsRoot,
  writeNativeSkillsLocation,
} from "./opencode/native-skills.ts";
export {
  experimental_providerBridge,
  stopSessionForIntent,
} from "./bridge/provider-bridge.ts";
export {
  agentOptionChoice,
  planAgentTransition,
  planPermissionModeForTurn,
  sessionFromParams,
} from "./session/session-manager.ts";
export { createActiveTurn } from "./types.ts";
export {
  releaseSessionTools,
  removeMcpServers,
  sessions,
  sessionsByProviderId,
} from "./session/session-teardown.ts";
export {
  boundedTimelineDelta,
  boundedTimelineText,
  isManualCompactionTurn,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  manualCompactionStartDeltas,
  MAX_TIMELINE_DELTA_BYTES,
  providerFailureDeltas,
  timelineDeltasForEmission,
} from "./timeline/timeline.ts";
export {
  backgroundTaskDescription,
  backgroundTaskItem,
  backgroundTaskKey,
  backgroundTaskTaskType,
  backgroundTaskUsage,
  dynamicToolRow,
  LOCAL_AGENT_TASK_TYPE,
  metadataFileChanges,
  parseBackgroundCompletion,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./timeline/tool-mapping.ts";

export default experimental_defineHostEntry({
  contract: {
    ...opencodeHostContract,
    ...experimental_nativeRootsHostContract,
  },
  handlers: {
    // BB lists these directories in the composer for OpenCode threads, so
    // skills OpenCode found on its own (~/.agents/skills, ~/.claude/skills,
    // project and config roots) can be invoked with /name.
    async resolveNativeRoots(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const skills = await openCodeServer.nativeSkills(
        input.cwd ?? process.cwd(),
      );
      return experimental_filterResolvedNativeRoots(
        {
          skills: nativeSkillRoots(
            skills,
            input.cwd,
            openCodeServer.bbCatalogRoots(),
          ),
          commands: [],
        },
        {
          warn: (message) => process.stderr.write(`[opencode2] ${message}\n`),
        },
      ).answer;
    },
    async backgroundSession(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      return openCodeServer.backgroundSession(input.threadId);
    },
    async "nativeSkills/configure"(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      return openCodeServer.setNativeSkillsEnabled(input.enabled);
    },
    async getStatus(_input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const cwd = process.cwd();
      const [health, installation] = await Promise.all([
        providerHealth(cwd),
        installationStatus(true),
      ]);
      return {
        status: health.status === "expired" ? "unauthenticated" : health.status,
        statusMessage: health.statusMessage,
        installedVersion: health.installedVersion,
        latestVersion: installation.latestVersion,
        minimumSupportedVersion: MIN_OPENCODE_VERSION,
        loginCommand: OPENCODE_LOGIN_COMMAND,
      };
    },
    "usage/list": () => listProviderUsage(() => openCodeServer.api()),
    "usage/get": (input) =>
      getProviderUsage(() => openCodeServer.api(), input.providerID, {
        bypassCache: input.bypassCache ?? false,
      }),
    "usage/status": () => usageSourceStatus(() => openCodeServer.api()),
  },
  dispose: async () => {
    await shutdownBridge("OpenCode host worker disposed");
  },
});
