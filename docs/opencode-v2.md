# OpenCode v2 notes

The bridge calls OpenCode through `@opencode/client`. Its generated types cover
request and response fields and event envelopes, but not the semantics and
metadata below. Official API docs: <https://opencode.ai/v2/docs/api>.

## Permissions

Rules are `{action, resource, effect: allow|deny|ask}`. OpenCode merges the
agent rules with the session rules and evaluates them with the last matching
rule winning. `session.update` replaces the session ruleset.

Permission actions are tool names. MCP tools use `<server>_<tool>`, which is how
`bb_opencode2_*` rules hide the per-thread BB servers.

The bridge only answers `permission.asked` while a turn is active; otherwise it
ignores the request.

## Events

The event stream is live-only: it does not replay, so reconcile active turns
after a reconnect.

The bridge treats `session.inbox.delivered.inboxID` as the prompt message ID and
ignores `session.execution.*` until it arrives, so trailing events from earlier
work do not end the new turn.

The bridge accepts tool input from `session.tool.called.input` or, when that is
absent, from the accumulated `session.tool.input.ended` text.

Shell tools emit `session.tool.progress` with `metadata.shellID`; poll
`shell.output` with its byte cursor to stream output while the command runs. A
non-zero exit can still arrive as `session.tool.success`; read `metadata.exit`
or the trailing `Exited with code N` in the content.

Edit success carries per-file patches under `metadata.files`:
`{file, patch, status, additions, deletions}`. Write success has no patch, so
write rows show only path and kind; the turn diff carries the patch.

Native subagents: `session.tool.progress` carries `metadata.sessionID` for the
child session, and child-session events use that session ID. The tool result is
wrapped in `<subagent sessionID="…" state="…">…</subagent>`.

`mcp.status.changed` carries the server name. Read `mcp.list` once per event to
get the new status.

Compaction also accepts legacy `session.next.compaction.*` names and
`session.message.updated` with a compaction message.

## Diffs

`session.diff` is per turn: `from` and `to` are user message IDs, and omitting
`to` includes steered prompts in the same turn. Entries carry relative files and
unified patches; `context` controls hunk size. An empty turn or a session
without snapshots yields no entries, and the bridge treats a failed request as
no patch. Shell changes and write patches appear in the turn diff, not as
per-tool file rows.

## Message pagination

`message.list` can return a `next` cursor after the last message, so stop on an
empty page rather than on a missing cursor. Send `order=asc` only on the first
page; use the cursor alone for later pages.

## Forms

`form.created` is matched to its pending tool call through
`form.metadata.tool.id` when `metadata.kind` is `"question"`. The question tool
sets that metadata. A form from any other source, or one with no tool row, gets
a synthetic question row keyed by the form ID. A form that arrives before the
question tool row is stashed until the row opens.

BB's question UI can represent `string`, `number`, `integer`, `boolean`, and
`multiselect` fields only. Forms with `external` fields, `when` conditions,
hidden-only fields, or more questions or options than BB accepts are cancelled
with a message, which OpenCode returns to the model as tool failure. Hidden
fields contribute their defaults. `required`, `custom`, defaults, number and
string limits, and `email`/`uri`/`date`/`date-time` formats are applied when the
answer is mapped back.

## Commands

`command.list` returns the workspace's slash commands. The bridge advertises
`commands: { list: true }` and answers `commands/list`; BB's command cache
refreshes on its own schedule. A prompt mention is routed to `session.command`
only when it is a `command` resource, uses the `/` trigger, and the name is in
the current list. The mention is removed from the prompt text and its arguments
become the command's text; other mentions keep their offsets. Unknown commands
stay ordinary text.

`session.command` returns no message ID. The turn waits for
`session.inbox.enqueued` and adopts that inbox ID as its checkpoint, then uses
`session.inbox.delivered` to know the input started. A command that never
creates an inbox message has no checkpoint.

`promptMode: "plan"` in the turn options is BB plan mode, not an OpenCode
command. The bridge removes the `/plan` mention, switches the session to the
`plan` agent for the turn, and returns to the `agent` session option or the
pre-plan agent on the next ordinary turn. Steering does not end plan mode. While
plan mode is active, the session rules also deny `edit`, `write`, and `patch`,
so full permission mode cannot override the plan agent's edit restriction.

## Usage and cost

`session.usage.updated` carries cumulative session totals and `cost` in USD
(`MoneyUSD`). The bridge forwards the cost on the `contextWindow` delta.
`session.step.ended` and `.failed` carry the latest request's tokens.

