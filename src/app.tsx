import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsSection } from "./app/settings-section.tsx";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "OpenCode v2",
    description:
      "Check OpenCode on each host and choose which models BB can use.",
    component: SettingsSection,
  });
});
