import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
  resolveModelSettings,
} from "../src/model-settings.ts";

test("defaults native subagents to enabled", () => {
  assert.equal(resolveModelSettings({}, null).disableSubagents, false);
  assert.equal(
    resolveModelSettings({ subagentsDisabled: true }, null).disableSubagents,
    true,
  );
});

test("normalizes model settings", () => {
  assert.deepEqual(normalizeModelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(
    normalizeModelSettings({
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
      disableSubagents: true,
    }),
    {
      enabledModels: ["openai/gpt-5"],
      disableSubagents: true,
    },
  );
});
