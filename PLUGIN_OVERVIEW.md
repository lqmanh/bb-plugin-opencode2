## What you get

OpenCode v2 appears in BB's provider picker. Start a thread, pick a connected
model, and work in BB's usual interface.

- **Threads:** fork at a checkpoint, rewind/edit with files restored, steer,
  stop, rename, and `/compact`.
- **Commands and plan mode:** OpenCode's slash commands in BB's `/` menu;
  `/plan` runs on OpenCode's `plan` agent.
- **Permissions and questions:** accept-edits, auto, and full modes; OpenCode
  questions and supported forms use BB's native question UI.
- **Agents, tools, and cost:** pick an OpenCode primary agent; agent changes
  flow back to BB. BB tools, OpenCode skills, and `bb` in shells work in the
  thread. Session cost appears in BB's context card.
- **Provider usage:** when
  [opencode-usage](https://github.com/lqmanh/opencode-usage) is installed, BB
  shows quota windows and reports the source status.

## Requirements

- OpenCode v2 2.2.5 or newer, with `opencode2` on the host's `PATH`
- At least one model provider connected in OpenCode (`opencode2 auth login`)

## Good to know

- Native OpenCode subagents are enabled by default. Turn on **Disable provider
  subagents** to delegate through BB instead.
- **Register BB skills natively in OpenCode** is off by default. When enabled,
  BB installs the pinned `opencode-bb-skills` plugin from GitHub so BB's skills
  appear in OpenCode's native registry. Other clients opening the same workspace
  see them too; the host and OpenCode must be co-located.
- The plugin keeps one deny rule in the global OpenCode config so BB thread
  tools do not appear in OpenCode's own sessions.
- Thread goals and service tiers are not supported.
