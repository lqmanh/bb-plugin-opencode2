import { dirname, join } from "node:path";

/**
 * Runtime state shared by a plugin's host and provider-bridge workers.
 * Each worker gets its own data dir under the plugin root.
 */
export function pluginRuntimeDir(workerDataDir: string): string {
  return join(dirname(workerDataDir), "runtime");
}
