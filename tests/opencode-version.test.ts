import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_OPENCODE_VERSION,
  isSupportedVersion,
} from "../src/host/opencode-version.ts";

test("requires OpenCode 2.2.5 or newer", () => {
  assert.equal(MIN_OPENCODE_VERSION, "2.2.5");
  assert.equal(isSupportedVersion("2.2.5"), true);
  assert.equal(isSupportedVersion("2.3.0"), true);
  assert.equal(isSupportedVersion("2.2.4"), false);
});
