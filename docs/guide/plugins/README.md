<!-- sources:
- plugins/adf/skills/init/**
- plugins/adf/skills/add/**
- plugins/adf/skills/remove/**
- .claude-plugin/marketplace.json
-->

# Plugins

The core `adf` runs the change cycle. Each plugin adds one tool at an [extension point](../extension-points/README.md). Every plugin is optional.

## Which plugin does what

| Plugin | What it adds | What is skipped without it |
|---|---|---|
| `adf` | The change cycle, the skills, the contract. | The change cycle does not run. |
| [`adf-gitlab`](adf-gitlab.md) | The `forge` role on GitLab, through `glab`. | Nothing is pushed. No merge request exists. Archive offers a local merge. |
| [`adf-memory`](adf-memory.md) | The `knowledge` role: the wiki memory in `.claude/memory/`. | No index is read. Archive skips the ingest and writes no log entry. |
| [`adf-jira`](adf-jira.md) | The `tracker` role on Jira, and seven Jira skills. | The tracker steps are skipped. The scope holds only the debt store and the changes in flight. |
| [`adf-maintainer`](adf-maintainer.md) | The `upstream` role on GitHub, for the maintainer of the flow. | A retrospective files nothing. The findings stay in its sidecar. |
| [`adf-npm-workspaces`](adf-npm-workspaces.md) | The `provision` hook for an npm-workspaces monorepo, and a guard against `npm install` in a worktree. | The core copies the files that the planning guide names, and nothing else. The guard does not run. |
| [`adf-postgres`](adf-postgres.md) | The `provision` and `teardown` hooks: one database for each worktree. | No database is made for a worktree. |
| [`adf-prisma`](adf-prisma.md) | The `provision` hook for the Prisma client and migrations, and the `verify-check` hook with the check `migration-order`. | Verify adds no migration-order section. |
| [`adf-english-check`](adf-english-check.md) | An agent hook that stops a commit of non-English text. | No commit is checked for language. |

For the order of the provision plugins in the registry, see [`adf-prisma`](adf-prisma.md).

## Enable a plugin

1. Install the plugin by id, at project scope.
2. Enable it with `/adf:add`.

```
claude plugin install adf-memory@agentic-dev-flow --scope project
/adf:add adf-memory@agentic-dev-flow
```

`/adf:add` takes the plugin id. As a second argument it takes the configuration of the plugin, as a JSON object. On a plugin that is already enabled, the new configuration replaces the current one. Each plugin page lists its configuration keys.

`/adf:add` writes the entry in `.claude/adf-extensions.json`. See [the registry](../concepts/registry.md).

## Disable a plugin

Run `/adf:remove` with the plugin name or id. It removes the registry entry of the plugin. The files of the plugin stay where they are.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
