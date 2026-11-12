import type { PluginInfo } from "@opencode/client";
import { errorMessage } from "../../shared/errors.ts";
import type { OpenCodeApi } from "../types.ts";
import { coldList } from "./cold-list.ts";

const PLUGIN_LOOKUP_ATTEMPTS = 5;

export type PluginMetadata = { source?: string; version?: string };

export type PluginLookup =
  | { status: "found"; metadata: PluginMetadata }
  | { status: "failed"; metadata: PluginMetadata; error: string }
  | { status: "missing" }
  | { status: "error"; error: string };

function pluginMetadata(plugin: PluginInfo): PluginMetadata {
  switch (plugin.source.type) {
    case "package":
      return {
        source: plugin.source.target,
        ...(plugin.source.version ? { version: plugin.source.version } : {}),
      };
    case "local":
      return { source: plugin.source.path };
    default:
      return {};
  }
}

function pluginSpec(plugin: PluginInfo): string | undefined {
  switch (plugin.source.type) {
    case "package":
      return plugin.source.target;
    case "local":
      return plugin.source.path;
    default:
      return undefined;
  }
}

/** Whether a local path spec names a directory called `name`. */
export function isPluginDirSpec(spec: string, name: string): boolean {
  const path = spec.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  return path === name || path.endsWith(`/${name}`);
}

/**
 * Look up one plugin in `plugin.list`. Loaded plugins match by `id`; failures
 * from before the module loaded have no `id` and match by package target or
 * local path. An active entry wins over a failed one. A cold location can omit
 * a plugin that is still loading, so a missing result is retried briefly.
 */
export async function lookupPlugin(
  api: OpenCodeApi,
  cwd: string,
  id: string,
  matchesSpec: (spec: string) => boolean,
): Promise<PluginLookup> {
  let matches: PluginInfo[];
  try {
    const client = await api();
    matches = await coldList(async () => {
      const { data } = await client.plugin.list({
        location: { directory: cwd },
      });
      return data.filter((plugin) => {
        if (plugin.id) return plugin.id === id;
        const spec = pluginSpec(plugin);
        return spec !== undefined && matchesSpec(spec);
      });
    }, PLUGIN_LOOKUP_ATTEMPTS);
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
  const selected =
    matches.find((plugin) => plugin.state.status === "active") ?? matches[0];
  if (!selected) return { status: "missing" };
  const metadata = pluginMetadata(selected);
  return selected.state.status === "failed"
    ? { status: "failed", metadata, error: selected.state.error }
    : { status: "found", metadata };
}
