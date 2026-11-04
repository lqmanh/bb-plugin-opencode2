# opencode-bb-skills

Standalone OpenCode v2 server plugin that registers BB's workspace skills in
OpenCode's native skill registry.

The OpenCode v2 provider ([bb-plugin-opencode2](../README.md)) manages this
package through its **Register BB skills natively in OpenCode** setting, writing
the `plugins` entry and per-workspace catalogs. Users do not install it
manually.

## Configuration

The provider writes this entry to the global `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "github:lqmanh/bb-plugin-opencode2#vX.Y.Z::path:opencode-bb-skills",
      "options": {
        "locationsDir": "/Users/me/.bb/plugins/opencode2/runtime/opencode-bb-skills/locations",
      },
    },
  ],
}
```

`locationsDir` is required. `vX.Y.Z` is the provider release that last changed
this package, so other provider releases keep the pin and OpenCode's cached
install.

## Behavior

- The plugin loads per OpenCode location and reads the catalog matching that
  workspace.
- It registers skills with `ctx.skill.transform`; a watcher and a periodic poll
  call `ctx.skill.reload()` when the catalog changes or disappears.
- The native `<available_skills>` guidance and the `skill` tool use the same
  registry.
- If the catalog is missing or invalid, this package registers nothing and the
  provider attaches `SKILL.md` files instead.

## Limits

- The transform is location-scoped. Other OpenCode clients opening the same
  workspace see the skills.
- The catalog is local, so the BB host and the OpenCode service must be
  co-located.
- A colliding native skill ID is overridden in BB-managed workspaces and logged.
- OpenCode needs GitHub access on first install. The repository is public.

## Development

```sh
npm install
npm run typecheck --workspace opencode-bb-skills
npm test --workspace opencode-bb-skills
```

Before a release tag exists, set `BB_OPENCODE_BB_SKILLS_PACKAGE` to a local path
or a branch spec such as
`github:lqmanh/bb-plugin-opencode2#main::path:opencode-bb-skills`.

## Releasing

This package ships in the provider's `vX.Y.Z` releases but has its own version.
When a release changes it and the provider depends on the change, set `version`
here and `BB_SKILLS_PLUGIN_VERSION` (`src/host/opencode/native-skills.ts`) to
that release's version; otherwise leave both alone. `npm test` fails when `src/`
differs from the pinned tag.

- Change the catalog format only with a version bump. Older versions ignore
  catalogs they cannot read, leaving BB skills reachable only by explicit
  `/skill` mention.
- Never move a published tag: OpenCode caches installs by package string, so
  existing installs would keep the old code.
