import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedVersion } from "../../../src/host/opencode/opencode-version.ts";

test("requires OpenCode 2.3.0 or newer", () => {
  assert.equal(isSupportedVersion("2.3.0"), true);
  assert.equal(isSupportedVersion("2.3.1"), true);
  assert.equal(isSupportedVersion("2.2.7"), false);
});