## Archive and lifecycle

`session.update({archived})` archives or unarchives the OpenCode session. BB
archive and unarchive commands are forwarded there, and the resulting
`session.archived`/`session.unarchived` event is consumed so it is not treated
as an external change.

`session.archived` from outside BB marks the session as externally archived and
raises the `sessionArchived` recovery hint; the next turn fails until
`session.unarchived` arrives. `session.deleted` fails an active turn, removes
the session from memory, and records a broken-thread reason for the next turn.
`session.moved` fails an active turn and blocks later turns with the new
location. `thread/start` and `thread/resume` clear a broken-thread reason.

## Two-way state

`session.agent.selected` mirrors an agent chosen in OpenCode back into BB's
`agent` session option: the bridge updates `agentChoice` and republishes
`bb/session-options` and `bb/session-option-selections`. Plan mode ignores the
event for its turn so its own switch does not overwrite the user's choice.

`session.model.selected` updates the bridge's local model and clears the cached
context window. BB owns the sticky model, so the next turn switches back; the
bridge emits a `provider.warning` when the change is external.

`session.renamed` emits a `thread.name` delta with `source: "agent"`. BB applies
it only to an untitled thread, so a BB title is never overwritten. A title this
bridge set is ignored as its own echo.

`permission.replied`, `form.replied`, and `form.cancelled` record interactions
settled in another OpenCode client. The provider bridge cannot cancel a provider
interaction; BB's card remains until the user answers it or the turn ends. When
the user later answers the card, a form closes its row as `Answered in OpenCode`
or `Cancelled in OpenCode`, and a permission answer is not sent to OpenCode
again.

## Live refresh

`provider.updated`, `model.updated`, and `credential.updated` invalidate the
model catalog cache. `command.updated` invalidates the command catalog, and
`skill.updated` makes sessions reload native skills on their next turn.
`installation.update-available` clears the cached latest CLI version. BB keeps
its own model and command caches, so its picker updates on its next refresh.

## Experimental dependencies

Kept because there is no non-experimental alternative:

- `experimental.mcp.add` and `remove` register the per-thread BB dynamic-tools
  MCP server.
- `experimental.session.instructions.entry.put` and `remove` install BB
  instructions on the session.
- The global BB-tools deny rule edits `opencode.json(c)` directly.
  `experimental.config.update` is the only config write API, so the direct edit
  remains.

## Experimental watchlist

Revisit if promoted or dropped:

| API                                                           | Would enable                                                                     | Current decision                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `experimental.usage.limits`                                   | Provider usage and quota card, including Go rolling, weekly, and monthly windows | Excluded                                                          |
| `experimental.session.stats`                                  | Local token, cost, and tool usage dashboard                                      | Excluded; needs a native BB surface                               |
| `experimental.session.import` and `export`                    | Session import and export                                                        | Excluded; BB has no import surface                                |
| `experimental.artifacts.*`                                    | Artifact browser or panel                                                        | Excluded; no native BB artifact surface                           |
| `experimental.schedule.*`                                     | OpenCode schedules                                                               | Excluded; BB has `sendAt` and plugin cron                         |
| `experimental.persistentPty.*`                                | Persistent PTY integration                                                       | Excluded; overlaps BB terminals                                   |
| `experimental.generate.text`                                  | OpenCode-backed BB AI service                                                    | Excluded; BB helper timeout is 5 seconds                          |
| `experimental.generate.image` and `decisions`                 | Image generation and structured decisions                                        | Not needed                                                        |
| `experimental.voice.*`                                        | Voice input                                                                      | Excluded; BB has its own voice service                            |
| `experimental.mcp.add`, `remove`, `connect`, and `disconnect` | MCP management                                                                   | `add` and `remove` kept for dynamic tools; management UI excluded |
| `experimental.config.update`                                  | Native config writes                                                             | Excluded; direct file edit remains                                |
| `experimental.integration.wellknown.add`                      | Auth discovery                                                                   | Not needed                                                        |
| `experimental.file.write`, `watch`, and `unwatch`             | File operations                                                                  | Overlaps BB file APIs                                             |
| `experimental.media.get`                                      | Media retrieval                                                                  | Not needed                                                        |
| `experimental.migration.v1.status`                            | V1 migration status                                                              | Not needed                                                        |
| `experimental.session.log`, `wait`, and `skill`               | Diagnostics, waiting, and skill activation                                       | Not needed                                                        |
