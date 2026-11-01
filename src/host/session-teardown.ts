import type { OpenCodeClient } from "@opencode/client";
import { dynamicToolCallRouter } from "./bridge-runtime.ts";
import type { OpenCodeApi, SessionState } from "./types.ts";

/** In-memory sessions by BB thread ID and by OpenCode session ID. */
export const sessions = new Map<string, SessionState>();
export const sessionsByProviderId = new Map<string, SessionState>();

const MCP_REMOVE_TIMEOUT_MS = 2_000;

/** A per-session BB tools MCP server OpenCode should unregister. */
export type McpServerRef = {
  serverName: string;
  cwd: string;
};

export type SessionMcpServer = McpServerRef & {
  providerThreadId: string;
};

/**
 * Settle pending BB tool calls and close the session's MCP proxy. Returns the
 * server to remove from OpenCode; the caller owns its registry entry.
 */
export function stopDynamicTools(
  session: SessionState,
  reason: string,
): SessionMcpServer | undefined {
  dynamicToolCallRouter.resolve(session.dynamicToolScope, reason);
  const proxy = session.dynamicToolProxy;
  if (!proxy) return undefined;
  session.dynamicToolProxy = undefined;
  proxy.close();
  return {
    providerThreadId: session.providerThreadId,
    serverName: proxy.serverName,
    cwd: session.cwd,
  };
}

export async function removeMcpServer(
  client: OpenCodeClient,
  server: McpServerRef,
  signal?: AbortSignal,
): Promise<void> {
  await client.experimental.mcp.remove(
    {
      server: server.serverName,
      location: { directory: server.cwd },
    },
    signal ? { signal } : undefined,
  );
}

/**
 * Close the session's dynamic tools and remove their OpenCode server. Returns
 * whether the removal succeeded; failures are left to the caller's registry
 * policy.
 */
export async function releaseSessionTools(
  session: SessionState,
  reason: string,
  api: OpenCodeApi,
): Promise<boolean> {
  const server = stopDynamicTools(session, reason);
  if (!server) return false;
  try {
    const client = await api();
    await removeMcpServer(client, server);
    return true;
  } catch {
    return false;
  }
}

/** Remove every server in parallel, returning the IDs that were removed. */
export async function removeMcpServers(
  client: OpenCodeClient,
  servers: readonly SessionMcpServer[],
): Promise<string[]> {
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      await removeMcpServer(
        client,
        server,
        AbortSignal.timeout(MCP_REMOVE_TIMEOUT_MS),
      );
      return server.providerThreadId;
    }),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}

/** Drop this session's lookup entries, leaving any replacement in place. */
export function removeSessionEntries(session: SessionState): void {
  if (sessions.get(session.bbThreadId) === session) {
    sessions.delete(session.bbThreadId);
  }
  if (sessionsByProviderId.get(session.providerThreadId) === session) {
    sessionsByProviderId.delete(session.providerThreadId);
  }
}
