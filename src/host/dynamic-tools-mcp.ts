import { createServer, createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { ExperimentalMcpAddInput } from "@opencode/client";
import {
  dynamicToolSchema,
  experimental_buildBridgeToolCallContent as buildBridgeToolCallContent,
  type DynamicTool,
} from "@get-bb/plugin-sdk/provider-bridge";
import { errorMessage } from "./types.ts";

export const DYNAMIC_TOOLS_MCP_ARG = "--opencode2-bb-tools-mcp";

const ENV_PORT = "BB_OPENCODE2_MCP_PORT";
const ENV_TOKEN = "BB_OPENCODE2_MCP_TOKEN";
const ENV_TOOLS = "BB_OPENCODE2_MCP_TOOLS";
const ENV_SESSION_ID = "BB_OPENCODE2_MCP_SESSION_ID";
const LOOPBACK_HOST = "127.0.0.1";
const MAX_PROXY_MESSAGE_BYTES = 1024 * 1024;
const PROXY_CALL_TIMEOUT_MS = 610_000;
const MAX_DYNAMIC_TOOLS = 256;

type RecordValue = Record<string, unknown>;

export type DynamicToolCall = {
  sessionId: string | undefined;
  toolName: string;
  arguments: RecordValue;
};

export type DynamicToolCallResult = {
  content: string;
  contentBlocks?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  images?: Array<{ data: string; mimeType: string }>;
  isError?: boolean;
};

type ProxyRequest = {
  token: string;
  sessionId: string | undefined;
  toolName: string;
  arguments: RecordValue;
};

type ProxyResponse =
  { ok: true; result: DynamicToolCallResult } | { ok: false; error: string };

type LocalMcpConfig = Extract<
  ExperimentalMcpAddInput["config"],
  { type: "local" }
>;

export type DynamicToolsMcpProxy = {
  readonly serverName: string;
  readonly config: LocalMcpConfig;
  close(): void;
};

export async function startDynamicToolsMcpProxy(args: {
  serverName: string;
  sessionId: string;
  tools: readonly DynamicTool[];
  entryPath: string;
  callTool: (call: DynamicToolCall) => Promise<DynamicToolCallResult>;
}): Promise<DynamicToolsMcpProxy> {
  if (args.tools.length > MAX_DYNAMIC_TOOLS) {
    throw new Error(
      `OpenCode dynamic-tools MCP supports at most ${MAX_DYNAMIC_TOOLS} tools`,
    );
  }
  const serializedTools = JSON.stringify(args.tools);
  if (Buffer.byteLength(serializedTools) > MAX_PROXY_MESSAGE_BYTES) {
    throw new Error("OpenCode dynamic-tools MCP catalog exceeds 1 MiB");
  }

  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    handleProxySocket(socket, token, args);
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new Error("OpenCode dynamic-tools MCP proxy did not bind a TCP port"),
        );
        return;
      }
      resolve({
        serverName: args.serverName,
        // `codemode: false` is important. OpenCode otherwise hides the
        // individual BB tools behind its generic Code Mode tool.
        config: {
          type: "local",
          command: [process.execPath, args.entryPath, DYNAMIC_TOOLS_MCP_ARG],
          environment: {
            // The bridge may run on an Electron binary acting as Node (BB's
            // desktop app). Without this, OpenCode would launch the app itself,
            // which exits at once, and every BB tool would be missing.
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            [ENV_PORT]: String(address.port),
            [ENV_TOKEN]: token,
            [ENV_TOOLS]: serializedTools,
            [ENV_SESSION_ID]: args.sessionId,
          },
          disabled: false,
          codemode: false,
          // OpenCode's local-MCP schema expects named positive timeout fields,
          // not a single numeric timeout value.
          timeout: { execution: 600_000 },
        },
        close,
      });
    });
  });
}

function handleProxySocket(
  socket: Socket,
  token: string,
  args: Parameters<typeof startDynamicToolsMcpProxy>[0],
): void {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.setTimeout(PROXY_CALL_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_PROXY_MESSAGE_BYTES) {
      handled = true;
      respond(socket, {
        ok: false,
        error: "Dynamic tool request exceeds 1 MiB",
      });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    let request: ProxyRequest;
    try {
      const parsed: unknown = JSON.parse(buffer.slice(0, newline));
      if (!isRecord(parsed)) throw new Error("Request must be an object");
      request = parsed as ProxyRequest;
    } catch {
      respond(socket, { ok: false, error: "Invalid dynamic tool request" });
      return;
    }
    if (
      request.token !== token ||
      request.sessionId !== args.sessionId ||
      typeof request.toolName !== "string" ||
      !isRecord(request.arguments) ||
      !args.tools.some((tool) => tool.name === request.toolName)
    ) {
      respond(socket, { ok: false, error: "Invalid dynamic tool request" });
      return;
    }
    const call: DynamicToolCall = {
      sessionId: request.sessionId,
      toolName: request.toolName,
      arguments: request.arguments,
    };
    void args.callTool(call).then(
      (result) => respond(socket, { ok: true, result }),
      (error: unknown) =>
        respond(socket, { ok: false, error: errorMessage(error) }),
    );
  });
}

