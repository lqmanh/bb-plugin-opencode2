# OpenCode v2 notes

The bridge uses `@opencode/client`. The generated types cover request and event
shapes, not the semantics below. Docs: https://opencode.ai/v2/docs/build/client.

## Permissions

Rules are `{action, resource, effect: allow|deny|ask}`. OpenCode merges agent
and session rules, with the last match winning. `session.update` replaces the
session ruleset. Permission actions are tool names; MCP tools use
`<server>_<tool>`.

The bridge answers permission requests for the active turn and for background
children after their parent turn. Foreground children without an active turn are
ignored.

## Events

- The stream is live-only; reconcile active turns after a reconnect.
- `session.inbox.delivered.inboxID` is the prompt message ID. Ignore
  `session.execution.*` until it arrives so earlier work does not end the turn.
- Tool input comes from `session.tool.called.input` or the accumulated
  `session.tool.input.ended` text.
- Shells stream via `session.tool.progress` + `shell.output` cursors. A non-zero
  exit can still be `session.tool.success`; read `metadata.exit` or the trailing
  `Exited with code N`.
- Edit success carries patches in `metadata.files`; write success has no patch,
  so write rows show only path and kind.
- Native subagents use `metadata.sessionID` for the child session. Results are
  wrapped in `<subagent sessionID="…" state="…">`.
- `mcp.status.changed` carries the server name; read `mcp.list` for status.
- Compaction also appears as `session.next.compaction.*` or a compaction
  `session.message.updated`.

## Background tasks

A background shell succeeds with `metadata.status: "running"` and
`metadata.shellID`. `session.shell.started`/`shell.created` carry its output
file. Completion is a `session.synthetic` `<shell …>` or
`session.shell.ended`/`shell.exited`.

A background subagent succeeds with `metadata.status: "running"` and the child
`metadata.sessionID`. Completion is a parent `session.synthetic` `<subagent …>`.
Its child-session usage, permissions, and forms survive the spawning turn.

Both render as thread-scoped `backgroundTask` rows. A foreground tool that
OpenCode backgrounds is closed and replaced by one task row. Fast completions
are buffered until the shell or child ID is known; duplicate and late
completions are ignored.

`session.background` backgrounds every active foreground backgroundable tool. It
is all-or-nothing, returns no count, and is exposed as a thread menu action.

`thread/stop` with `interrupt` stops background work before the parent;
`release` leaves OpenCode work alone. BB settles open rows after a worker
restart and does not recreate them.

## Diffs

`session.diff` is per turn. `from`/`to` are user message IDs; omitting `to`
includes steered prompts. Entries carry relative files and unified patches.
Failed requests are treated as no patch.

## Message pagination

`message.list` can return a `next` cursor after the last message. Stop on an
empty page. Send `order=asc` only on the first page.

## Forms

`form.created` is matched to its tool call through `form.metadata.tool.id` when
`metadata.kind` is `"question"`. Forms with no tool row get a synthetic question
row. A form arriving before its row is stashed.

BB supports `string`, `number`, `integer`, `boolean`, and `multiselect` fields.
Forms with external fields, conditions, hidden-only fields, or too many
questions/options are cancelled with a message that OpenCode returns to the
model as a tool failure. Hidden fields use their defaults; required flags,
defaults, limits, and common formats are applied when mapping answers.

## Commands and plan mode

`command.list` returns the workspace's slash commands. A prompt mention routes
to `session.command` only when it is a `command` resource with `/` and the name
is currently listed. The mention is removed and its arguments become the command
text; other mentions keep their offsets. Unknown commands stay ordinary text.

`session.command` returns no message ID. The turn waits for
`session.inbox.enqueued` and uses that inbox ID as its checkpoint.

`promptMode: "plan"` switches to the `plan` agent for the turn and returns to
the previous agent afterward. Steering keeps plan mode. Edit, write, and patch
stay denied even under full permission mode.

## Usage

`session.usage.updated` carries cumulative session totals and USD cost. Native
subagents run in child sessions, so their usage is kept in a child registry and
merged into the parent total and cost. The parent's last-step tokens and context
meter stay parent-only. Child usage survives the turn and is rebuilt
monotonically after reconnect or resume. A background subagent's task row
carries `usage` only when the child has recorded usage; it is omitted otherwise.

## Archive and lifecycle

