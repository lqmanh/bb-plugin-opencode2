# OpenCode v2

The bridge uses `@opencode/client`. The generated types cover request and event
shapes, not the semantics below. Docs: https://opencode.ai/v2/docs/build/client.

## Permissions

Rules are `{action, resource, effect: allow|deny|ask}`. OpenCode merges agent
and session rules, with the last match winning. `session.update` replaces the
session ruleset. Permission actions are tool names; MCP tools use
`<server>_<tool>`. BB sessions deny `automation_*` in every permission mode,
which also hides an MCP server named `automation`. OpenCode automations stay
available outside BB.

The bridge answers permission requests for the active turn, including a run
woken by a report, and for background children after their parent turn. A
subagent's own subagents use the top-level task row.

## Events

- The stream is live-only; reconcile active turns after a reconnect.
- `session.inbox.delivered.inboxID` is the prompt message ID. Ignore
  `session.execution.*` until it arrives so earlier work does not end the turn.
- Tool input comes from `session.tool.called.input` or the accumulated
  `session.tool.input.ended` text.
- Shells stream via `session.tool.progress` + `shell.output` cursors. A non-zero
  exit can still be `session.tool.success`: `metadata.exit` carries the code for
  exited commands, while signalled commands set `metadata.signal` and no exit.
  Their content ends with `Exit code: N` or `Exit code: N (SIGTERM)`.
- Edit success carries patches in `metadata.files`; write success has no patch,
  so write rows show only path and kind.
- Native subagents use `metadata.sessionID` for the child session.
- `mcp.status.changed` carries the server name; read `mcp.list` for status.

## Background tasks

A background shell succeeds with `metadata.status: "running"` and
`metadata.shellID`; `session.shell.started`/`shell.created` carry its output
file. Completion is a synthetic `session.inbox.enqueued` item wrapped in
`<background-result kind="shell" …>`, or `session.shell.ended` / `shell.exited`.

Every subagent runs in the background and opens a `local_agent` task row
immediately. Its report is a synthetic `session.inbox.enqueued` item wrapped in
`<background-result kind="subagent" …>`. The tag's `state` decides the row:
`running` keeps it open; any final state settles it. A follow-up to an idle
child reports again.

Each report wakes the parent. When no BB turn is active, the plugin opens one
with `turn.open` and no input row, so its reply, tools, permissions, and forms
reach BB. A BB message sent meanwhile steers into that turn. After an interrupt,
reports from stopped children settle their task rows but do not open a turn
until the next user action. A child that finishes without a report
(`notify: false`) settles after a short grace period.

Both kinds render as thread-scoped `backgroundTask` rows. A foreground shell
that OpenCode backgrounds is closed and replaced by one task row. Fast
completions are buffered until the shell or child ID is known; duplicate and
late completions are ignored.

OpenCode 2.4.2 runs `generate_image` inside Code Mode by default, so only its
synthetic report reaches BB. A direct top-level call still gets a thread-scoped
`backgroundTask` (`taskType: local_image`) that survives the spawning turn. A
completed report adds one turn-scoped `imageGeneration` row with the saved path.
Without a task row, a completed image row has no prompt and uses the saved file
name as its title, and an error report adds a failed row with the report's text.
Stop cancels running image jobs for the session and its descendants. Duplicate
reports add no row. On reconnect, synthetic history and `experimental.job.list`
settle a task row, and assistant history recovers a missed job ID.

After a reconnect, and when a thread starts, resumes, or forks, unsettled tasks
reconcile per task. Shell tasks use `shell.get` for terminal status and exit;
`shell.output` supplies the summary when available. A running shell stays open.
`ShellNotFoundError` settles the task as stopped because the shell is gone.
Subagent tasks use `session.get`’s outcome when the child is idle for
succeeded/failed/interrupted. Otherwise `session.active` decides: a present
child stays open, while an absent child is re-read once and settles from a late
outcome or as stopped. Missing child sessions settle as stopped, and other
errors stay open. Reconciled subagent rows have no summary. There is no
message-history fallback.

