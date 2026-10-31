import { experimental_compareVersions as compareVersions } from "@get-bb/plugin-sdk/provider-bridge";

/** The oldest OpenCode service this bridge supports. */
export const MIN_OPENCODE_VERSION = "2.2.5";

export function isSupportedVersion(version: string) {
  return compareVersions(version, MIN_OPENCODE_VERSION) >= 0;
}
