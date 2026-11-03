import "./app.css";
import { experimental_THREAD_ACTION_GROUPS } from "@get-bb/plugin-sdk";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginThreadActionDataInput,
  PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import {
  OPENCODE_PROVIDER_ID,
  opencodeThreadRpcContract,
} from "../shared/settings-contract.ts";
import { SettingsSection } from "./settings-section.tsx";

type BackgroundActionData = {
  opencodeThreads: ReadonlySet<string>;
  backgroundThread(threadId: string): Promise<void>;
};

function useBackgroundActionData({
  threadIds,
}: PluginThreadActionDataInput): BackgroundActionData {
  const rpc = useRpc<typeof opencodeThreadRpcContract>();
  const threads = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const visible = new Set(threadIds);
  const opencodeThreads = new Set(
    threads.threads
      .filter(
        (thread) =>
          visible.has(thread.id) && thread.providerId === OPENCODE_PROVIDER_ID,
      )
      .map((thread) => thread.id),
  );
  return {
    opencodeThreads,
    async backgroundThread(threadId) {
      await rpc.call("backgroundThread", { threadId });
    },
  };
}

function backgroundAction(
  input: PluginThreadActionItemInput<BackgroundActionData>,
) {
  const { thread, data } = input;
  if (
    !data ||
    thread.parentThreadId !== null ||
    thread.archivedAt !== null ||
    thread.status !== "active" ||
    !data.opencodeThreads.has(thread.id)
  )
    return null;
  return {
    label: "Background active tools",
    detail: "All running tools in this thread",
    icon: "Terminal" as const,
    run: () => data.backgroundThread(thread.id),
  };
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "OpenCode v2",
    description: "Check OpenCode and its usage source on each connected host.",
    component: SettingsSection,
  });
  app.slots.experimental_threadAction({
    id: "background-active-tools",
    title: "Background active tools",
    icon: "Terminal",
    group: experimental_THREAD_ACTION_GROUPS.state,
    placement: "menu",
    useData: useBackgroundActionData,
    item: backgroundAction,
  });
});