`session.background` backgrounds every active foreground backgroundable tool. It
is all-or-nothing, returns no count, and is exposed as a thread menu action. The
host worker resolves the provider session through a registry shared with the
provider bridge under the plugin runtime root.

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

## References

OpenCode references are aliases in `opencode.json` that point at directories
outside the workspace. In OpenCode v2 threads and in the new-thread composer,
`@` lists visible references from `reference.list`. Existing threads on other
providers list none. Search uses the thread's environment directory, or the
project's default source in the new-thread composer.

The agent gets a picked reference in two ways. For every provider, this plugin
adds a short context (alias, absolute path, description). In OpenCode v2
threads, the host also attaches the directory as a `files` entry with the alias
as `name`, so OpenCode gives the agent its one-level listing. If the alias is
gone, the plugin sends a short not-found note. If the directory is not there
yet, the context is still sent and the native attachment is skipped.

In the new-thread composer, references come from the project's default checkout.
If the thread then runs in a worktree whose OpenCode config lacks the alias, the
agent gets the context but no native attachment.

## Usage

`session.usage.updated` carries cumulative session totals and USD cost. Native
subagents run in child sessions, so their usage is kept in a child registry and
merged into the parent total and cost. The parent's last-step tokens and context
meter stay parent-only. Child usage survives the turn and is rebuilt
monotonically after reconnect or resume. A background subagent's task row
carries `usage` only when the child has recorded usage; it is omitted otherwise.

Settings reports the usage source via a `plugin.list` lookup for
`opencode-usage`. The lookup matches the plugin ID first, then the source for
entries without an ID; an active entry wins over a failed one. A missing plugin
shows Not installed with the install link, and Settings makes no RPC call. A
failed plugin or a failed `plugin.list` shows Unavailable with the error. For a
found plugin, Settings calls `opencode-usage/list` and shows Ready, Setup needed
(no accounts), or Unavailable. Usage fetching calls the RPC directly and retries
a cold `rpc.unavailable`; after a failed retry round, later calls skip retries
for 5 minutes or until one succeeds. An implementation with a different ID
serves Provider usage but shows Not installed in Settings. These checks are
read-only.

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
elsewhere is recorded so this plugin does not send a stale reply.

## Live refresh

Provider, model, and credential events invalidate the model catalog;
`command.updated` invalidates commands; `agent.updated` republishes the agent
option for sessions in that location; native skills are refreshed on turns that
mention one; `installation.update-available` clears the cached latest CLI
version. BB keeps its own caches and updates them on its own schedule.

## Cold locations

Since 2.2.7, OpenCode does not wait for plugins in request handlers. A cold
location can briefly return empty `agent.list` and `skill.list` results and
leave plugins out of `plugin.list`; those reads are retried.

## Native skills plugin

The opt-in `nativeSkills` setting adds a standalone OpenCode plugin to the
global `plugins` array:

```jsonc
{
  "package": "github:lqmanh/bb-plugin-opencode2#vX.Y.Z::path:opencode-bb-skills",
  "options": {
    "locationsDir": "<BB dataDir>/plugins/opencode2/runtime/opencode-bb-skills/locations",
  },
}
```

The catalog lives under the plugin data root, so the host and bridge workers
share one `locationsDir`. The skills plugin reads the catalog for the OpenCode
location and registers its skills with `ctx.skill.transform`; a watcher and a
periodic poll call `ctx.skill.reload()` when the catalog changes or disappears.
Each catalog holds only that workspace's effective BB skills, including project
and shared ones.

