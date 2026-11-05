<!-- sources:
- plugins/adf/skills/retro/**
- plugins/adf/scripts/retro.mjs
- plugins/adf/scripts/lib/retro.mjs
- plugins/adf/scripts/lib/retro-render.mjs
- plugins/adf/schema/instructions/retro.md
-->

# /adf:retro

`/adf:retro` runs a retrospective on the flow. It is not a stage of the main cycle. It assesses how the flow worked over archived changes, and nothing else. See [The main cycle](README.md).

## What it takes

Choose one mode.

| Input | Changes covered |
|---|---|
| nothing | Every change archived since the last window retrospective. All of them when there is none. |
| `--change <name>` | One archived change. |
| `--from <YYYY-MM-DD> --to <YYYY-MM-DD>` | The changes merged in that period. |

The id of a retrospective is `<date>-window`, `<date>-period` or `<date>-<change>`. Only a window retrospective starts the next window. It does so once its report is on the fetched integration branch.

`/adf:archive` suggests `/adf:retro --change <name>` when the record of a change shows a hurt signal.

## What it does

A script runs each step. One agent reasons over the numbers that the scripts compute.

| Step | What it does |
|---|---|
| `start` | Fetches the integration branch. Makes the branch `chore/retro/<id>` and its worktree. |
| `window` | Selects the changes. Writes the input and the prompt for the agent. |
| `reply` | Checks the reply of the `retro <id>` agent. |
| `file` | Files the findings and the open ADF debt upstream, through the upstream role. |
| `render` | Writes the report and the sidecar. |
| `record` | Commits both files and the debt tree files that `file` marked. |
| `publish` | Opens a merge request, or merges locally. |
| `remove` | Removes the worktree. |

The report has a `Changes` table. When the window holds a quick change, the report adds two sections after it: `### Full cycle` and `### Quick cycle`. Each section lists, for each change of that cycle, the active minutes, the turns, the tokens and the cost. A window with no quick change has neither section.

## What it asks

- Your yes before it files upstream. The command shows the findings and the ADF debt records it would file. You can choose some of them. Without an upstream provider, it skips filing.
- Your yes before a local merge, when no forge plugin is enabled. On a no, you merge the branch yourself.

## What it writes and commits

| Where | What |
|---|---|
| `.adf/retro/<id>.md` | The report. |
| `.adf/retro/<id>.json` | The sidecar with the computed findings. |
| the debt tree | The Filed column of each ADF debt record that was filed. |
| `.superpowers/retro/<id>/` | The input, the prompt, the replies and the state. This folder is ignored. |

The commit message is `docs(retro): <mode> retrospective <date>`, with ` of <change>` for one change. A retrospective writes no new debt. It commits only the two files and the debt tree files that `file` marked.

With a forge plugin, the merge request targets the integration branch. It is not a draft and it runs no CI. The command never merges it.

## How it resumes

Run `/adf:retro` again. A script keeps the state of each step in `.superpowers/retro/<id>/state.json` in the main checkout. The next step is the first one that is not settled.

- A `done` or `skipped` step is not run again.
- A `failed` or `degraded` step runs again. The exception is `file` after `render` has run.
- A step that waits for your yes holds. Nothing is recorded until you answer.
- A refused reply goes back once to the same agent. After a second refusal, the retrospective ends.
- A local merge starts the next window only after you push the integration branch.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
