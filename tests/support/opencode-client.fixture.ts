import type { OpenCodeClient } from "@opencode/client";

/** A partial OpenCode client with the session diff stub every router test needs. */
export function createFakeOpenCodeClient(
  overrides: Record<string, any> = {},
): OpenCodeClient {
  return {
    ...overrides,
    session: {
      diff: async () => [],
      ...(overrides.session ?? {}),
    },
  } as unknown as OpenCodeClient;
}

export function createFakeOpenCodeApi(
  overrides: Record<string, any> = {},
): () => Promise<OpenCodeClient> {
  return async () => createFakeOpenCodeClient(overrides);
}