`vX.Y.Z` is `BB_SKILLS_PLUGIN_VERSION`, the provider release that last changed
the skills plugin ([Releasing](../opencode-bb-skills/README.md#releasing)).
OpenCode caches the install by package string, so other provider releases
neither rewrite the config nor trigger a download. Enabling adds or replaces the
entry, including older providers' pins, and reloads OpenCode when idle;
disabling removes the entry and catalogs. Until OpenCode finishes downloading
after enabling or a pin change, skill mentions use the fallback.

Limits:

- The transform is location-scoped. Other clients opening the same workspace see
  the skills.
- The host and OpenCode service must be co-located.
- A colliding native skill ID is overridden in BB-managed workspaces and logged.
- OpenCode needs GitHub access on first install. The pinned tag must exist
  before users enable the setting.
- For local development, set `BB_OPENCODE_BB_SKILLS_PACKAGE` to a local path or
  a branch spec such as
  `github:lqmanh/bb-plugin-opencode2#main::path:opencode-bb-skills`.

Settings reads this config entry and looks the plugin up in `plugin.list`, with
the same matching and cold retry as the usage source. It shows:

- Off when the setting is off;
- Setup needed when the config entry is missing or the plugin is not loaded;
- Update needed when the pinned package or `locationsDir` differs;
- Unavailable when the plugin or `plugin.list` failed;
- Ready when the plugin is active.

A development override never shows Update needed. These checks are read-only.

If the skills plugin or a skill file is missing, the config is read-only, or a
catalog is invalid, this plugin attaches the skill's `SKILL.md` instead.

## Maintainer notes

### Experimental APIs

OpenCode's `experimental` namespace holds working APIs that may change between
minor releases. Used APIs have no fallback; check them on every OpenCode bump.

| API                                                                                                                                | Status   | Notes                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `experimental.mcp.add`, `remove`                                                                                                   | Used     | Register and remove the per-thread dynamic-tools MCP server.                                                         |
| `experimental.session.instructions.entry.put`, `remove`                                                                            | Used     | Install BB instructions.                                                                                             |
| `experimental.job.list`                                                                                                            | Used     | Lists image jobs for reconnect and Stop, including descendants; delivered jobs leave the list, so history is primary |
| `experimental.job.cancel`                                                                                                          | Used     | Cancels a running image job when the thread stops.                                                                   |
| `experimental.mcp.*` (other)                                                                                                       | Excluded | Management UI not needed.                                                                                            |
| `experimental.config.update`                                                                                                       | Excluded | Only accepts `shell`; the global config is edited directly.                                                          |
| `experimental.usage.limits`                                                                                                        | Excluded | Use [opencode-usage](https://github.com/lqmanh/opencode-usage) instead.                                              |
| `experimental.session.stats`, `import`, `export`                                                                                   | Excluded | No BB surface.                                                                                                       |
| `experimental.automation.*`                                                                                                        | Excluded | BB has its own automations.                                                                                          |
| `experimental.artifacts.*`, `persistentPty.*`                                                                                      | Excluded | No matching BB surface, or overlaps BB terminals.                                                                    |
| `experimental.generate.text`, `generate.image`, `decisions`, `voice.*`                                                             | Excluded | BB has its own services; not needed.                                                                                 |
| `experimental.integration.wellknown.add`, `file.write/watch/unwatch`, `media.get`, `migration.v1.status`, `session.log/wait/skill` | Excluded | Not needed, or overlaps BB APIs.                                                                                     |

### Known gaps

- Command turns without an inbox message have no rewind checkpoint.
- A run woken by a report has no turn diff; per-tool file-change rows still show
  its edits.
- Background task rows do not survive a worker restart; BB settles them as
  interrupted and the plugin does not recreate them.
- Code Mode images have no running row or prompt, and a missed report is not
  recovered.
- An image task stays open after a reconnect when both its history report and
  `experimental.job.list` entry are gone.
- Image display from OpenCode's default tmp `images/<session>/` save location is
  unverified end to end.
- Background shells survive turn handoffs but not `opencode service restart` or
  `stop` (#62978); a vanished shell settles as stopped without its exit code or
  output.
- A subagent started by another subagent counts toward usage and shows its
  permissions and forms under the top-level task row; its output is not shown.
- Reconciled subagent rows have no summary; the session API exposes no result
  text.
- Turn reconciliation is covered by unit tests only; a dropped event stream was
  never reproduced live.
- Unknown OpenCode events are dropped rather than forwarded as diagnostics.
