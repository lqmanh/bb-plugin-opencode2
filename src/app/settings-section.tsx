import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  modelSelectionSchema,
  opencodeSettingsRpcContract,
  type HostStatus,
  type ModelSelection,
  type ModelSummary,
  type OpenCodeStatus,
  type UsageSourceStatus,
} from "../settings-contract.ts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

function groupByProvider(models: ModelSummary[]) {
  const map = new Map<string, ModelSummary[]>();
  for (const model of models) {
    const list = map.get(model.providerId) ?? [];
    list.push(model);
    map.set(model.providerId, list);
  }
  return [...map.entries()]
    .map(([providerId, items]) => ({
      providerId,
      items: items.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function statusText(status: OpenCodeStatus) {
  if (status.status === "not_installed")
    return "Install OpenCode v2 from the provider settings, or run `npm install -g @opencode/cli`.";
  if (status.status === "unauthenticated")
    return `Run \`${status.loginCommand}\` on this machine to connect a model provider.`;
  if (status.statusMessage) return status.statusMessage;
  const version = status.installedVersion
    ? `OpenCode ${status.installedVersion}`
    : "OpenCode";
  if (
    status.latestVersion &&
    status.installedVersion &&
    status.latestVersion !== status.installedVersion
  )
    return `${version} · ${status.latestVersion} available`;
  return version;
}

type StatusTone = "ok" | "warn" | "error" | "neutral";

type StatusDisplay = { label: string; tone: StatusTone };

const OPENCODE_STATUS_DISPLAY: Record<OpenCodeStatus["status"], StatusDisplay> =
  {
    ready: { label: "Ready", tone: "ok" },
    not_installed: { label: "Not installed", tone: "warn" },
    unsupported_version: { label: "Update required", tone: "warn" },
    unauthenticated: { label: "No model provider connected", tone: "warn" },
    unknown: { label: "Service unreachable", tone: "error" },
  };

const USAGE_SOURCE_DISPLAY: Record<UsageSourceStatus["status"], StatusDisplay> =
  {
    active: { label: "Active", tone: "ok" },
    no_accounts: { label: "No accounts", tone: "warn" },
    unavailable: { label: "Unavailable", tone: "error" },
    not_installed: { label: "Not installed", tone: "neutral" },
  };

const TONE_DOT_CLASSES: Record<StatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  neutral: "bg-muted-foreground",
};

function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", TONE_DOT_CLASSES[tone])}
      />
      <span className={cn(tone === "neutral" && "text-muted-foreground")}>
        {label}
      </span>
    </span>
  );
}

function StatusRow({
  detail,
  tone,
  label,
}: {
  detail: ReactNode;
  tone: StatusTone;
  label: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 text-sm text-muted-foreground">{detail}</div>
      <StatusBadge tone={tone} label={label} />
    </div>
  );
}

function usageSourceLabel(usage: UsageSourceStatus) {
  if (usage.status === "not_installed") {
    return (
      <a
        className="text-primary hover:underline"
        href="https://github.com/lqmanh/opencode-usage"
        target="_blank"
        rel="noreferrer"
      >
        opencode-usage
      </a>
    );
  }
  const source =
    usage.sourceType && usage.sourceType !== "package"
      ? `opencode-usage · ${usage.sourceType}`
      : `${usage.source ?? "opencode-usage"}${usage.version ? ` ${usage.version}` : ""}`;
  const count =
    usage.providerCount > 0
      ? ` · ${usage.providerCount} ${usage.providerCount === 1 ? "provider" : "providers"}`
      : "";
  return (
    <span title={usage.sourceType === "local" ? usage.source : undefined}>
      {source}
      {count}
    </span>
  );
}

function HostStatusRow({ host }: { host: HostStatus }) {
  const status = host.status;
  const statusDisplay = status
    ? OPENCODE_STATUS_DISPLAY[status.status]
    : { label: "Status unavailable", tone: "error" as const };
  const usageDisplay = USAGE_SOURCE_DISPLAY[host.usage.status];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium">{host.hostName}</div>
      <StatusRow
        detail={status ? statusText(status) : host.error}
        tone={statusDisplay.tone}
        label={statusDisplay.label}
      />
      <StatusRow
        detail={<>Usage source: {usageSourceLabel(host.usage)}</>}
        tone={usageDisplay.tone}
        label={usageDisplay.label}
      />
      {host.usage.error ? (
        <div className="text-xs text-muted-foreground">{host.usage.error}</div>
      ) : null}
    </div>
  );
}

