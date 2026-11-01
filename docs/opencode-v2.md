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

`session.usage.updated` carries cumulative session totals. `session.step.ended`
and `.failed` carry the latest request's tokens.

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

The bridge matches `form.created` to its pending tool call through
`form.metadata.tool.id`. A form that arrives before the tool row is stashed
until the row opens.

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
