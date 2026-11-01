# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- OpenCode slash commands in BB's `/` menu, run through OpenCode's own command
  registry.
- BB plan mode (`/plan` and `--plan`) is available again, running that turn on
  OpenCode's read-only `plan` agent before returning to the selected agent.
- Archive and unarchive forwarding to OpenCode sessions, with recovery messages
  when a session is archived, deleted, or moved outside BB.
- OpenCode forms that fit BB's question schema use BB's native question UI;
  unsupported forms are cancelled with a visible reason. Forms and permissions
  answered in another OpenCode client are recognized, so a stale answer is never
  sent.
- Agent changes made in OpenCode update BB's Agent option, and OpenCode titles
  fill an untitled BB thread.
- Live refresh of models, commands, and skills when OpenCode reports a change.
- Session cost in BB's context and usage card.

### Changed

- Turn diffs now use OpenCode's `session.diff`; file-change rows use OpenCode
  tool metadata, and write rows no longer carry a per-file patch.
- Question forms and MCP startup wait for OpenCode events instead of polling.
- Provider enablement now uses BB's provider controls, and the BB-tools deny
  rule is always kept in the global OpenCode config.

### Removed

- The `providerEnabled` and `hideBbToolsOutsideBb` settings and their toggles.

### Fixed

- Forks created without a prompt publish their session options, so the Agent row
  is available before the first turn.

## [1.3.0] - 2026-11-01

### Changed

- OpenCode API calls, event streaming, and service discovery and startup now use
  the official OpenCode v2 SDK instead of hand-written HTTP and SSE code.
- The minimum supported versions are now BB 0.48.1, BB Plugin SDK 0.6.104, and
  OpenCode 2.2.5.

## [1.2.0] - 2026-10-26

### Changed

- OpenCode's primary agents are chosen only in the Agent row of BB's model
  switcher. The plugin's own composer agent picker is gone, and so is the
  new-thread pick it held until the thread existed.
- The `agent` session option now always lists every primary agent, `build` and
  `plan` included. It used to appear only when a custom agent existed.
- `@get-bb/plugin-sdk` is a runtime dependency, and dependencies are updated.

### Removed

- BB's plan mode (`/plan` and `--plan`). Pick the `plan` agent instead, for
  example `bb thread spawn --provider opencode2 --option agent=plan`.
- The `getNewThreadAgent` and `setNewThreadAgent` plugin RPC methods and the
  unused dropdown menu component.

## [1.1.0] - 2026-10-18

### Added

- A composer picker for OpenCode's primary agents, backed by a native BB session
  option named `agent`. The option is listed per model, also works with
  `bb thread spawn --option agent=<name>`, and includes project-level agents.

## [1.0.0] - 2026-10-13

First release: BB threads that run on an installed OpenCode v2 server.

### Added

- Threads with fork at a checkpoint, rewind and edit with files restored,
  steering a running turn, stop, discard, rename, and manual `/compact`.
- Permission modes (accept edits, auto, full) encoded as OpenCode session rules.
  A denial goes back to the agent as feedback and the turn continues.
- `/plan`, which runs the turn on OpenCode's read-only `plan` agent, and
  OpenCode's questions through BB's native question UI.
- BB dynamic tools exposed through a per-session local MCP server, hidden from
  other threads and from OpenCode's own sessions, with the `bb` CLI on `PATH` in
  OpenCode shells.
- OpenCode's own skills listed in BB's `/` menu, with BB-only skills attached as
  `SKILL.md` files.
- Native subagents shown as BB delegation rows, off by default.
- OpenCode MCP Code Mode calls shown as "Ran code" rows.
- Timeline rows for reads, searches, directory listings, web search and fetch,
  and commands with live output and exit codes. Each turn's file changes are
  reported as the turn diff.
- Usage and context meter driven by OpenCode's session tokens and model context
  limit.
- Reasoning levels mapped to each model's OpenCode variants.
- Settings page with OpenCode status per host, grouped models, a model
  allowlist, and provider and subagent toggles.
- OpenCode install, update, and auth-aware health checks.
- Recovery that settles turns OpenCode finished while its event stream was down.

### Fixed

- Message editing: turn ordering, rewind persistence, and pagination.
- Compatibility with OpenCode v2.0.27 API changes.
- BB tools not reaching OpenCode under the desktop app, and cold model lists.

[1.3.0]:
  https://github.com/iamEvanYT/bb-plugin-opencode2/compare/v1.2.0...v1.3.0
[1.2.0]:
  https://github.com/iamEvanYT/bb-plugin-opencode2/compare/v1.1.0...v1.2.0
[1.1.0]:
  https://github.com/iamEvanYT/bb-plugin-opencode2/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/iamEvanYT/bb-plugin-opencode2/releases/tag/v1.0.0