export function SettingsSection() {
  const rpc = useRpc<typeof opencodeSettingsRpcContract>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [hosts, setHosts] = useState<HostStatus[] | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const operationId = useRef(0);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useRealtime("settings-changed", (payload) => {
    const parsed = modelSelectionSchema.safeParse(payload);
    if (parsed.success) setSelection(parsed.data);
  });

  const load = useCallback(async () => {
    const id = ++operationId.current;
    setIsLoading(true);
    setError(null);
    // The status probe can be slow; it never blocks the model list.
    void rpcRef.current
      .call("getStatus", {})
      .then((result) => {
        if (id === operationId.current) setHosts(result.hosts);
      })
      .catch(() => {
        if (id === operationId.current) setHosts([]);
      });
    try {
      const [nextSelection, nextModels] = await Promise.all([
        rpcRef.current.call("getModelSelection", null),
        rpcRef.current.call("listModels", {}),
      ]);
      if (id !== operationId.current) return;
      setSelection(nextSelection);
      setModels(nextModels.models);
    } catch (cause) {
      if (id === operationId.current) setError(errorText(cause));
    } finally {
      if (id === operationId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      operationId.current += 1;
    };
  }, [load]);

  async function save(next: ModelSelection) {
    if (!selection || isSaving) return;
    const previous = selection;
    const id = ++operationId.current;
    setSelection(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await rpcRef.current.call("saveModelSelection", next);
      if (id === operationId.current) setSelection(saved);
    } catch (cause) {
      if (id === operationId.current) {
        setSelection(previous);
        setError(errorText(cause));
      }
    } finally {
      if (id === operationId.current) setIsSaving(false);
    }
  }

  const isEnabled = (model: ModelSummary): boolean =>
    selection !== null &&
    (selection.enabledModels === null ||
      selection.enabledModels.includes(model.id));

  const providers = useMemo(() => groupByProvider(models), [models]);
  const searching = query.trim().length > 0;

  const visibleProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers
      .map((group) => ({
        ...group,
        items: group.items.filter((model) =>
          `${model.displayName} ${model.providerId} ${model.id}`
            .toLowerCase()
            .includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [providers, query]);

  const enabledCount = models.filter(isEnabled).length;

  function enabledSet() {
    return selection?.enabledModels === null || !selection
      ? new Set(models.map((item) => item.id))
      : new Set(selection.enabledModels);
  }

  function setModelsEnabled(ids: string[], nextEnabled: boolean) {
    if (!selection) return;
    const current = enabledSet();
    for (const id of ids) {
      if (nextEnabled) current.add(id);
      else current.delete(id);
    }
    // Every model on: store null so newly connected models appear too.
    const allOn = models.every((model) => current.has(model.id));
    void save({
      ...selection,
      enabledModels: allOn ? null : [...current].sort(),
    });
  }

  function toggleExpanded(providerId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }

  const busy = selection === null || isSaving;

  return (
    <div className="opencode-settings">
      <Button
        className="self-start"
        variant="outline"
        size="sm"
        disabled={isLoading || isSaving}
        onClick={() => void load()}
      >
        Refresh
      </Button>

      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-col gap-3">
          {hosts === null ? (
            <div className="text-sm text-muted-foreground" role="status">
              Checking OpenCode…
            </div>
          ) : hosts.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No connected hosts. Connect a host to check OpenCode.
            </div>
          ) : (
            hosts.map((host) => <HostStatusRow key={host.hostId} host={host} />)
          )}
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Models</div>
          <div className="text-sm text-muted-foreground">
            {models.length > 0
              ? `${enabledCount} of ${models.length} models enabled.`
              : "Only enabled models appear in the OpenCode v2 picker."}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => void save({ ...selection!, enabledModels: null })}
          >
            Enable all
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => void save({ ...selection!, enabledModels: [] })}
          >
            Disable all
          </Button>
        </div>
      </div>

      <Input
        aria-label="Search OpenCode models"
        placeholder="Search models"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground" role="status">
          Loading models…
        </div>
      ) : null}
      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {!isLoading && models.length === 0 && !error ? (
        <div className="text-sm text-muted-foreground">
          No OpenCode models were found on a connected host.
        </div>
      ) : null}
      {!isLoading && models.length > 0 && visibleProviders.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No models match your search.
        </div>
      ) : null}

      {!isLoading && !error && visibleProviders.length > 0 ? (
        <div className="rounded-lg border border-border">
          {visibleProviders.map((group) => {
            const groupEnabled = group.items.filter(isEnabled).length;
            const allOn = groupEnabled === group.items.length;
            const open = searching || expanded.has(group.providerId);
            return (
              <div
                key={group.providerId}
                className="border-b border-border last:border-b-0"
              >
                <div className="flex items-center justify-between gap-4 p-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                    aria-expanded={open}
                    onClick={() => toggleExpanded(group.providerId)}
                  >
                    <span aria-hidden className="text-muted-foreground">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="truncate">{group.providerId}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {groupEnabled}/{group.items.length}
                    </span>
                  </button>
                  <Switch
                    aria-label={`Enable all ${group.providerId} models`}
                    checked={allOn}
                    disabled={busy}
                    onCheckedChange={(next) =>
                      setModelsEnabled(
                        group.items.map((model) => model.id),
                        next,
                      )
                    }
                  />
                </div>
                {open
                  ? group.items.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between gap-4 border-t border-border py-2 pr-3 pl-8"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">
                            {model.displayName}
                            {model.isDefault ? (
                              <span className="ml-2 text-xs text-muted-foreground">
                                OpenCode default
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {model.id}
                          </div>
                        </div>
                        <Switch
                          aria-label={`Enable ${model.displayName} from ${model.providerId}`}
                          checked={isEnabled(model)}
                          disabled={busy}
                          onCheckedChange={(next) =>
                            setModelsEnabled([model.id], next)
                          }
                        />
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="text-xs text-muted-foreground">
        {isSaving
          ? "Saving…"
          : "Settings apply from the next turn. The model picker updates when BB refreshes its model list."}
      </div>
    </div>
  );
}
