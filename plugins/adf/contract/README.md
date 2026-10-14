# The ADF Extension Contract

The contract is what the ADF core promises a plugin, and what it expects back. The core never
names a plugin: it reads the project registry and calls whatever the enabled plugins declare.

## Files

| File | Holds |
|---|---|
| `contract.json` | the contract version and the points it defines, each with its kind and operations |
| `README.md` | the format, the calling convention, and every point's input and output |

## Points

A point is a named place in the flow where the core calls plugins. There are two kinds:

- **hook**: the core calls every enabled plugin that provides it, in registry order. Each
  plugin gets only its own items. A plugin that does not provide the hook is skipped; that is
  not an error.
- **role**: at most one enabled plugin provides it. With no provider, the core runs its own
  default, which the point's documentation states.

A plugin declares, per point, the `script` that runs it (deterministic, runs under any agent
runtime) and the `operations` it implements: every operation the point defines.

Each point arrives with the first plugin that needs it. Version `1.0` defined none; `1.1` adds
the `forge` role; `1.2` adds its `push` operation.

## Calling convention

The core runs `node <plugin dir>/<script> <operation>` with the working directory set to the
host root (a change's worktree, when the change has one) and writes one JSON object to stdin:

```json
{ "root": "<absolute host root>", "config": { "...": "the registry entry's config, or {}" }, "input": { } }
```

The script prints one JSON object on stdout. Its `state` is:

- `done`: the operation happened;
- `degraded`: the plugin's tool is missing or not authenticated; nothing was sent, and the
  result says what to run (`hint`, `fallback`). Exit 0: the flow continues and says so;
- `refused`: an input or a call failed; `error` says which, and what was or was not sent.
  Exit 1.

A script that prints no such object is treated as `refused`. With no provider of a role the
core gets `{ "state": "none" }` and applies the role's default.

## Points

### `forge` (role, since 1.1; `push` since 1.2)

Pushes the change branch and keeps its merge request. The core never names a forge.

| Operation | Input | Result when `done` |
|---|---|---|
| `check` | `{}` | `tool: "ready"`; degraded: `tool` is `missing` or `unauthenticated`, with `hint` |
| `open` | `change`, `branch`, `base`, `title`, `draft` (default true), `protected` | the branch pushed, never forced; a merge request into `base`, reused when one is open: `number`, `url`, `reused` |
| `push` (since 1.2) | `change`, `branch`, `protected` | the branch pushed, never forced; nothing else changes |
| `finalize` | `change`, `branch`, `base`, `title`, `body`, `protected` | the description holds `body` in this change's block, other text kept; the merge request leaves draft, then the branch is pushed: `number`, `url` |

A provider refuses a branch that is empty or in `protected`. `body` holds the sections of the
plugin's merge request template. Default with no provider: nothing is pushed, no merge request
exists; archive offers to merge the change into its base, and merges only on the developer's yes.

## Versioning

The version is `major.minor`.

- Adding a point, an operation or an optional field raises the **minor** version. Existing
  plugins keep working.
- Changing the meaning of a point, or adding or changing a required field, raises the **major**
  version.

A plugin names the version it was written for. The core runs a plugin when the majors are equal
and the core's minor is at least the plugin's. Otherwise `/adf:add` and every check refuse the
plugin and name both versions.

## The registry

`.claude/adf-extensions.json` in the host project, committed:

```json
{
  "contract": "1.2",
  "branches": { "integration": "develop", "protected": ["develop", "main"] },
  "extensions": [
    { "plugin": "gitlab@agentic-dev-flow", "config": { "host": "gitlab.example.com" } },
    { "path": "plugins/local-draft" }
  ]
}
```

An entry names an installed plugin by id (`plugin`), or a plugin directory by `path` (a plugin
in development). An id is resolved from Claude Code's install records for the main checkout,
so it survives a plugin update and works in every worktree. The order of `extensions` is the
call order for hooks; a role has at most one provider. `config` is opaque to the core and is
passed to the plugin's operations.

## The declaration

`adf-extension.json` at the plugin root:

```json
{
  "name": "gitlab",
  "contract": "1.1",
  "provides": {
    "forge": { "script": "scripts/forge.mjs", "operations": ["check", "open", "push", "finalize"] }
  },
  "hostFiles": [
    { "from": "templates/merge_request.md", "to": ".gitlab/merge_request_templates/adf.md" }
  ]
}
```

`hostFiles` (optional, since 1.1) are copied into the host by `/adf:add` when missing; a host
that edited its copy keeps it.
