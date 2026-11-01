import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
} from "../src/model-settings.ts";

test("normalizes malformed model settings", () => {
  assert.deepEqual(normalizeModelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(
    normalizeModelSettings({
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
    }),
    {
      enabledModels: ["openai/gpt-5"],
      disableSubagents: true,
    },
  );
  assert.deepEqual(
    normalizeModelSettings({
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
      disableSubagents: "nope",
    }),
    {
      enabledModels: ["openai/gpt-5"],
      disableSubagents: true,
    },
  );
});
