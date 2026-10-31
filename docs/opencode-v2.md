# OpenCode v2 notes

The bridge calls OpenCode through `@opencode/client`. Its generated types cover
request and response fields and event envelopes, but not the semantics and
metadata below. Official API docs: <https://opencode.ai/v2/docs/api>.

## Permissions

Rules are `{action, resource, effect: allow|deny|ask}`. OpenCode merges the
agent rules with the session rules and evaluates them with the last matching
rule winning. `session.update` replaces the session ruleset.

Permission actions are tool names. MCP tools use `<server>_<tool>`, which is
how `bb_opencode2_*` rules hide the per-thread BB servers.

The bridge answers `permission.asked` even when no turn is active.

## Events

The event stream is live-only: it does not replay, so reconcile active turns
after a reconnect.

The bridge treats `session.inbox.delivered.inboxID` as the prompt message ID and
ignores `session.execution.*` until it arrives, so trailing events from earlier
work do not end the new turn.

`session.usage.updated` carries cumulative session totals.
`session.step.ended` and `.failed` carry the latest request's tokens.

The bridge accepts tool input from `session.tool.called.input` or, when that is
absent, from the accumulated `session.tool.input.ended` text.

Shell tools emit `session.tool.progress` with `metadata.shellID`; poll
`shell.output` with its byte cursor to stream output while the command runs. A
non-zero exit can still arrive as `session.tool.success`; read `metadata.exit`
or the trailing `Exited with code N` in the content.

Edit success carries per-file patches under `metadata.files`:
`{file, patch, status, additions, deletions}`. Write success has no patch.

Native subagents: `session.tool.progress` carries `metadata.sessionID` for the
child session, and child-session events use that session ID. The tool result is
wrapped in `<subagent sessionID="…" state="…">…</subagent>`.

The bridge polls questions through `session.form.list` rather than the
`form.created` event, and matches a form to its pending tool call through
`form.metadata.tool.id`.

Compaction also accepts legacy `session.next.compaction.*` names and
`session.message.updated` with a compaction message.

## Message pagination

`message.list` can return a `next` cursor after the last message, so stop on an
empty page rather than on a missing cursor. Send `order=asc` only on the first
page; use the cursor alone for later pages.
