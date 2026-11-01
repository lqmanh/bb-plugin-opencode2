---
name: opencode2-provider
description:
  "Configure or troubleshoot BB-specific OpenCode v2 settings, model allowlist,
  agents, and stale sessions."
---

# OpenCode v2 provider

Provider behavior is in the generated plugin settings:

- `allowSubagents` (default `false`): when `false`, OpenCode's native `subagent`
  tool is denied and hidden. Enable it to render OpenCode subagents as BB
  delegation rows.

Read with `bb plugin config opencode2`; change with
`bb plugin config opencode2 set <key> <value>`.

Use BB's provider controls to enable or disable the provider. The plugin always
keeps one `bb_opencode2_*` deny rule at the end of `permissions` in the host's
global OpenCode config, so OpenCode's own sessions do not list BB threads'
tools. OpenCode applies it at its next idle location reload.

The model allowlist is on the plugin settings page. Read it with
`bb plugin rpc call opencode2 getModelSelection --json`; write it with
`saveModelSelection`: `enabledModels` is `null` for every model or an exact list
of `provider/model` IDs (`[]` hides all).

Primary agents, including `plan`, are the `agent` session option on each model.
Set it with `bb thread spawn --option agent=<name>` or
`bb thread options --set agent=<name>`; it applies on the next turn. BB's plan
mode (`/plan` or `--plan`) runs that turn on OpenCode's `plan` agent and then
returns to the selected agent. Agent changes made in OpenCode update BB's Agent
option. Titles set in OpenCode fill an untitled BB thread. BB instructions are
appended rather than replacing OpenCode's.

OpenCode's slash commands are listed in the composer `/` menu. Commands run
through OpenCode's own command registry, so project and MCP commands work too.
BB archive and unarchive are mirrored to the OpenCode session; if OpenCode
archives, deletes, or moves the session externally, the next turn explains the
problem and asks you to start a new thread or unarchive it.

Settings apply from the next turn. If a turn appears stuck, the bridge
reconciles with OpenCode every 30 seconds and after event-stream reconnects.
Stale `bb_opencode2_*` MCP servers are removed by discarding the thread; logs
are in `~/.bb/plugins/opencode2/logs/plugin.log`.
