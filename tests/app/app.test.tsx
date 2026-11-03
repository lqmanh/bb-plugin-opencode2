// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { opencodeSettingsRpcContract } from "../../src/shared/settings-contract.ts";

const mountedSlots: Array<{ lifecycle: { unmount(): void } }> = [];

afterEach(() => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
});

describe("OpenCode settings", () => {
  it("shows host status and usage source without a model list", async () => {
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    const registration = app.settingsSections[0];
    expect(registration?.id).toBe("settings");

    const getStatus = vi.fn(async () => ({
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
          },
          usage: {
            status: "active" as const,
            sourceType: "local" as const,
            source: "/tmp/opencode-usage",
            providerCount: 2,
          },
        },
      ],
    }));
    const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
      registration!,
      {},
      { rpc: { getStatus } },
    );
    mountedSlots.push(slot);

    expect(
      await slot.findByText(/OpenCode 2\.2\.5 · 2\.2\.6 available/),
    ).toBeTruthy();
    expect(slot.getByText("Ready")).toBeTruthy();
    expect(slot.getByText(/opencode-usage · local · 2 providers/)).toBeTruthy();
    expect(slot.getByText("Active")).toBeTruthy();
    expect(slot.queryByText("Models")).toBeNull();
    expect(slot.queryByRole("switch")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("registers a menu action that backgrounds active OpenCode tools", async () => {
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    const registration = app.threadActions.find(
      (action) => action.id === "background-active-tools",
    );
    expect(registration).toBeTruthy();
    expect(registration?.placement).toBe("menu");
    expect(registration?.group).toBe("1_state");

    const backgroundThread = vi.fn(async () => {});
    const data = {
      opencodeThreads: new Set(["thr_1"]),
      backgroundThread,
    };
    const thread = {
      id: "thr_1",
      projectId: "proj_1",
      parentThreadId: null,
      parentNotifications: "auto" as const,
      archivedAt: null,
      pinnedAt: null,
      sectionId: null,
      isUnread: false,
      status: "active" as const,
      environment: null,
    };
    const actionFor = (target: unknown) =>
      registration?.item({
        thread: target,
        data,
        sdk: {},
        navigate: {},
        experimental_panel: {},
      } as never);
    const action = actionFor(thread);
    expect(action?.label).toBe("Background active tools");
    await action?.run({ requestRename: vi.fn() });
    expect(backgroundThread).toHaveBeenCalledWith("thr_1");

    expect(actionFor({ ...thread, id: "thr_2" })).toBeNull();
    expect(actionFor({ ...thread, parentThreadId: "thr_parent" })).toBeNull();
    expect(actionFor({ ...thread, status: "idle" })).toBeNull();
    expect(actionFor({ ...thread, archivedAt: 1 })).toBeNull();
  });
});
