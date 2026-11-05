<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/contract/contract.json
- plugins/adf/scripts/lib/registry.mjs
- plugins/adf/scripts/lib/branches.mjs
- plugins/adf/scripts/lib/roles.mjs
- plugins/adf/scripts/lib/update.mjs
-->

# The registry

The registry is the one file that tells the core which plugins a project uses and which branches are protected. The normative text is the section "The registry" in `plugins/adf/contract/README.md`. This page explains each key and links to that text.

## The file

The registry is `.claude/adf-extensions.json`. It is in the project, and the project commits it. `/adf:init` creates it, `/adf:add` and `/adf:remove` change its plugin list, and `/adf:update` migrates it. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

This is an example:

```json
{
  "contract": "1.11",
  "branches": { "integration": "develop", "protected": ["develop", "main"] },
  "extensions": [
    { "plugin": "adf-gitlab@agentic-dev-flow", "points": ["forge"], "config": { "host": "gitlab.example.com" } }
  ]
}
```

## The top-level keys

| Key | Meaning |
|---|---|
| `contract` | The extension contract version the project runs, in the form `major.minor`. A value in another form is an error. The current value is `version` in `plugins/adf/contract/contract.json`: 1.11. |
| `branches` | The branch policy. `integration` names the branch that a change forks from and merges into. `protected` lists the other branches that nobody commits to directly. The integration branch is always protected. |
| `extensions` | The list of enabled plugins. See the entry fields below. |
| `metrics` | Optional. `metrics.pricesUrl` is an http or https URL of the pricing page. Without it, the core uses its default. See [Metrics](metrics.md). |

The core reads three more optional keys:

| Key | Meaning |
|---|---|
| `review` | Settings of `/adf:review`: `prompt`, `exclude`, `include`, `maxBytes` and `blockOn`. `prompt` is a path relative to the project. `blockOn` lists distinct severities of `CRITICAL`, `HIGH`, `MEDIUM` and `LOW`. See [/adf:review](../cycle/review.md). |
| `debt` | `debt.root` is the directory of the technical debt tree, relative to the project. See [Memory and technical debt](memory-and-debt.md). |
| `outsidePlan` | A list of globs, relative to the project root. The out-of-plan check of `/adf:verify` never reports a path that matches. |

The registry check refuses a key that the core does not know inside `review`, `debt` or `metrics`.

## The entry fields

An entry of `extensions` has exactly one of `plugin` and `path`.

| Field | Meaning |
|---|---|
| `plugin` | The id of an installed plugin, in the form `name@marketplace`. The core finds the plugin through the install records of the main checkout, so the entry survives a plugin update and works in every worktree. |
| `path` | A plugin directory in the project. Use it for a plugin in development. A `path` entry carries the contract points only. Claude Code loads the hooks, commands and skills of a plugin only when it is installed by id. |
| `points` | The points that the plugin provides. `/adf:add` writes it from the `provides` of the plugin's declaration. |
| `config` | The configuration of the plugin. The core does not read it. It passes the object to the plugin's operations. |
| `version` | Optional. The release of the plugin that the entry was configured at, in the form `x.y.z`. `/adf:update` writes it. An entry without it reads its version from the marketplace file of the old release. |

The same plugin or path twice in `extensions` is an error.

The order of `extensions` is the order in which the core calls the hooks. A role has at most one provider. `/adf:add` refuses a second provider of a role.

`extensions.mjs config <name or id> --config '<json>'` replaces the `config` of an enabled entry in place. The entry keeps its position, so the call order stays. `/adf:add` with a second argument does the same.

## Contract versions

The contract version is `major.minor`.

- A new point, operation or optional field raises the minor version. Existing plugins keep working.
- A change to the meaning of a point, or a new or changed required field, raises the major version.

A plugin names the contract version that it was written for. The core runs the plugin when the major versions are equal and the core's minor version is at least the plugin's. Otherwise `/adf:add` and every check refuse the plugin and name both versions.

`/adf:update` sets `contract` to the version of the new release. It refuses an update that changes the major version. See [Troubleshooting](../troubleshooting.md).