function respond(socket: Socket, response: ProxyResponse): void {
  let serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized) > MAX_PROXY_MESSAGE_BYTES) {
    serialized = JSON.stringify({
      ok: false,
      error: "Dynamic tool response exceeds 1 MiB",
    } satisfies ProxyResponse);
  }
  socket.end(`${serialized}\n`);
}

export type DynamicToolsMcpRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

export type DynamicToolsMcpRuntime = {
  tools: readonly DynamicTool[];
  sessionId: string;
  callTool: (call: DynamicToolCall) => Promise<DynamicToolCallResult>;
};

/** Handles the small stdio MCP surface OpenCode uses for local tool servers. */
export async function handleDynamicToolsMcpRequest(
  runtime: DynamicToolsMcpRuntime,
  message: unknown,
  write: (message: unknown) => void,
): Promise<void> {
  const request = record(message);
  const id = request.id;
  const method = request.method;
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    typeof method !== "string"
  ) {
    return;
  }
  const result = (value: unknown) =>
    write({ jsonrpc: "2.0", id, result: value });

  switch (method) {
    case "initialize": {
      const requested = record(request.params).protocolVersion;
      result({
        protocolVersion:
          typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bb-opencode2", version: "1.0.0" },
      });
      return;
    }
    case "tools/list":
      result({
        tools: runtime.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const params = record(request.params);
      const toolName = typeof params.name === "string" ? params.name : "";
      if (!runtime.tools.some((tool) => tool.name === toolName)) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        });
        return;
      }
      const meta = record(params._meta);
      // OpenCode v2 namespaces the calling session; older builds sent
      // `_meta.sessionID`.
      const metaSessionId = meta["ai.opencode/sessionID"] ?? meta.sessionID;
      const sessionId =
        typeof metaSessionId === "string" ? metaSessionId : undefined;
      if (sessionId !== runtime.sessionId) {
        result({
          content: [
            {
              type: "text",
              text: "This BB tool is not available in this OpenCode session.",
            },
          ],
          isError: true,
        });
        return;
      }
      try {
        const callResult = await runtime.callTool({
          sessionId,
          toolName,
          arguments: record(params.arguments),
        });
        result({
          content: buildBridgeToolCallContent(callResult),
          ...(callResult.isError ? { isError: true } : {}),
        });
      } catch (error) {
        result({
          content: [{ type: "text", text: errorMessage(error) }],
          isError: true,
        });
      }
      return;
    }
    default:
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unsupported MCP method: ${method}`,
        },
      });
  }
}

export function runDynamicToolsMcpStdioChild(): void {
  const port = Number(process.env[ENV_PORT]);
  const token = process.env[ENV_TOKEN];
  const sessionId = process.env[ENV_SESSION_ID];
  const serializedTools = process.env[ENV_TOOLS];
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    !token ||
    !sessionId ||
    !serializedTools
  ) {
    throw new Error("Missing OpenCode dynamic-tools MCP environment");
  }
  const parsedTools = dynamicToolSchema
    .array()
    .max(MAX_DYNAMIC_TOOLS)
    .safeParse(JSON.parse(serializedTools));
  if (!parsedTools.success) {
    throw new Error("Invalid OpenCode dynamic-tools MCP catalog");
  }
  const tools = parsedTools.data;
  const runtime: DynamicToolsMcpRuntime = {
    tools,
    sessionId,
    callTool: (call) => callProxy({ port, token, ...call }),
  };
  const write = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim() || Buffer.byteLength(line) > MAX_PROXY_MESSAGE_BYTES)
      return;
    try {
      void handleDynamicToolsMcpRequest(runtime, JSON.parse(line), write).catch(
        () => {},
      );
    } catch {
      // An invalid JSON-RPC line has no reliable request id to answer.
    }
  });
}

function callProxy(
  args: ProxyRequest & { port: number },
): Promise<DynamicToolCallResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port: args.port });
    const request: ProxyRequest = {
      token: args.token,
      sessionId: args.sessionId,
      toolName: args.toolName,
      arguments: args.arguments,
    };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(PROXY_CALL_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("OpenCode dynamic-tools MCP proxy timed out"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_PROXY_MESSAGE_BYTES) {
        socket.destroy();
        reject(
          new Error("OpenCode dynamic-tools MCP proxy response exceeds 1 MiB"),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
          throw new Error("Invalid dynamic tool proxy response");
        }
        if (parsed.ok) {
          if (
            !isRecord(parsed.result) ||
            typeof parsed.result.content !== "string"
          ) {
            throw new Error("Invalid dynamic tool result");
          }
          resolve(parsed.result as DynamicToolCallResult);
        } else {
          const error =
            typeof parsed.error === "string"
              ? parsed.error
              : "Dynamic tool proxy failed";
          reject(new Error(error));
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n"))
        reject(
          new Error(
            "OpenCode dynamic-tools MCP proxy closed without a response",
          ),
        );
    });
  });
}

function record(value: unknown): RecordValue {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
