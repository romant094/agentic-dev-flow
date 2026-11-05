<!-- sources:
- plugins/adf/skills/archive/**
- plugins/adf/scripts/archive.mjs
- plugins/adf/scripts/lib/archive.mjs
- plugins/adf/schema/instructions/archive.md
-->

# /adf:archive

`/adf:archive` takes a reviewed change to its end. It merges the delta specs into the main specs. It places every recorded finding and debt. It moves the change into the archive.

It also ingests what the change taught. It finalizes the merge request. It removes the worktree.

## What it takes

The change name, optional. Add `--no-ci` to push the merge request with no CI run.

The preflight refuses, and writes nothing, in these cases:

- `review.md` is not done. Run `/adf:review`.
- A file outside the change directory has uncommitted changes, untracked files included. Archive commits only what it writes. You commit, move or discard these files first. This check applies only before archive starts. A run that resumes skips it.

The `check` step accepts a `PASS` record only. A `BLOCKED` record is refused. It also refuses when a commit after the reviewed commit touches a file other than `review.md`. The code changed since the review: run `/adf:review` again. The one way past a blocking finding is your ruling with a reason at review.

## The steps

A script runs each step. The steps run in this order, one at a time.

| Step | What it does |
|---|---|
| `check` | Reads the review record and the spec base. Shows the warnings. |
| `placements` | Puts every unplaced debt, finding and deviation into a store. |
| `merge` | Merges the delta specs into `openspec/specs/`. |
| `move` | Moves the change to `openspec/changes/archive/<date>-<name>/`. |
| `commit-specs` | Commits the move and the merged specs. |
| `ingest` | Dispatches an agent to update the knowledge base. |
| `commit-memory` | Commits the knowledge base and debt changes. |
| `metrics` | Writes `metrics.json` in the archived change. |
| `commit-metrics` | Commits the metrics. |
| `mr` | Finalizes the merge request. |
| `merge-local` | Merges locally. Runs only when no forge plugin is enabled. |
| `remove` | Removes the worktree. The branch stays. |

The command ends with a report. It names each step that is not finished and the next step to run. When the scope holds a tracker issue, a complete archive names `/adf:land <change>` as the next step. See [the tracker role](../extension-points/contract/tracker.md) and, for the full cycle with `land`, [the extension points](../extension-points/README.md).

## What it asks

- Whether to archive anyway, at `check`, when the change is incomplete. The warnings name the artifacts not done and the unchecked tasks.
- Where each unplaced item goes, at `placements`. The command proposes a destination for each item. The destinations are the product debt store, the ADF debt records, a follow-up change, or an acceptance with your decision. An acceptance needs your explicit yes.
- Nothing at `merge`, except that it shows you the merge preview first. There is no way to archive without the merge.
- Your yes before a local merge, when no forge plugin is enabled.

The command never merges a merge request. You merge it.

## The merge step

The command writes the Purpose of a new capability from `proposal.md`. It needs at least 50 characters.

A conflict is a requirement whose main-spec text changed since the base. One `spec-merge <capability>` agent for each conflicting capability proposes a resolution. The script checks each reply.

Not checked: whether the instructions make you approve a resolution. They say only that a stale delta can be rebased with you instead.

## What it writes and commits

| Commit message | Content |
|---|---|
| `docs(specs): archive <name>` | The old and the new change directory, and the merged main specs. |
| `docs(memory): ingest what <name> taught` | The knowledge-base edits and the debt placements. No commit when nothing changed. |
| `chore(metrics): record <name>` | The metrics record and the ledger copy. No commit when nothing changed. |

Each commit step stages only its own paths. A step refuses when another uncommitted file is in those places. Then you commit, move or discard that file, and run the step again.

The `mr` step writes the body of the merge request from the scenarios and the evidence in `verify.md`. The body does not name the keys of the scope. The core builds the scope's links from `scope.json` and passes them to the forge. With a forge plugin, it takes the request out of draft and pushes. The `remove` step refuses a worktree with uncommitted changes.

## How it resumes

A script keeps the state of each step in `.superpowers/sdd/<name>/archive/state.json` in the main checkout. This file outlives the move and the worktree.

Run `/adf:archive` again. The command asks for the next step and resumes at the first step that is not settled.

- A `done` or `skipped` step never runs again.
- A `failed` or `degraded` step runs again.
- A step runs only after the step before it settles.
- A failed step shows its refusal. Fix the cause, then run the command again.
- A `degraded` `metrics` step does not stop archive.
- The `ingest` step stops after a second refused reply. Only a developer reset ends the stop.
- After `remove`, the worktree is gone. Run `/adf:archive <name>` from the main checkout to see the report.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
