---
name: opencode2-provider
description:
  "Configure or troubleshoot BB-specific OpenCode v2 settings, agents, and stale
  sessions."
---

# OpenCode v2 provider

Settings:

- `subagentsDisabled` (default `false`): when `true`, OpenCode's native
  `subagent` tool is denied and hidden.
- `nativeSkills` (default `false`): adds the pinned `opencode-bb-skills` plugin
  to OpenCode's config so the workspace's BB skills appear in OpenCode's native
  registry; disabling removes the entry and the catalogs. OpenCode installs the
  plugin from GitHub on first use. Other clients opening the same workspace see
  the skills. The host and OpenCode must be co-located.

Read with `bb plugin config opencode2`; change with
`bb plugin config opencode2 set <key> <value>`.

Use BB's provider controls to enable or disable the provider.

The plugin keeps one `bb_opencode2_*` deny rule in the global OpenCode config so
BB tools stay out of OpenCode's own sessions. `nativeSkills` also writes one
`plugins` entry owned by this plugin. OpenCode applies both when idle.

Primary agents, including `plan`, are the `agent` session option on each model.
Set it with `bb thread spawn --option agent=<name>` or
`bb thread options --set agent=<name>`. `/plan` runs one turn on the `plan`
agent, then returns to the selected agent. Agent changes in OpenCode update BB's
Agent option; titles fill only untitled threads. BB instructions are appended
rather than replacing OpenCode's.

OpenCode's slash commands appear in BB's `/` menu. Commands run through
OpenCode's own registry, so project and MCP commands work too. BB archive and
unarchive are mirrored to the session; external archive, deletion, or moves
explain the problem on the next turn.

Session settings apply from the next turn; `nativeSkills` applies immediately.
Provider usage comes from
[opencode-usage](https://github.com/lqmanh/opencode-usage) when installed; the
settings page shows per-host source status. Stuck turns reconcile every 30
seconds and after reconnects. Stale `bb_opencode2_*` MCP servers are removed by
discarding the thread. Logs are in `~/.bb/plugins/opencode2/logs/plugin.log`.
