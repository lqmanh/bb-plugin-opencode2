import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  legacyProviderSettings,
  normalizeModelSelection,
  normalizeModelSettings,
  resolveModelSettings,
} from "../src/model-settings.ts";

test("normalizes legacy and malformed model settings", () => {
  assert.deepEqual(normalizeModelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(
    normalizeModelSettings({
      providerEnabled: false,
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
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

test("normalizes and migrates stored model settings", () => {
  assert.deepEqual(normalizeModelSelection(undefined), {
    enabledModels: null,
  });
  assert.deepEqual(
    normalizeModelSelection({
      providerEnabled: false,
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
    }),
    { enabledModels: ["openai/gpt-5"] },
  );
  assert.deepEqual(
    legacyProviderSettings({
      providerEnabled: false,
      disableSubagents: false,
      hideBbToolsOutsideBb: false,
    }),
    { allowSubagents: true },
  );
  assert.equal(legacyProviderSettings({ enabledModels: null }), undefined);
  assert.equal(legacyProviderSettings({ providerEnabled: false }), undefined);
});
