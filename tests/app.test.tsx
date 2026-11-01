// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { opencodeSettingsRpcContract } from "../src/settings-contract.ts";

const mountedSlots: Array<{ lifecycle: { unmount(): void } }> = [];

afterEach(() => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
});

describe("OpenCode settings", () => {
  it("loads models and persists model selection changes", async () => {
    const app = await loadPluginApp(() => import("../src/app.tsx"));
    const registration = app.settingsSections[0];
    expect(registration?.id).toBe("models");

    const saveModelSelection = vi.fn(async (settings) => settings);
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      registration!,
      {},
      {
        rpc: {
          getModelSelection: async () => ({ enabledModels: null }),
          listModels: async () => ({
            models: [
              {
                id: "openai/gpt-5",
                providerId: "openai",
                displayName: "GPT-5",
              },
            ],
          }),
          saveModelSelection,
          getStatus: async () => ({
            hosts: [
              {
                hostId: "host_1",
                hostName: "laptop",
                status: {
                  status: "ready" as const,
                  statusMessage: null,
                  installedVersion: "2.2.5",
                  latestVersion: "2.2.6",
                  minimumSupportedVersion: "2.2.5",
                  loginCommand: "opencode2 auth login",
                  modelCount: 1,
                },
              },
            ],
          }),
        },
      },
    );
    mountedSlots.push(slot);

    expect(await slot.findByText(/Ready · OpenCode 2\.2\.5/)).toBeTruthy();
    expect(slot.getByText(/OpenCode 2\.2\.6 is available/)).toBeTruthy();

    // Provider groups start collapsed; expanding shows the models.
    const group = await slot.findByRole("button", { name: /openai/ });
    expect(slot.queryByText("GPT-5")).toBeNull();
    fireEvent.click(group);
    expect(await slot.findByText("GPT-5")).toBeTruthy();

    const modelSwitch = await slot.findByRole("switch", {
      name: "Enable GPT-5 from openai",
    });
    fireEvent.click(modelSwitch);
    await waitFor(() => {
      expect(saveModelSelection).toHaveBeenCalledWith({ enabledModels: [] });
    });

    fireEvent.click(modelSwitch);
    await waitFor(() => {
      expect(saveModelSelection).toHaveBeenCalledWith({ enabledModels: null });
    });
  });
});
