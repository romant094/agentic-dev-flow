<!-- sources:
- plugins/adf/scripts/lib/host-files.mjs
- plugins/adf/scripts/lib/host-merge.mjs
- plugins/adf/scripts/lib/host-settings.mjs
- plugins/adf/scripts/lib/init.mjs
- plugins/adf/host/planning.md
- plugins/adf/contract/README.md
- plugins/adf-gitlab/adf-extension.json
- plugins/adf-memory/adf-extension.json
-->

# Host files

The host is the project that uses the flow. This page lists the files that the flow writes into the host, and which of them the project commits. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## What the flow writes into a project

`/adf:init` writes these files. It never overwrites a file that exists. It does not commit.

| File | Content | Committed |
|---|---|---|
| `.claude/adf-extensions.json` | The registry. Its keys are in [the registry page](registry.md) and in `plugins/adf/contract/README.md`. | Yes |
| `.claude/settings.json` | The key `enabledPlugins` with `adf@agentic-dev-flow`, and the marketplace in `extraKnownMarketplaces`. `/adf:init` adds a missing key only. An explicit `false` stays. | Yes |
| `openspec/planning.md` | The planning guide. The team fills it in. | Yes |
| `openspec/review-prompt.md` | The criteria of the code review. The registry key `review.prompt` can name another path. | Yes |
| `.gitignore` | The lines of the local state, below. | Yes |

`/adf:init` skips the marketplace entry when this machine added the marketplace from a local directory. A local path is valid on one machine only.

A plugin can add host files of its own. They are the `hostFiles` of its `adf-extension.json`. For example, `adf-gitlab` adds a merge request template, and `adf-memory` adds the pages of `.claude/memory/`. `/adf:add` copies a file only when it is missing.

## Local state

`/adf:init` adds these lines to `.gitignore`. The project does not commit what they name.

| Line | Holds |
|---|---|
| `.claude/worktrees/` | The worktrees of the changes. See [Worktrees](worktrees.md). |
| `.superpowers/` | The records of the flow for a change, such as the ledger, and the Superpowers workspace. |
| `docs/superpowers/` | The default output folder of the Superpowers skills. The flow redirects it into the change. |
| `.adf/*` | The local work directory of the extension plugins. |

## The `.adf/` directory

The core keeps two directories of `.adf/` in the project and commits them. `/adf:init` re-includes them after the `.adf/*` line:

| Directory | Holds |
|---|---|
| `.adf/prices/` | The dated price table. See [Metrics](metrics.md). |
| `.adf/retro/` | The report and the sidecar of each retrospective. See [/adf:retro](../cycle/retro.md). |

The rest of `.adf/` is the work directory of the extension plugins. Each plugin has a directory of its own. For example, the plans of `adf-jira` are in `.adf/jira/<skill>/`. A plugin refuses to write there while git does not ignore the path.

In a project that archived changes before the flow, `/adf:init` writes a window sidecar in `.adf/retro/`. Its cut-off is the tip of the integration branch. The older changes then stay out of the first window.

## What `/adf:update` does with them

`/adf:update` compares the host files with the templates of the old and the new release. See [/adf:update](../update.md).
