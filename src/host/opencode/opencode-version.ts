import { experimental_compareVersions as compareVersions } from "@get-bb/plugin-sdk/provider-bridge";

export const MIN_OPENCODE_VERSION = "2.3.1";

export function isSupportedVersion(version: string) {
  return compareVersions(version, MIN_OPENCODE_VERSION) >= 0;
}

export type LatestVersionCache = { at: number; value: string | null };

let latestVersionCache: LatestVersionCache | undefined;

export function readLatestVersionCache() {
  return latestVersionCache;
}

export function writeLatestVersionCache(value: string | null) {
  latestVersionCache = { at: Date.now(), value };
}

export function resetLatestVersionCache() {
  latestVersionCache = undefined;
}
