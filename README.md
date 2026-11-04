# OpenCode v2 for BB

A [BB](https://getbb.app) plugin that runs threads through an installed
[OpenCode v2](https://opencode.ai) server. OpenCode owns model credentials and
its own tool execution; BB provides the thread, timeline, and UI.

## Requirements

- BB 0.48.1 or newer
- OpenCode v2 2.2.5 or newer (`opencode2` on the host's `PATH`); BB's provider
  settings can install or update it
- A model provider connected in OpenCode (`opencode2 auth login`)

## Install

From the BB plugin store, or:

```sh
bb plugin install git:https://github.com/lqmanh/bb-plugin-opencode2.git
```

## Features

- **Threads:** new and resumed sessions, fork at a checkpoint, rewind/edit with
  files restored, steering, stop, discard, rename, and `/compact`.
- **Models and agents:** workspace model discovery, reasoning variants, primary
  agents, and BB's `/plan` mode.
- **Tools and permissions:** accept-edits, auto, and full permission modes;
  native questions and supported forms; BB dynamic tools; OpenCode MCP Code
  Mode; `bb` on `PATH` in shells.
- **Skills:** OpenCode's skills in BB's `/` menu, plus opt-in native BB skills
  through [`opencode-bb-skills`](opencode-bb-skills/).
- **Timeline and usage:** reads, searches, commands, diffs, background tasks,
  session usage, and provider usage from
  [opencode-usage](https://github.com/lqmanh/opencode-usage).
- **Recovery:** reconnects settle turns from OpenCode's state; external archive,
  deletion, or moves produce a clear error.

Not supported: thread goals, service tiers, per-prompt native tool filtering,
replacing OpenCode instructions, and cancelling provider interactions from BB.

## Settings

Open Settings → OpenCode v2 in BB.

- **Status** shows each host's OpenCode version, updates, and `opencode-usage`
  source.
- **Disable provider subagents** makes agents delegate through BB. Off by
  default.
- **Register BB skills natively in OpenCode** adds a `plugins` entry owned by
  this plugin for the pinned [`opencode-bb-skills`](opencode-bb-skills/) plugin,
  which OpenCode installs from GitHub, and writes a per-workspace catalog. Off
  by default. Other OpenCode clients opening the same workspace see the skills;
  the host and OpenCode must be co-located.

The plugin keeps a `bb_opencode2_*` deny rule in the global OpenCode config so
BB tools stay out of OpenCode's own sessions. OpenCode applies config changes
when idle.

See [`skills/opencode2-provider/SKILL.md`](skills/opencode2-provider/SKILL.md)
for settings keys and troubleshooting.

## Development

```sh
npm install
bb plugin types
npm run check
```

`npm run check` formats, typechecks, builds, and runs the test suites. To try a
local checkout, run `bb plugin install .`.

See [docs/architecture.md](docs/architecture.md) and
[docs/opencode-v2.md](docs/opencode-v2.md) for design and OpenCode behavior.

## License

[MIT](LICENSE)
