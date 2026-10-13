# The ADF Extension Contract

The contract is what the ADF core promises a plugin, and what it expects back. The core never
names a plugin: it reads the project registry and calls whatever the enabled plugins declare.

## Files

| File | Holds |
|---|---|
| `contract.json` | the contract version and the list of points it defines |
| `points/<point>.<operation>.json` | the input and output schema of one operation (none yet) |

## Points

A point is a named place in the flow where the core calls plugins. There are two kinds:

- **hook**: the core calls every enabled plugin that provides it, in registry order. Each
  plugin gets only its own items. A plugin that does not provide the hook is skipped; that is
  not an error.
- **role**: at most one enabled plugin provides it. With no provider, the core runs its own
  default, which the point's documentation states.

A plugin declares, per point, its operations. Each operation names a `script` (deterministic,
runs under any agent runtime) and, only when it must ask the developer, a `skill`.

Version `1.0` defines no points. Each point arrives with the first plugin that needs it.

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
  "contract": "1.0",
  "extensions": [
    { "path": "plugins/gitlab", "config": { "host": "gitlab.example.com" } }
  ]
}
```

The order of `extensions` is the call order for hooks. `config` is opaque to the core and is
passed to the plugin's operations.

## The declaration

`adf-extension.json` at the plugin root:

```json
{
  "name": "gitlab",
  "contract": "1.0",
  "provides": {}
}
```
