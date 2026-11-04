# Architecture

## Processes

```text
BB server (can be remote)
  │ provider registration, settings, host RPCs
  ▼
BB host daemon / provider bridge (execution machine)
  │ @opencode/client HTTP API
  ▼
OpenCode background service (same machine)
  ├── opencode-bb-skills plugin (`ctx.skill.transform`)
  ├── native skill registry and skill tool
  └── OpenCode clients (TUI, web, desktop, ACP, OpenChamber)
```

The BB host is the execution machine. The provider bridge is an OpenCode API
client; OpenCode loads the standalone `opencode-bb-skills` package from its own
config. The BB server can be remote, but the host and OpenCode service must be
co-located because service discovery and the native-skill catalog are local.

## Bridge

The bridge connects to OpenCode's shared background service lazily, when BB
first needs OpenCode, and never stops it. Sharing the service keeps sessions
resumable from another host worker.

BB dynamic tools use a per-session local MCP process. OpenCode sees the tools;
the bridge checks the calling session and a token before forwarding calls to BB.
An unchanged tool catalog keeps the live MCP child across repeated session
setup. Discarding the thread removes its OpenCode registration; a persisted
registry lets another host worker clean up too.

OpenCode shells run under the shared service. Its environment is fixed at
service start; the bridge adds a credential-filtered host environment, BB's
per-session `envVars`, and `bb` first on `PATH`. Host environment changes need a
service restart.

## Code layout

```text
src/
  server/       BB server entry, provider usage, background notifications
  host/
    bridge/     Provider bridge, dynamic tools, runtime transport
    opencode/   OpenCode service, config, requests, usage, models
    session/    Session setup, teardown, persistence
    timeline/   Event routing, timeline mapping, tool mapping
  app/          Settings UI
  shared/       Settings and RPC contracts
tests/          Node and jsdom tests
skills/         Agent skill shipped with the plugin
opencode-bb-skills/  Standalone OpenCode server plugin
docs/           Developer documentation
```

## Design decisions

- **Native skills use a standalone OpenCode plugin.** The plugin is pinned to
  the BB version, reads a per-workspace catalog under the plugin data root
  shared by the host and provider bridge, and registers skills with
  `ctx.skill.transform`. Other clients opening the same workspace see them;
  other workspaces do not.
- **Native subagents are enabled by default.** `subagentsDisabled` adds a
  session deny rule.
- **Background work uses `backgroundTask` rows.** Explicit background shells and
  subagents, plus foreground tools OpenCode backgrounds later, become one
  thread-scoped row.
- **`session.background` is a user action.** It is session-wide and
  all-or-nothing, returns no count, is a no-op when nothing is blocking, and is
  never called automatically.
- **Permission modes are session rulesets.** `auto` keeps OpenCode's agent rules
  and answers remaining asks once; `full` allows everything; `accept-edits`
  allows reads, searches, edits, and selected non-mutating tools.
- **BB MCP servers are scoped per directory.** Session rules hide other threads'
  BB tools and allow only this thread's server.
- **The OpenCode version is checked after connecting.** Passing a version
  predicate to `Service.ensure` could stop the shared service.
- **Turns are reconciled after reconnects and every 30 seconds.** A dropped
  event stream does not leave a turn running forever.
- **Commands and plan mode use OpenCode's own registries.** Only currently
  listed commands are routed; `/plan` switches to the `plan` agent for one turn.
- **Archive state is mirrored, not inferred.** External archive, deletion, or
  moves block later turns with a clear error.
- **Forms use BB's question UI only when their schema fits.** Unsupported forms
  are cancelled with a model-facing message.
- **Child usage is merged into the parent.** Child tokens and cost count toward
  the thread; the parent's context meter stays parent-only.

See [opencode-v2.md](opencode-v2.md) for OpenCode behavior, known gaps, and the
experimental API watchlist.
