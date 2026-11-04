import {
  OpenCode,
  isConflictError,
  isSessionBusyError,
  type OpenCodeClient,
} from "@opencode/client";
import { Service } from "@opencode/client/service";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import type { NativeSkillsStatus } from "../../shared/settings-contract.ts";
import { pluginRuntimeDir } from "../plugin-paths.ts";
import { writeJsonFileAtomic } from "../session/persistence.ts";
import { sessions, sessionsByProviderId } from "../session/session-teardown.ts";
import {
  OpenCodeEventRouter,
  usageCostAmount,
  usageTotals,
} from "../timeline/opencode-event-router.ts";
import {
  inputRecord,
  stringValue,
  type OpenCodeRecord,
  type SessionState,
  type UsageTotals,
} from "../types.ts";
import { modelCatalogEntry, type ModelCatalogEntry } from "./models.ts";
import {
  bbSkillsPluginPackage,
  isBbSkillsPluginPackage,
  nativeSkillsLocationsDir,
  pathUnderRoots,
  pruneNativeSkillsLocations,
  removeNativeSkillsLocation,
  removeNativeSkillsRoot,
  writeNativeSkillsLocation,
  type NativeSkillRoot,
} from "./native-skills.ts";
import {
  ensureBbToolsRule,
  ensurePluginEntry,
  globalConfigPath,
  removePluginEntriesFromConfig,
} from "./opencode-config.ts";
import {
  forkBoundaryRetainingThrough,
  revertTargetRetainingThrough,
  type CheckpointMessage,
} from "./opencode-requests.ts";
import {
  MIN_OPENCODE_VERSION,
  isSupportedVersion,
  resetLatestVersionCache,
} from "./opencode-version.ts";

type RecordValue = OpenCodeRecord;

const MCP_REGISTRY_FILE = "opencode2-mcp-registry.json";
const SESSION_REGISTRY_FILE = "opencode2-session-registry.json";

const CATALOG_TTL_MS = 60_000;
const CATALOG_COLD_RETRIES = 10;
const CATALOG_COLD_RETRY_MS = 300;
const SKILLS_READY_RETRIES = 3;
const SKILLS_RELOAD_INTERVAL_MS = 30_000;
const COMMAND_CATALOG_MAX = 500;
const ARCHIVE_EVENT_TTL_MS = 30_000;
// OpenCode abandons MCP startup after 30s; this is only a last-resort guard for a missed status event.
const MCP_CONNECT_TIMEOUT_MS = 35_000;
const MCP_SETTLE_MS = 1_000;
const CONFIG_RELOAD_RETRY_MS = 30_000;
// Give up after a day of continuous activity; a service restart applies it.
const CONFIG_RELOAD_MAX_ATTEMPTS = 2_880;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_MIN_TURN_AGE_MS = 10_000;
const RECONCILE_SETTLE_MS = 5_000;

function isBusyError(error: unknown) {
  return (
    isConflictError(error) ||
    isSessionBusyError(error) ||
    /409|busy/i.test(errorMessage(error))
  );
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BASE_DELAY_MS = 400;

async function retryWhileBusy<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isBusyError(error) || attempt === BUSY_RETRY_ATTEMPTS - 1)
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, BUSY_RETRY_BASE_DELAY_MS * (attempt + 1)),
      );
    }
  }
}

export type OpenCodeModelCatalog = {
  models: RecordValue[];
  defaultId?: string;
  entries: Map<string, ModelCatalogEntry>;
};

export type McpBridgeRegistration = { serverName: string; cwd: string };

export type OpenCodeCommand = {
  name: string;
  description: string;
};

type CatalogCache<T> = Map<string, { at: number; result: Promise<T> }>;

// Persisted so an in-place rewind (BB reuses the same BB thread ID) still
// works when the host worker holding the live session is gone: after a worker
// restart, or when another worker owns the thread, thread/fork carries no
// in-memory session and would otherwise fall through to the fork path and
// copy the session instead of truncating it.
export type SessionBridgeRegistration = {
  providerThreadId: string;
  cwd: string;
  usage: UsageTotals;
};

export function parseOpenCodeServiceUrl(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (!token) {
    throw new Error("OpenCode service did not report a server URL");
  }

  let url: URL;
  try {
    url = new URL(token);
  } catch {
    throw new Error("OpenCode service reported an invalid server URL");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("OpenCode service must use an HTTP loopback URL");
  }
  if (url.username || url.password) {
    throw new Error("OpenCode service URL must not contain credentials");
  }
  return url.origin;
}

export class OpenCodeServer {
  private client?: OpenCodeClient;
  private starting?: Promise<void>;
  private dataDir?: string;
  private nativeSkillsPackage?: string;
  private configuredSkillRoots: readonly NativeSkillRoot[] = [];
  private configuredSkillRealRoots = new Set<string>();
  private nativeSkillsConfigDirty = false;
  private nativeSkillsCleanupChecked = false;
  private nativeSkillsLastReloadAt = 0;
  private nativeSkillsUnreadyLogged = false;
  private eventAbortController?: AbortController;
  private watchdog?: ReturnType<typeof setInterval>;
  private connectionGeneration = 0;
  private readonly eventRouter = new OpenCodeEventRouter(
    () => this.api(),
    undefined,
    sessionsByProviderId,
    {
      onSessionGone: (session, reason) => this.sessionGone(session, reason),
    },
  );

