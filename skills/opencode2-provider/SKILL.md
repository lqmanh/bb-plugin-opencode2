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
mode is not offered, and BB instructions are appended rather than replacing
OpenCode's.

Settings apply from the next turn. If a turn appears stuck, the bridge
reconciles with OpenCode every 30 seconds and after event-stream reconnects.
Stale `bb_opencode2_*` MCP servers are removed by discarding the thread; logs
are in `~/.bb/plugins/opencode2/logs/plugin.log`.
