<!-- sources:
- plugins/adf/scripts/lib/host-files.mjs
- plugins/adf/scripts/lib/host-merge.mjs
- plugins/adf/scripts/lib/host-settings.mjs
- plugins/adf/scripts/lib/init.mjs
- plugins/adf/host/guide.md
- plugins/adf/schema/settings.schema.json
- plugins/adf/scripts/lib/settings.mjs
- plugins/adf/scripts/settings.mjs
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
| `adf/settings.json` | The settings: the values that the scripts of the flow read, one key for each value. A script writes each value. See [The settings](#the-settings). | Yes |
| `adf/guide.md` | The planning guide: prose for the plan and verify agents, `Where to look` and `Checks that need the developer`. The team fills it in. | Yes |
| `adf/review-prompt.md` | The criteria of the code review. The registry key `review.prompt` can name another path. `/adf:init` writes it once; then it is the project's file. | Yes |
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

## The settings

`adf/settings.json` holds one key for each value. The schema `plugins/adf/schema/settings.schema.json` gives the type of each key and its instructions. A script checks the file against the schema before it reads a value. A key that the file does not hold takes its default.

| Key | Type | Holds |
|---|---|---|
| `packages` | list of paths | The packages or the top-level source directories of the project. Plan lint warns about a task that spans two of them. |
| `checks` | list of commands | The commands that install, build, test and lint the project. Each implementer and fixer prompt quotes them. |
| `wholeSuiteCommand` | command or null | The command that runs every test with no cache. Apply runs it at the end. |
| `affectedTestsCommand` | command or null | The command that runs the tests of some files, with `{files}`. A quick task runs it. |
| `failedTestsCommand` | command or null | The command that runs some tests, with `{tests}`. The base check of a failed suite runs it. |
| `freshRunProof` | line or null | A line that the whole-suite output holds only when nothing came from a cache. |
| `testFirstShares` | list of paths or null | The untracked paths that a new test needs. A list, also an empty one, makes the flow prove each test-first task. Null leaves the proof to the reviewer. |
| `worktreeCopies` | list of paths | The untracked files that each worktree copies from the main checkout. |
| `worktreePreparation` | list of `{ command, inputs }` | The commands that rebuild what git ignores in a new worktree, with the input paths that make them run again. |
| `formatCommand` | command or null | The command that formats files, with `{files}`. It runs before each commit of the flow. |

The plan and verify agents read the settings with the planning guide.

Nobody edits the file by hand. `settings.mjs` reads and records each value, and checks it first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" show
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" get --key formatCommand
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" set --key formatCommand --value '"npx biome format --write {files}"' [--commit]
```

`get` also gives the instructions of the key from the schema. `set` takes the value as JSON. With `--commit`, it commits the settings alone.

## What `/adf:update` does with them

`/adf:update` compares the `hostFiles` of the plugins with the templates of the old and the new release. It never changes the settings, the planning guide or the review prompt. See [/adf:update](../update.md).