  setDataDir(dataDir: string) {
    this.dataDir = dataDir;
  }

  private async ensureHostConfig() {
    try {
      if ((await ensureBbToolsRule()) === "added") this.reloadConfigWhenIdle();
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not update OpenCode's global config: ${errorMessage(error)}\n`,
      );
    }
  }

  setConfiguredSkillRoots(roots: readonly NativeSkillRoot[]) {
    const next = roots.map((root) => ({
      ...root,
      path: resolve(root.path),
    }));
    if (JSON.stringify(next) === JSON.stringify(this.configuredSkillRoots))
      return;
    this.configuredSkillRoots = next;
    this.configuredSkillRealRoots = new Set();
    for (const root of this.configuredSkillRoots) {
      this.configuredSkillRealRoots.add(root.path);
      try {
        this.configuredSkillRealRoots.add(realpathSync(root.path));
      } catch {
        // The catalog may already be gone; the resolved path is still useful.
      }
    }
    if (!this.nativeSkillsPackage || !this.dataDir) return;
    for (const cwd of new Set([...sessions.values()].map((s) => s.cwd))) {
      void writeNativeSkillsLocation(
        this.dataDir,
        cwd,
        this.configuredSkillRoots,
      ).catch(() => {});
    }
  }

  bbCatalogRoots(): ReadonlySet<string> {
    return this.configuredSkillRealRoots;
  }

  async setNativeSkillsEnabled(enabled: boolean): Promise<NativeSkillsStatus> {
    const dataDir = this.dataDir;
    if (!dataDir) {
      return { enabled, error: "Host data directory is not set" };
    }
    const configPath = globalConfigPath();
    try {
      if (enabled) {
        const packageSpec = bbSkillsPluginPackage();
        const locationsDir = nativeSkillsLocationsDir(dataDir);
        const changed =
          (await ensurePluginEntry(configPath, isBbSkillsPluginPackage, {
            package: packageSpec,
            options: { locationsDir },
          })) === "changed";
        await pruneNativeSkillsLocations(dataDir).catch(() => {});
        this.nativeSkillsPackage = packageSpec;
        this.nativeSkillsCleanupChecked = false;
        this.nativeSkillsLastReloadAt = 0;
        this.nativeSkillsUnreadyLogged = false;
        if (changed) this.nativeSkillsConfigDirty = true;
        await this.settleNativeSkillsConfig();
        return { enabled: true, packageSpec, locationsDir };
      }

      await removeNativeSkillsRoot(dataDir).catch(() => {});
      const changed =
        (await removePluginEntriesFromConfig(
          configPath,
          isBbSkillsPluginPackage,
        )) === "removed";
      this.nativeSkillsPackage = undefined;
      this.nativeSkillsLastReloadAt = 0;
      this.nativeSkillsUnreadyLogged = false;
      this.nativeSkillsCleanupChecked = true;
      if (changed) this.nativeSkillsConfigDirty = true;
      await this.settleNativeSkillsConfig();
      return { enabled: false };
    } catch (error) {
      if (enabled) {
        this.nativeSkillsPackage = undefined;
      } else {
        this.nativeSkillsCleanupChecked = false;
      }
      return { enabled, error: errorMessage(error) };
    }
  }

  private async settleNativeSkillsConfig() {
    if (!this.nativeSkillsConfigDirty || !this.client) return;
    if (await this.reloadConfigWhenIdleAsync())
      this.nativeSkillsConfigDirty = false;
  }

  private logNativeSkillsUnavailable(error: string) {
    process.stderr.write(
      `[opencode2] Native skills are unavailable: ${error}\n`,
    );
  }

  async ensureNativeSkills(cwd: string, enabled: boolean): Promise<boolean> {
    const dataDir = this.dataDir;
    if (!dataDir) return false;
    try {
      if (!enabled) {
        await removeNativeSkillsLocation(dataDir, cwd).catch(() => {});
        if (this.nativeSkillsPackage || !this.nativeSkillsCleanupChecked) {
          const status = await this.setNativeSkillsEnabled(false);
          if (status.error) {
            this.logNativeSkillsUnavailable(status.error);
            return false;
          }
        }
        return true;
      }

      const expectedNames = new Set(
        await writeNativeSkillsLocation(
          dataDir,
          cwd,
          this.configuredSkillRoots,
        ),
      );
      const packageSpec = bbSkillsPluginPackage();
      if (this.nativeSkillsPackage !== packageSpec) {
        const status = await this.setNativeSkillsEnabled(true);
        if (status.error) {
          this.logNativeSkillsUnavailable(status.error);
          return false;
        }
      }
      await this.api();
      await this.settleNativeSkillsConfig();
      if (await this.nativeSkillsReady(cwd, expectedNames)) {
        this.nativeSkillsUnreadyLogged = false;
        return true;
      }
      if (!this.nativeSkillsUnreadyLogged) {
        this.nativeSkillsUnreadyLogged = true;
        process.stderr.write(
          "[opencode2] Native skills are not ready; using SKILL.md attachments\n",
        );
      }
      if (
        Date.now() - this.nativeSkillsLastReloadAt >
        SKILLS_RELOAD_INTERVAL_MS
      ) {
        this.nativeSkillsLastReloadAt = Date.now();
        this.reloadConfigWhenIdle();
      }
      return false;
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not prepare native OpenCode skills: ${errorMessage(error)}\n`,
      );
      return false;
    }
  }

  async nativeSkillsReady(
    cwd: string,
    expectedNames: ReadonlySet<string>,
  ): Promise<boolean> {
    if (expectedNames.size === 0) return true;
    const roots = this.bbCatalogRoots();
    for (let attempt = 0; attempt < SKILLS_READY_RETRIES; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, CATALOG_COLD_RETRY_MS),
        );
      const skills = await this.nativeSkillsState(cwd);
      const ready = [...expectedNames].every((name) => {
        const path = skills?.get(name);
        return path !== undefined && pathUnderRoots(path, roots);
      });
      if (ready) return true;
    }
    return false;
  }

  // Tracks per-session MCP bridges so discard can remove OpenCode's
  // registration even when this worker holds no session state (another host
  // worker owns the thread, or this worker restarted since setup). Entries
  // persist to the host data dir; a failed DELETE keeps its entry for retry.
  private mcpRegistry = new Map<string, McpBridgeRegistration>();
  private readonly mcpWaiters = new Map<
    string,
    Set<{ check(): Promise<void> }>
  >();
  private mcpRegistryLoaded = false;
  private mcpRegistryOperation: Promise<void> = Promise.resolve();

  private mcpRegistryPath() {
    return this.dataDir ? join(this.dataDir, MCP_REGISTRY_FILE) : undefined;
  }

  private async withMcpRegistryLock<T>(operation: () => Promise<T>) {
    const result = this.mcpRegistryOperation.then(operation, operation);
    this.mcpRegistryOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadMcpRegistry() {
    if (this.mcpRegistryLoaded) return;
    this.mcpRegistryLoaded = true;
    const path = this.mcpRegistryPath();
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          const record = value as Record<string, unknown> | null;
          if (
            record &&
            typeof record.serverName === "string" &&
            typeof record.cwd === "string"
          ) {
            this.mcpRegistry.set(key, {
              serverName: record.serverName,
              cwd: record.cwd,
            });
          }
        }
      }
    } catch {
      // Missing or corrupt registry: treat as empty and rebuild from here.
    }
  }

  async rememberMcpRegistration(
    providerThreadId: string,
    entry: McpBridgeRegistration,
  ) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = this.mcpRegistry.get(providerThreadId);
      this.mcpRegistry.set(providerThreadId, entry);
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        if (previous) this.mcpRegistry.set(providerThreadId, previous);
        else this.mcpRegistry.delete(providerThreadId);
        throw error;
      }
    });
  }

  async forgetMcpRegistration(providerThreadId: string) {
    await this.forgetMcpRegistrations([providerThreadId]);
  }

  async forgetMcpRegistrations(providerThreadIds: readonly string[]) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = new Map<string, McpBridgeRegistration>();
      for (const providerThreadId of providerThreadIds) {
        const entry = this.mcpRegistry.get(providerThreadId);
        if (entry) previous.set(providerThreadId, entry);
        this.mcpRegistry.delete(providerThreadId);
      }
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        for (const [providerThreadId, entry] of previous) {
          this.mcpRegistry.set(providerThreadId, entry);
        }
        throw error;
      }
    });
  }

  async lookupMcpRegistration(
    providerThreadId: string,
  ): Promise<McpBridgeRegistration | undefined> {
    return this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      return this.mcpRegistry.get(providerThreadId);
    });
  }

  private async writeMcpRegistry() {
    const path = this.mcpRegistryPath();
    if (!path || !this.dataDir) return;
    await writeJsonFileAtomic(path, Object.fromEntries(this.mcpRegistry));
  }

  private sessionRegistry = new Map<string, SessionBridgeRegistration>();
  private sessionRegistryOperation: Promise<void> = Promise.resolve();

  /**
   * The host worker resolves background actions and the provider bridge
   * registers sessions, so the registry must live where both can read it.
   */
  private sessionRegistryPath() {
    return this.dataDir
      ? join(pluginRuntimeDir(this.dataDir), SESSION_REGISTRY_FILE)
      : undefined;
  }

  private async withSessionRegistryLock<T>(operation: () => Promise<T>) {
    const result = this.sessionRegistryOperation.then(operation, operation);
    this.sessionRegistryOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readSessionRegistry(
    path: string,
  ): Promise<Map<string, SessionBridgeRegistration> | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
      const entries = new Map<string, SessionBridgeRegistration>();
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        const record = value as Record<string, unknown> | null;
        const usage = (record?.usage ?? {}) as Record<string, unknown>;
        if (
          record &&
          typeof record.providerThreadId === "string" &&
          typeof record.cwd === "string"
        ) {
          entries.set(key, {
            providerThreadId: record.providerThreadId,
            cwd: record.cwd,
            usage: {
              input: nonNegativeNumber(usage.input),
              output: nonNegativeNumber(usage.output),
              reasoning: nonNegativeNumber(usage.reasoning),
              cacheRead: nonNegativeNumber(usage.cacheRead),
              cacheWrite: nonNegativeNumber(usage.cacheWrite),
            },
          });
        }
      }
      return entries;
    } catch {
      // Missing or corrupt registry: treat as empty.
      return undefined;
    }
  }

  private async loadSessionRegistry() {
    // Reload before mutating so a write merges sessions registered by another
    // worker instead of replacing them with a stale snapshot.
    const path = this.sessionRegistryPath();
    const entries = path ? await this.readSessionRegistry(path) : undefined;
    this.sessionRegistry =
      entries ?? new Map<string, SessionBridgeRegistration>();
  }

  private async writeSessionRegistry() {
    const path = this.sessionRegistryPath();
    if (!path) return;
    await writeJsonFileAtomic(path, Object.fromEntries(this.sessionRegistry));
  }

  async rememberSessionRegistration(
    bbThreadId: string,
    entry: SessionBridgeRegistration,
  ) {
    await this.withSessionRegistryLock(async () => {
      await this.loadSessionRegistry();
      const previous = this.sessionRegistry.get(bbThreadId);
      this.sessionRegistry.set(bbThreadId, entry);
      try {
        await this.writeSessionRegistry();
      } catch (error) {
        if (previous) this.sessionRegistry.set(bbThreadId, previous);
        else this.sessionRegistry.delete(bbThreadId);
        throw error;
      }
    });
  }

  async forgetSessionRegistration(bbThreadId: string) {
    await this.withSessionRegistryLock(async () => {
      await this.loadSessionRegistry();
      const previous = this.sessionRegistry.get(bbThreadId);
      this.sessionRegistry.delete(bbThreadId);
      try {
        await this.writeSessionRegistry();
      } catch (error) {
        if (previous) this.sessionRegistry.set(bbThreadId, previous);
        throw error;
      }
    });
  }

  async lookupSessionRegistration(
    bbThreadId: string,
  ): Promise<SessionBridgeRegistration | undefined> {
    // Reads bypass the write lock and always hit disk so a session registered
    // by another worker is visible on the next lookup.
    const path = this.sessionRegistryPath();
    if (!path) return undefined;
    return (await this.readSessionRegistry(path))?.get(bbThreadId);
  }

  async start() {
    if (this.client) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    const generation = ++this.connectionGeneration;
    this.starting = this.connect(generation);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async connect(generation: number) {
    // OpenCode runs one shared background service for everything. Connect to
    // it instead of spawning a private server: per-worker servers would hold
    // disjoint session state, so sessions created on one worker could not be
    // resumed from another.
    const endpoint = await Service.ensure({
      command: ["opencode2", "serve", "--service"],
    });
    const url = parseOpenCodeServiceUrl(endpoint.url);
    if (generation !== this.connectionGeneration) {
      throw new Error("OpenCode connection was stopped during startup");
    }
    const client = OpenCode.make({
      baseUrl: url,
      headers: Service.headers(endpoint) ?? {},
      // Keep the API's previous request budget; streaming calls pass their
      // own abort signal and are left alone.
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(30_000),
        }),
    });
    // Service.ensure's version predicate would stop and replace the shared
    // service. Check after connecting instead, so an outdated installed CLI
    // cannot make the plugin stop a service it cannot replace.
    const info = await client.server.info();
    if (!isSupportedVersion(info.version))
      throw new Error(
        `OpenCode ${info.version} is older than ${MIN_OPENCODE_VERSION}. Run \`opencode2 upgrade\`.`,
      );
    if (generation !== this.connectionGeneration) {
      throw new Error("OpenCode connection was stopped during startup");
    }
    this.client = client;
    this.eventAbortController?.abort();
    this.eventAbortController = new AbortController();
    void this.consumeEvents(this.eventAbortController.signal);
    if (!this.watchdog) {
      this.watchdog = setInterval(
        () => void this.reconcileActiveTurns(),
        RECONCILE_INTERVAL_MS,
      );
      this.watchdog.unref();
    }
    void this.ensureHostConfig();
  }

  async api(): Promise<OpenCodeClient> {
    await this.start();
    if (!this.client) throw new Error("OpenCode service is not connected");
    return this.client;
  }

  private async cachedCatalog<T>(
    cache: CatalogCache<T>,
    cwd: string,
    fresh: boolean,
    load: () => Promise<T>,
    isEmpty: (value: T) => boolean,
  ): Promise<T> {
    const cached = cache.get(cwd);
    if (!fresh && cached && Date.now() - cached.at < CATALOG_TTL_MS)
      return cached.result;
    const result = load();
    cache.set(cwd, { at: Date.now(), result });
    const forget = () => {
      if (cache.get(cwd)?.result === result) cache.delete(cwd);
    };
    result.then((value) => {
      if (isEmpty(value)) forget();
    }, forget);
    return result;
  }

  /**
   * A location OpenCode has not loaded yet answers with an empty list for a
   * few hundred milliseconds, so retry briefly before trusting it.
   */
  private async coldList<T>(load: () => Promise<T[]>): Promise<T[]> {
    let items: T[] = [];
    for (let attempt = 0; attempt < CATALOG_COLD_RETRIES; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, CATALOG_COLD_RETRY_MS),
        );
      items = await load();
      if (items.length > 0) break;
    }
    return items;
  }

  private modelCatalogs: CatalogCache<OpenCodeModelCatalog> = new Map();

  /**
   * OpenCode's models and default model for a workspace. Cached briefly so a
   * turn's model switch can resolve variants and context limits without
   * re-listing hundreds of models.
   */
  async modelCatalog(
    cwd: string,
    fresh = false,
  ): Promise<OpenCodeModelCatalog> {
    return this.cachedCatalog(
      this.modelCatalogs,
      cwd,
      fresh,
      async () => {
        const api = await this.api();
        const location = { directory: cwd };
        const models = await this.coldList(async () => {
          const list = await api.model.list({ location });
          return (Array.isArray(list.data) ? list.data : [])
            .map(inputRecord)
            .filter(
              (model) =>
                model.enabled !== false &&
                stringValue(model.providerID) !== undefined &&
                stringValue(model.id) !== undefined,
            );
        });
        const fallback = await api.model
          .default({ location })
          .catch(() => undefined);
        const defaultModel = inputRecord(fallback?.data);
        const defaultId =
          stringValue(defaultModel.providerID) && stringValue(defaultModel.id)
            ? `${defaultModel.providerID}/${defaultModel.id}`
            : undefined;
        return {
          models,
          defaultId,
          entries: new Map(
            models.map((model) => {
              const entry = modelCatalogEntry(model);
              return [entry.id, entry] as const;
            }),
          ),
        };
      },
      (catalog) => catalog.models.length === 0,
    );
  }

  async lookupModel(
    cwd: string,
    id: string,
  ): Promise<ModelCatalogEntry | undefined> {
    try {
      return (await this.modelCatalog(cwd)).entries.get(id);
    } catch {
      return undefined;
    }
  }

  private commandCatalogs: CatalogCache<OpenCodeCommand[]> = new Map();

  /** OpenCode's slash commands for a workspace, cached briefly. */
  async commands(cwd: string): Promise<OpenCodeCommand[]> {
    return this.cachedCatalog(
      this.commandCatalogs,
      cwd,
      false,
      async () => {
        const api = await this.api();
        const data = await this.coldList(async () => {
          const list = await api.command.list({ location: { directory: cwd } });
          return Array.isArray(list.data) ? list.data : [];
        });
        const seen = new Set<string>();
        const commands: OpenCodeCommand[] = [];
        for (const value of data) {
          const command = inputRecord(value);
          const name = stringValue(command.name);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          commands.push({
            name,
            description: stringValue(command.description) ?? "",
          });
          if (commands.length === COMMAND_CATALOG_MAX) break;
        }
        return commands;
      },
      (commands) => commands.length === 0,
    );
  }

  async commandNames(cwd: string): Promise<Set<string>> {
    return new Set((await this.commands(cwd)).map((command) => command.name));
  }

  invalidateModelCatalogs() {
    this.modelCatalogs.clear();
  }

  invalidateCommands() {
    this.commandCatalogs.clear();
  }

  /** The OpenCode state a registered session needs to keep its own flags. */
  async sessionState(sessionId: string): Promise<{
    agent?: string;
    archived: boolean;
    usage: UsageTotals;
    cost?: number;
  }> {
    const api = await this.api();
    const info = inputRecord(await api.session.get({ sessionID: sessionId }));
    const agent = stringValue(info.agent);
    const cost = usageCostAmount(info.cost);
    return {
      ...(agent ? { agent } : {}),
      archived: typeof inputRecord(info.time).archived === "number",
      usage: usageTotals(info.tokens),
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  async reconcileChildSessions(session: SessionState): Promise<void> {
    await this.eventRouter.reconcileChildSessions(session);
  }

  async reconcileBackgroundTasks(session: SessionState): Promise<void> {
    await this.eventRouter.reconcileBackgroundTasks(session);
  }

  clearChildSessions(providerThreadId?: string): void {
    this.eventRouter.clearChildSessions(providerThreadId);
  }

  clearBackgroundTasks(session: SessionState): void {
    this.eventRouter.clearBackgroundTasks(session);
  }

  clearSession(session: SessionState): void {
    this.eventRouter.clearSession(session);
  }

  async backgroundSession(threadId: string): Promise<{ ok: true }> {
    const providerThreadId =
      sessions.get(threadId)?.providerThreadId ??
      (await this.lookupSessionRegistration(threadId))?.providerThreadId;
    if (!providerThreadId)
      throw new Error("No OpenCode session is registered for this thread");
    const api = await this.api();
    await api.session.background({ sessionID: providerThreadId });
    return { ok: true };
  }

  async stopBackgroundTasks(session: SessionState): Promise<void> {
    const tasks = [...session.backgroundTasks.values()].filter(
      (task) => !task.settled,
    );
    if (tasks.length === 0) return;
    const api = await this.api().catch(() => undefined);
    await Promise.allSettled(
      tasks.map(async (task) => {
        if (!api) return;
        if (task.shellId)
          await api.shell.remove({
            id: task.shellId,
            location: { directory: session.cwd },
          });
        else if (task.childSessionId)
          await api.session.interrupt({ sessionID: task.childSessionId });
      }),
    );
    this.eventRouter.interruptBackgroundTasks(session, "Thread stopped");
  }

  private readonly expectedArchiveEvents = new Map<
    string,
    { archived: boolean; at: number }
  >();

  /**
   * Archive through BB. The resulting OpenCode event is ours, so the lifecycle
   * handler must not present it as an external archive.
   */
  async setSessionArchived(sessionId: string, archived: boolean) {
    const api = await this.api();
    const now = Date.now();
    for (const [id, expected] of this.expectedArchiveEvents)
      if (now - expected.at > ARCHIVE_EVENT_TTL_MS)
        this.expectedArchiveEvents.delete(id);
    this.expectedArchiveEvents.set(sessionId, { archived, at: now });
    try {
      await api.session.update({ sessionID: sessionId, archived });
    } catch (error) {
      if (this.expectedArchiveEvents.get(sessionId)?.archived === archived)
        this.expectedArchiveEvents.delete(sessionId);
      throw error;
    }
    if (!archived) {
      const session = sessionsByProviderId.get(sessionId);
      if (session?.terminalKind === "archived") {
        session.terminalError = undefined;
        session.terminalKind = undefined;
      }
    }
  }

  private consumeExpectedArchive(sessionId: string, archived: boolean) {
    const expected = this.expectedArchiveEvents.get(sessionId);
    if (!expected || expected.archived !== archived) return false;
    if (Date.now() - expected.at > ARCHIVE_EVENT_TTL_MS) {
      this.expectedArchiveEvents.delete(sessionId);
      return false;
    }
    this.expectedArchiveEvents.delete(sessionId);
    return true;
  }

  private readonly brokenThreads = new Map<string, string>();

  markThreadBroken(bbThreadId: string, reason: string) {
    this.brokenThreads.set(bbThreadId, reason);
  }

  clearThreadBroken(bbThreadId: string) {
    this.brokenThreads.delete(bbThreadId);
  }

  threadBrokenReason(bbThreadId: string): string | undefined {
    return this.brokenThreads.get(bbThreadId);
  }

  private async sessionGone(session: SessionState, reason: string) {
    this.markThreadBroken(session.bbThreadId, reason);
    await this.forgetDetachedSession(session);
  }

  private async forgetDetachedSession(session: SessionState) {
    await this.forgetSessionRegistration(session.bbThreadId).catch(() => {});
    await this.forgetMcpRegistration(session.providerThreadId).catch(() => {});
  }

  /**
   * Agents a user can pick as a session's primary agent: OpenCode's `primary`
   * and `all` modes, minus hidden ones. Subagent-only agents are reached
   * through delegation instead.
   */
  async primaryAgents(
    cwd: string,
  ): Promise<{ id: string; description?: string }[]> {
    const api = await this.api();
    const result = await api.agent.list({ location: { directory: cwd } });
    return (Array.isArray(result.data) ? result.data : []).flatMap(
      (value: unknown) => {
        const agent = inputRecord(value);
        const id = stringValue(agent.id ?? agent.name);
        if (!id || agent.hidden === true || agent.mode === "subagent")
          return [];
        const description = stringValue(agent.description);
        return [{ id, ...(description ? { description } : {}) }];
      },
    );
  }

  /** Skills OpenCode discovered for a workspace: ID and SKILL.md path. */
  async nativeSkills(cwd: string): Promise<{ id: string; path?: string }[]> {
    const api = await this.api();
    const result = await api.skill.list({ location: { directory: cwd } });
    return (Array.isArray(result.data) ? result.data : []).flatMap(
      (value: unknown) => {
        const skill = inputRecord(value);
        const id = stringValue(skill.id ?? skill.name);
        if (!id) return [];
        const path = stringValue(skill.location ?? skill.path);
        return [{ id, ...(path ? { path } : {}) }];
      },
    );
  }

  async nativeSkillsState(
    cwd: string,
  ): Promise<Map<string, string | undefined> | undefined> {
    try {
      return new Map(
        (await this.nativeSkills(cwd)).map(
          (skill) => [skill.id, skill.path] as const,
        ),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Wait until OpenCode reports a runtime MCP server connected. Gives up
   * quietly after the timeout or when the server failed: the session still
   * works, only without that server's tools, and the failure is logged.
   */
  async waitForMcpServer(
    serverName: string,
    cwd: string,
    timeoutMs = MCP_CONNECT_TIMEOUT_MS,
  ): Promise<boolean> {
    const api = await this.api().catch(() => undefined);
    if (!api) {
      process.stderr.write(
        `[opencode2] BB tool server ${serverName} could not be checked: OpenCode service is unavailable\n`,
      );
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let last = "unknown";
      let waiters = this.mcpWaiters.get(serverName);
      if (!waiters) {
        waiters = new Set();
        this.mcpWaiters.set(serverName, waiters);
      }
      const cleanup = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.mcpWaiters.delete(serverName);
      };
      const finish = async (status: "connected" | "failed", error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (status === "connected") {
          // OpenCode lists the server's tools before it reports "connected",
          // but refreshes the tool set a session step sees a few hundred
          // milliseconds later, with no event to wait on. Measured under
          // 500 ms on OpenCode 2.0.27.
          await new Promise((settle) => setTimeout(settle, MCP_SETTLE_MS));
          resolve(true);
          return;
        }
        process.stderr.write(
          `[opencode2] BB tool server ${serverName} failed to start: ${error ?? "unknown error"}\n`,
        );
        resolve(false);
      };
      const check = async () => {
        if (settled) return;
        const result = await api.mcp
          .list({ location: { directory: cwd } })
          .catch((): OpenCodeRecord => ({}));
        const server = (Array.isArray(result.data) ? result.data : [])
          .map(inputRecord)
          .find((entry) => entry.name === serverName);
        const status = inputRecord(server?.status);
        last = stringValue(status.status) ?? "missing";
        if (last === "connected") void finish("connected");
        else if (last === "failed")
          void finish("failed", stringValue(status.error));
      };
      const waiter = { check };
      waiters.add(waiter);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        process.stderr.write(
          `[opencode2] BB tool server ${serverName} did not connect within ${timeoutMs} ms (last status: ${last})\n`,
        );
        resolve(false);
      }, timeoutMs);
      void check();
    });
  }

  private reloadTimer?: ReturnType<typeof setTimeout>;

  private async isIdle(api: OpenCodeClient): Promise<boolean> {
    const [permissions, forms, active] = await Promise.all([
      api.permission.request.list(),
      api.form.list(),
      api.session.active(),
    ]);
    return !(
      (Array.isArray(permissions.data) && permissions.data.length > 0) ||
      (Array.isArray(forms.data) && forms.data.length > 0) ||
      Object.keys(inputRecord(active)).length > 0
    );
  }

  /**
   * OpenCode reads its global config once; a changed file takes effect on the
   * next location reload. A reload cancels every pending approval and
   * question service-wide, so only do it while OpenCode is idle (nothing
   * pending, no running session) and otherwise try again later.
   */
  private async reloadConfigNow(): Promise<boolean> {
    try {
      const api = await this.api();
      if (!(await this.isIdle(api))) return false;
      // A location whose directory was deleted makes the reload report 503,
      // but every other location still reloads.
      await api.location.reload().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  reloadConfigWhenIdle(attempt = 0) {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    void (async () => {
      if (await this.reloadConfigNow()) return;
      if (attempt + 1 >= CONFIG_RELOAD_MAX_ATTEMPTS) return;
      this.reloadTimer = setTimeout(
        () => this.reloadConfigWhenIdle(attempt + 1),
        CONFIG_RELOAD_RETRY_MS,
      );
      this.reloadTimer.unref();
    })();
  }

  async reloadConfigWhenIdleAsync(timeoutMs = 5_000): Promise<boolean> {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.reloadConfigNow()) {
        await new Promise((done) => setTimeout(done, 250));
        return true;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    this.reloadConfigWhenIdle();
    return false;
  }

  async listSessionMessageIds(sessionId: string): Promise<CheckpointMessage[]> {
    const messages: CheckpointMessage[] = [];
    let cursor: string | undefined;
    const maxPages = 100;
    const api = await this.api();
    for (let page = 0; page < maxPages; page++) {
      // OpenCode rejects combining a pagination cursor with order, so only
      // the first page carries order=asc; follow-ups send cursor alone.
      const result = await api.message.list({
        sessionID: sessionId,
        limit: 200,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      });
      const pageMessages = Array.isArray(result.data) ? result.data : [];
      // OpenCode always returns a `next` cursor; an empty page is the end.
      if (pageMessages.length === 0) break;
      for (const msg of pageMessages) {
        const record = inputRecord(msg);
        const id = stringValue(record.id);
        if (id) messages.push({ id, type: stringValue(record.type) });
      }
      const next = stringValue(result?.cursor?.next);
      if (!next || next === cursor) break;
      if (page === maxPages - 1) {
        throw new Error(
          "OpenCode session history exceeded the pagination limit",
        );
      }
      cursor = next;
    }
    return messages;
  }

  async forkBoundaryRetainingThrough(sessionId: string, checkpointId?: string) {
    if (!checkpointId) return {};
    const messages = await this.listSessionMessageIds(sessionId);
    if (!messages.some((entry) => entry.id === checkpointId)) {
      throw new Error(`OpenCode checkpoint not found: ${checkpointId}`);
    }
    return forkBoundaryRetainingThrough(messages, checkpointId);
  }

  async rewindSessionRetainingThrough(sessionId: string, checkpointId: string) {
    let messages: CheckpointMessage[];
    try {
      messages = await this.listSessionMessageIds(sessionId);
    } catch (error) {
      throw new Error(
        `Could not list OpenCode messages for rewind: ${errorMessage(error)}`,
      );
    }
    const api = await this.api();
    const target = revertTargetRetainingThrough(messages, checkpointId);
    if (target === undefined) {
      await api.session.revert.clear({ sessionID: sessionId }).catch(() => {});
      return;
    }
    await api.session.interrupt({ sessionID: sessionId }).catch(() => {});
    // The previous turn may still be draining after interrupt; retry staged
    // reverts that hit a busy session instead of failing edit/rewind outright.
    await retryWhileBusy(() =>
      api.session.revert.stage({
        sessionID: sessionId,
        messageID: target,
        files: true,
      }),
    );
    await retryWhileBusy(() =>
      api.session.revert.commit({ sessionID: sessionId }),
    );
  }

  private async consumeEvents(signal: AbortSignal) {
    let connectedBefore = false;
    while (this.client && !signal.aborted) {
      try {
        const api = await this.api();
        // The stream does not replay: anything that happened while it was
        // down is gone, including the end of a turn and child usage.
        if (connectedBefore) {
          void this.reconcileActiveTurns();
          void this.reconcileChildSessionsForSessions();
        }
        connectedBefore = true;
        for await (const event of api.event.subscribe({ signal })) {
          try {
            await this.handleEvent(inputRecord(event));
          } catch {
            // Ignore malformed or unsupported provider events.
          }
        }
      } catch {
        if (this.client && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  private async reconcileChildSessionsForSessions(): Promise<void> {
    await Promise.allSettled(
      [...sessions.values()].flatMap((session) => [
        this.reconcileChildSessions(session),
        this.reconcileBackgroundTasks(session),
      ]),
    );
  }

  private reconciling = false;

  /**
   * Finish BB turns whose OpenCode execution already ended without BB seeing
   * the terminal event (a dropped event stream, or a service restart). Runs
   * after every stream reconnect and periodically as a watchdog. A turn is
   * only settled once OpenCode reports the session idle since the turn began
   * and that idle state has had time for its trailing events to arrive.
   */
  async reconcileActiveTurns(now = Date.now()): Promise<void> {
    if (this.reconciling) return;
    const candidates = [...sessions.values()].filter(
      (session) =>
        session.active?.promptDelivered === true &&
        !session.active.manualCompaction &&
        now - session.active.startedAt > RECONCILE_MIN_TURN_AGE_MS,
    );
    if (candidates.length === 0) return;
    this.reconciling = true;
    try {
      const api = await this.api();
      const running = inputRecord(await api.session.active());
      for (const session of candidates) {
        const active = session.active;
        if (!active || session.providerThreadId in running) continue;
        const info = inputRecord(
          await api.session
            .get({ sessionID: session.providerThreadId })
            .catch((): OpenCodeRecord => ({})),
        );
        const idle = inputRecord(info.time).idle;
        if (
          session.active !== active ||
          typeof idle !== "number" ||
          idle < active.startedAt ||
          Date.now() - idle < RECONCILE_SETTLE_MS
        )
          continue;
        if (info.outcome === "failed")
          await this.finish(
            session,
            "failed",
            "OpenCode reported this turn failed while BB was disconnected from its event stream",
          );
        else
          await this.finish(
            session,
            info.outcome === "interrupted" ? "interrupted" : "completed",
          );
      }
    } catch {
      // The service is unreachable; the next reconnect or tick retries.
    } finally {
      this.reconciling = false;
    }
  }

  async handleEvent(event: RecordValue): Promise<void> {
    const eventType = stringValue(event.type) ?? "";
    if (
      eventType === "session.archived" ||
      eventType === "session.unarchived"
    ) {
      const sessionId = stringValue(inputRecord(event.data).sessionID);
      if (
        sessionId &&
        this.consumeExpectedArchive(sessionId, eventType === "session.archived")
      )
        return;
    }
    if (
      eventType === "provider.updated" ||
      eventType === "model.updated" ||
      eventType === "credential.updated"
    )
      this.invalidateModelCatalogs();
    if (eventType === "command.updated") this.invalidateCommands();
    if (eventType === "installation.update-available")
      resetLatestVersionCache();
    if (eventType === "mcp.status.changed") {
      const server = stringValue(inputRecord(event.data).server) ?? "";
      const waiters = this.mcpWaiters.get(server);
      if (waiters)
        await Promise.all([...waiters].map((waiter) => waiter.check()));
    }
    await this.eventRouter.handleEvent(event);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ): Promise<void> {
    return this.eventRouter.finish(session, status, error);
  }

  async stop() {
    // The background service is shared with the OpenCode app/CLI; never stop
    // it here. Just drop our reference so the event loop exits.
    this.connectionGeneration += 1;
    this.clearChildSessions();
    this.client = undefined;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.eventAbortController?.abort();
    this.eventAbortController = undefined;
  }
}

export const openCodeServer = new OpenCodeServer();
