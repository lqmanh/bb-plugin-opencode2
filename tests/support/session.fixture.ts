import {
  createSessionBackgroundState,
  type SessionState,
} from "../../src/host/types.ts";

export function createTestSession(
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_1",
    cwd: "/repo",
    disableSubagents: true,
    dynamicTools: [],
    disallowedTools: new Set(),
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ...createSessionBackgroundState(),
    ...overrides,
  };
}
