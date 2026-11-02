import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  opencodeSettingsRpcContract,
  type HostStatus,
  type OpenCodeStatus,
  type UsageSourceStatus,
} from "../settings-contract.ts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const [hosts, setHosts] = useState<HostStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await rpcRef.current.call("getStatus", {});
      setHosts(result.hosts);
    } catch (cause) {
      setHosts([]);
      setError(errorText(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="opencode-settings">
      <Button
        className="self-start"
        variant="outline"
        size="sm"
        disabled={isLoading}
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
          ) : hosts.length === 0 && !error ? (
            <div className="text-sm text-muted-foreground">
              No connected hosts. Connect a host to check OpenCode.
            </div>
          ) : (
            hosts.map((host) => <HostStatusRow key={host.hostId} host={host} />)
          )}
          {error ? (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
