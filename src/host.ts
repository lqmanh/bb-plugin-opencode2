import {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { opencodeHostContract } from "./settings-contract.ts";
import {
  installationStatus,
  OPENCODE_LOGIN_COMMAND,
  providerHealth,
} from "./host/maintenance.ts";
import { openCodeServer } from "./host/opencode-server.ts";
import {
  getProviderUsage,
  listProviderUsage,
  usageSourceStatus,
} from "./host/opencode-usage.ts";
import { MIN_OPENCODE_VERSION } from "./host/opencode-version.ts";
import { shutdownBridge } from "./host/provider-bridge.ts";
import { nativeSkillRoots } from "./host/opencode-requests.ts";

export { createDynamicToolCallRouter } from "./host/bridge-runtime.ts";
export {
  DYNAMIC_TOOLS_MCP_ARG,
  handleDynamicToolsMcpRequest,
  startDynamicToolsMcpProxy,
} from "./host/dynamic-tools-mcp.ts";
export {
  agentSessionOption,
  mapModel,
  modelCatalogEntry,
  resolveModelVariant,
  modelRefFromOptions,
  sameModelRef,
  turnModelRef,
} from "./host/models.ts";
export {
  OpenCodeServer,
  parseOpenCodeServiceUrl,
} from "./host/opencode-server.ts";
export {
  OpenCodeEventRouter,
  shellExitCode,
  usageDeltas,
} from "./host/opencode-event-router.ts";
export {
  forkBoundaryRetainingThrough,
  isSensitiveEnvironmentKey,
  nativeSkillRoots,
  nextMessageIdAfterCheckpoint,
  revertTargetRetainingThrough,
  sessionEnvironmentVariables,
  sessionPermissionRules,
  steerAcceptedDelta,
} from "./host/opencode-requests.ts";
export {
  approvalPermissionReply,
  automaticPermissionReply,
  enabledDynamicTools,
  permissionReplyBody,
  promptBody,
  sameDynamicTools,
  selectedCommandMention,
  SUBAGENT_DISABLED_TOOL_ERROR,
  subagentDisabledToolError,
  toolFailureError,
  withoutCommandMention,
} from "./host/prompt.ts";
export {
  answerFormFields,
  planFormQuestions,
} from "./host/opencode-interactions.ts";
export { addBbToolsRule, ensureBbToolsRule } from "./host/opencode-config.ts";
export { experimental_providerBridge } from "./host/provider-bridge.ts";
export {
  agentOptionChoice,
  planAgentTransition,
  planPermissionModeForTurn,
  sessionFromParams,
} from "./host/session-manager.ts";
export { createActiveTurn } from "./host/types.ts";
export {
  releaseSessionTools,
  removeMcpServers,
  sessions,
  sessionsByProviderId,
} from "./host/session-teardown.ts";
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
} from "./host/timeline.ts";
export {
  dynamicToolRow,
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./host/tool-mapping.ts";

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
        { skills: nativeSkillRoots(skills, input.cwd), commands: [] },
        {
          warn: (message) => process.stderr.write(`[opencode2] ${message}\n`),
        },
      ).answer;
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
