import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSelection,
  normalizeModelSettings,
  resolveModelSettings,
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

test("resolves provider settings into the host model settings shape", () => {
  assert.deepEqual(resolveModelSettings({ allowSubagents: true }, []), {
    enabledModels: [],
    disableSubagents: false,
  });
  assert.deepEqual(resolveModelSettings({}, null), DEFAULT_MODEL_SETTINGS);
});

test("normalizes stored model selection", () => {
  assert.deepEqual(normalizeModelSelection(undefined), {
    enabledModels: null,
  });
  assert.deepEqual(
    normalizeModelSelection({
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
    }),
    { enabledModels: ["openai/gpt-5"] },
  );
});
