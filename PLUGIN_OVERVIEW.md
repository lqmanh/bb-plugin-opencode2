## What you get

OpenCode v2 appears in BB's provider picker. Start a thread, pick a model
OpenCode has connected, and work in BB's usual interface.

- **BB thread controls.** Fork at a checkpoint, rewind and edit with files
  restored, steer a running turn, stop, rename, and `/compact`.
- **Commands and plan mode.** OpenCode's slash commands appear in BB's `/` menu.
  `/plan` runs a turn on OpenCode's read-only `plan` agent, then returns to the
  selected agent.
- **Permissions and questions.** Accept edits, auto, and full map to OpenCode
  permission rules. OpenCode's questions, and forms that fit BB's question
  schema, use BB's native question UI; unsupported forms are cancelled with a
  visible reason.
- **Agents, tools, and cost.** Pick an OpenCode primary agent in BB's Agent row;
  agent changes made in OpenCode flow back. BB tools and OpenCode skills work
  inside the thread, and shells get the `bb` CLI on `PATH`. OpenCode's reported
  session cost appears in BB's context card.
- **Provider usage.** When the
  [opencode-usage](https://github.com/lqmanh/opencode-usage) OpenCode plugin is
  installed, BB shows provider quota windows in its usage surfaces and reports
  the source status on the plugin settings page.

## Requirements

- OpenCode v2 2.2.5 or newer, with `opencode2` on the host's `PATH`. BB can
  install and update it from the provider settings.
- At least one model provider connected in OpenCode (`opencode2 auth login`).
  OpenCode owns the credentials; model usage is billed by that provider, not BB.

## Good to know

- Native OpenCode subagents are enabled by default. Turn on **Disable provider
  subagents** to delegate through BB instead.
- The plugin keeps one deny rule in your global OpenCode config so BB threads'
  tools do not appear in OpenCode's own sessions. The rule stays after the
  plugin is disabled; it only matches this plugin's server names.
- BB archive and unarchive are mirrored to the OpenCode session. If OpenCode
  archives, deletes, or moves the session externally, the next turn explains the
  problem instead of silently resuming it.
- Thread goals and service tiers are not supported. Provider usage and
  rate-limit windows come from that plugin when it is installed; OpenCode itself
  reports session cost but not quota windows.
