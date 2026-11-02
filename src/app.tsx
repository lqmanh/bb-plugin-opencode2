import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsSection } from "./app/settings-section.tsx";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "OpenCode v2",
    description: "Check OpenCode and its usage source on each connected host.",
    component: SettingsSection,
  });
});
