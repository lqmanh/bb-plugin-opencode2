# opencode-bb-skills

Standalone OpenCode v2 server plugin that registers BB's workspace skills in
OpenCode's native skill registry.

BB manages this package through the **Register BB skills natively in OpenCode**
setting. It writes the `plugins` entry and per-workspace catalogs; users do not
install it manually.

## Configuration

BB writes an object entry to the global `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "github:lqmanh/bb-plugin-opencode2#v1.5.0::path:opencode-bb-skills",
      "options": {
        "locationsDir": "/Users/me/.bb/plugins/opencode2/runtime/opencode-bb-skills/locations",
      },
    },
  ],
}
```

`locationsDir` is required. The package version follows the BB plugin version;
BB rewrites the pin after an upgrade.

## Behavior

- The plugin loads per OpenCode location and reads the catalog matching that
  workspace.
- It registers skills with `ctx.skill.transform`; a watcher and a periodic poll
  call `ctx.skill.reload()` when the catalog changes or disappears.
- The native `<available_skills>` guidance and the `skill` tool use the same
  registry.
- If the catalog is missing or invalid, the plugin registers nothing and BB uses
  its `SKILL.md` fallback.

## Limits

- The transform is location-scoped. Other OpenCode clients opening the same
  workspace see the skills.
- The catalog is local, so the BB host and OpenCode service must be co-located.
- A colliding native skill ID is overridden in BB-managed workspaces and logged.
- OpenCode needs GitHub access on first install. The repository is public.

## Development

```sh
npm install
npm run typecheck --workspace opencode-bb-skills
npm test --workspace opencode-bb-skills
```

Before a release tag exists, set `BB_OPENCODE_BB_SKILLS_PACKAGE` to a local
package path or a full branch-pinned spec such as
`github:lqmanh/bb-plugin-opencode2#main::path:opencode-bb-skills`. Production
uses the version tag.