`session.update({archived})` mirrors BB archive/unarchive. The bridge consumes
its own `session.archived`/`session.unarchived` events so they are not treated
as external. External archive, deletion, or moves raise a recovery hint and
block later turns with a clear error; external archive keeps blocking until
`session.unarchived`. `thread/start` and `thread/resume` clear the broken-thread
reason.

## Two-way state

Agent selections in OpenCode update BB's `agent` option. Renames update only
untitled BB threads. A form answered or cancelled in another client is recorded;
its BB row closes when the user answers or the turn ends. A permission answered
elsewhere is recorded so BB does not send a stale reply.

## Live refresh

Provider, model, and credential events invalidate the model catalog;
`command.updated` invalidates commands; native skills are refreshed on turns
that mention one; `installation.update-available` clears the cached latest CLI
version. BB keeps its own caches and updates them on its own schedule.

## Native skills plugin

The opt-in `nativeSkills` setting adds a standalone OpenCode plugin to the
global `plugins` array:

```jsonc
{
  "package": "github:lqmanh/bb-plugin-opencode2#v1.4.0::path:opencode-bb-skills",
  "options": {
    "locationsDir": "<BB dataDir>/runtime/opencode-bb-skills/locations",
  },
}
```

The plugin reads the catalog matching the OpenCode location and registers its
skills with `ctx.skill.transform`. A watcher and a periodic poll call
`ctx.skill.reload()` when the catalog changes or disappears. Catalogs contain
the workspace's effective BB skills, so project and shared skills are covered
without leaking to other workspaces.

The host rewrites its own entry when BB updates, so the pin follows the BB
version. `opencode plugin check/update` skip exact revisions. Enabling adds or
replaces the entry and reloads OpenCode when idle; disabling removes the entry
and catalogs. The first turn after enable/upgrade may use the fallback while
OpenCode downloads the pinned package.

Limits:

- The transform is location-scoped. Other clients opening the same workspace see
  the skills.
- The host and OpenCode service must be co-located.
- A colliding native skill ID is overridden in BB-managed workspaces and logged.
- OpenCode needs GitHub access on first install. The release tag must exist
  before users enable the setting.
- For local development, set `BB_OPENCODE_BB_SKILLS_PACKAGE` to a local path or
  a full branch-pinned spec such as
  `github:lqmanh/bb-plugin-opencode2#main::path:opencode-bb-skills`. Production
  uses the version tag.

If the plugin is missing, the config is read-only, a catalog is invalid, or a
skill file is missing, BB uses the existing `SKILL.md` attachment fallback.

## Experimental dependencies

- `experimental.mcp.add` / `remove` register the per-thread dynamic-tools MCP
  server.
- `experimental.session.instructions.entry.put` / `remove` install BB
  instructions.
- The global config is edited directly because `experimental.config.update` only
  accepts `shell`.

## Maintainer notes

### Experimental watchlist

Evaluated and excluded unless noted:

| API                                                                                                                                | Decision                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `experimental.usage.limits`                                                                                                        | Use [opencode-usage](https://github.com/lqmanh/opencode-usage) instead. |
| `experimental.session.stats`, `import`, `export`                                                                                   | No BB surface.                                                          |
| `experimental.artifacts.*`, `schedule.*`, `persistentPty.*`                                                                        | No matching BB surface, or overlaps BB terminals.                       |
| `experimental.generate.text`, `generate.image`, `decisions`, `voice.*`                                                             | BB has its own services; not needed.                                    |
| `experimental.mcp.*`                                                                                                               | `add`/`remove` kept for dynamic tools; management UI excluded.          |
| `experimental.config.update`                                                                                                       | Only accepts `shell`; direct config edits remain.                       |
| `experimental.integration.wellknown.add`, `file.write/watch/unwatch`, `media.get`, `migration.v1.status`, `session.log/wait/skill` | Not needed, or overlaps BB APIs.                                        |

### Known gaps

- Command turns without an inbox message have no rewind checkpoint.
- Background task rows do not survive a worker restart; BB settles them as
  interrupted and the plugin does not recreate them.
- Idle completion only marks the thread unread; a transcript message needs BB
  core support.
- Foreground subagent forms are handled only while the parent turn is active;
  background children keep a task-scoped context.
- Turn reconciliation is covered by unit tests only; a dropped event stream was
  never reproduced live.
- Unknown OpenCode events are dropped rather than forwarded as diagnostics.
