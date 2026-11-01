# Architecture

## How the bridge works

The plugin connects to OpenCode's single shared background service only when a
thread needs it, and never stops it. Discovery, startup, and authentication use
`@opencode/client/service`. Sharing the service matters because OpenCode stores
session state there, and BB may resume a thread from another host worker.

For BB dynamic tools, the plugin starts a local, session-specific MCP process.
OpenCode sees the configured tools, while the plugin checks the calling session
and a random token before forwarding each call to BB. An unchanged tool catalog
keeps the live MCP child across BB's repeated session setup. Discarding the
thread removes its OpenCode MCP registration; a persisted registry lets discards
clean up even when another host worker owns the thread.

OpenCode shells run under the background service, whose environment is fixed at
service start. The plugin sends each session a credential-filtered host
environment, BB's per-session `envVars`, and `PATH` with the `bb` binary
directory first.

## Code layout

```text
src/
  server.ts            BB server entry: provider metadata, settings storage, sync to hosts
  host.ts              Host entry: host RPC, provider bridge, and public test helpers
  app.tsx              Frontend entry: registers the settings slot
  app/                 Settings page
  components/, lib/    UI primitives used by the settings page
  settings-contract.ts Settings and RPC shapes shared by server, host, and app
  model-settings.ts    Model selection and provider setting normalization
  host/                Host implementation, described below
tests/                 Node tests, plus a jsdom test for the settings UI
skills/                Agent skill shipped with the plugin
docs/                  Developer documentation
```

Inside `src/host/`:

- `provider-bridge.ts` validates and dispatches provider protocol requests.
- `opencode-server.ts` owns the service connection and version check, the
  official `@opencode/client` instance, model catalog, persistence, event
  stream, and turn reconciliation.
- `opencode-event-router.ts` translates OpenCode events into BB deltas,
  including live shell output and subagent nesting.
- `session-manager.ts` owns session setup, per-turn preparation (settings,
  permissions, agent, model), MCP registration, and shutdown.
- `maintenance.ts` implements health, install, and update.
- `opencode-version.ts` defines the minimum supported OpenCode version.
- `dynamic-tools-mcp.ts` and `bridge-runtime.ts` expose BB dynamic tools to
  OpenCode and route their calls back.
- `opencode-config.ts` maintains the global deny rule that keeps BB's tools out
  of OpenCode's own sessions.
- `opencode-requests.ts` holds permission rules, checkpoint math, environment
  filtering, and skill roots.
- `timeline.ts`, `tool-mapping.ts`, `prompt.ts`, and `models.ts` contain the
  testable protocol mappings.

## Design decisions

- **Native subagents are off by default** and enforced with a session `deny`
  rule. When the user enables them, they render as BB delegation rows.
- **Permission modes are session rulesets.** `auto` keeps OpenCode's agent rules
  and answers remaining asks with `once`; `full` adds `*` → allow;
  `accept-edits` allows reads, searches, edits, and selected non-mutating tools,
  while other actions follow the catch-all ask rule.
- **BB MCP servers are scoped per directory.** OpenCode shares MCP servers
  across sessions in a directory, so session rules hide other threads' BB tools
  and allow only this thread's `<server>_<tool>` actions.
- **The OpenCode version is checked after connecting.** Passing a version
  predicate to `Service.ensure` would stop and replace the shared service, so
  the bridge verifies `server.info()` instead.
- **Active turns are reconciled after reconnects and every 30 seconds.** The
  bridge compares OpenCode's session state with the turn it started, so a
  dropped event stream does not leave a turn running forever.
- **Turn diffs come from OpenCode's `session.diff`.** Write rows show only path
  and kind because write success carries no patch.
- **Commands run through `session.command`.** A `/name` mention is routed only
  when OpenCode currently lists that command; its mention is stripped and the
  rest of the prompt becomes its arguments. The resulting inbox message becomes
  the turn checkpoint.
- **BB plan mode maps to OpenCode's `plan` agent.** The `/plan` mention is
  removed, the agent switches for that turn, and the next ordinary turn returns
  to the agent picked through the session option.
- **Archive state is mirrored, not inferred.** BB archive and unarchive forward
  to `session.update`; external archive, deletion, and moves raise a recovery
  hint and block later turns with a clear error instead of resuming a session
  OpenCode no longer has.
- **Forms use BB's native question UI only when their schema fits.** External,
  conditional, or oversized forms are cancelled with a model-facing message.
- **Catalog refresh is best-effort.** Plugin caches invalidate on OpenCode
  events; BB's own model and command caches refresh on their own schedule.
- **OpenCode-side state changes are mirrored where BB has a surface.** Agent
  selections update BB's option, and titles fill only untitled threads. Provider
  interactions cannot be cancelled by the bridge, so an externally answered form
  closes its row but not the BB card.

## Known gaps

- Command turns adopt the first inbox message as their checkpoint. A command
  that creates no inbox message has no rewind checkpoint.
- Child-session questions: a subagent's question closes without its `parentRef`.
  Cosmetic and rare.
- Turn reconciliation is covered by unit tests only; a dropped event stream was
  never reproduced against a live service.
- Unknown OpenCode events are dropped rather than forwarded as diagnostics.

See [opencode-v2.md](opencode-v2.md) for the OpenCode behavior and event details
the bridge depends on.
