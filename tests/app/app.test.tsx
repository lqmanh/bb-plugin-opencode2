// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  opencodeSettingsRpcContract,
  type HostStatus,
  type OpenCodeStatus,
  type UsageSourceStatus,
} from "../../src/shared/settings-contract.ts";

const mountedSlots: Array<{ lifecycle: { unmount(): void } }> = [];

const baseStatus = {
  statusMessage: null,
  installedVersion: "2.2.7",
  latestVersion: "2.2.7",
  minimumSupportedVersion: "2.2.7",
  loginCommand: "opencode2 auth login",
};

function makeHost(
  hostName: string,
  status: Partial<OpenCodeStatus> = {},
  usage: Partial<UsageSourceStatus> = {},
): HostStatus {
  return {
    hostId: hostName,
    hostName,
    status: { ...baseStatus, status: "ready", ...status },
    usage: { status: "active", providerCount: 0, ...usage },
  };
}

async function mountSettings(
  getStatus: () => Promise<{ hosts: HostStatus[] }>,
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const registration = app.settingsSections[0];
  expect(registration?.id).toBe("settings");
  const slot = renderSlot<{}, typeof opencodeSettingsRpcContract>(
    registration!,
    {},
    { rpc: { getStatus } },
  );
  mountedSlots.push(slot);
  return slot;
}

afterEach(() => {
  for (const slot of mountedSlots.splice(0)) slot.lifecycle.unmount();
});

describe("OpenCode settings", () => {
  it("shows host status and usage source without a model list", async () => {
    const getStatus = vi.fn(async () => ({
      hosts: [
        makeHost(
          "laptop",
          { latestVersion: "2.2.8" },
          {
            sourceType: "local",
            source: "/tmp/opencode-usage",
            providerCount: 2,
          },
        ),
      ],
    }));
    const slot = await mountSettings(getStatus);

    expect(
      await slot.findByText(/OpenCode 2\.2\.7 · 2\.2\.8 available/),
    ).toBeTruthy();
    expect(slot.getAllByText("Ready")).toHaveLength(2);
    expect(
      slot.getByText(/\/tmp\/opencode-usage · local · 2 providers/),
    ).toBeTruthy();
    expect(slot.queryByText("Active")).toBeNull();
    expect(slot.queryByText("Models")).toBeNull();
    expect(slot.queryByRole("switch")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("uses one status vocabulary and labels unknown usage sources", async () => {
    const getStatus = vi.fn(async () => ({
      hosts: [
        makeHost("ready-host", {}, { providerCount: 2 }),
        makeHost(
          "update-host",
          { status: "unsupported_version", installedVersion: "2.1.0" },
          { status: "no_accounts" },
        ),
        makeHost(
          "install-host",
          {
            status: "not_installed",
            installedVersion: null,
            latestVersion: null,
          },
          { status: "not_installed" },
        ),
        makeHost(
          "down-host",
          { status: "unknown" },
          { status: "unavailable", error: "usage backend down" },
        ),
      ],
    }));
    const slot = await mountSettings(getStatus);

    const hostRow = async (name: string) =>
      within((await slot.findByText(name)).parentElement as HTMLElement);

    const ready = await hostRow("ready-host");
    expect(ready.getAllByText("Ready")).toHaveLength(2);
    expect(ready.getByText(/Unknown · 2 providers/)).toBeTruthy();
    expect(ready.queryByRole("link")).toBeNull();

    const update = await hostRow("update-host");
    expect(update.getByText("Update needed")).toBeTruthy();
    expect(update.getByText("Setup needed")).toBeTruthy();

    const install = await hostRow("install-host");
    expect(install.getByText("Setup needed")).toBeTruthy();
    expect(install.getByText("Not installed")).toBeTruthy();
    expect(
      install
        .getByRole("link", { name: "opencode-usage" })
        .getAttribute("href"),
    ).toBe("https://github.com/lqmanh/opencode-usage");

    const down = await hostRow("down-host");
    expect(down.getAllByText("Unavailable")).toHaveLength(2);
    expect(down.getByText("usage backend down")).toBeTruthy();
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
