<!-- sources:
- plugins/adf/skills/apply/**
- plugins/adf/scripts/apply-status.mjs
- plugins/adf/scripts/dispatch.mjs
- plugins/adf/scripts/lib/apply-status.mjs
- plugins/adf/scripts/lib/dispatch.mjs
- plugins/adf/schema/instructions/apply.md
- plugins/adf/scripts/preflight.mjs
-->

# /adf:apply

`/adf:apply` implements the plan of a change. It runs `plan.md` task group by task group with subagents, in the worktree of the change. It writes no artifact.

## What it takes

The change name, optional. Without it, the command uses the change named in the conversation, or else the active change.

The command refuses, and changes nothing, in these cases:

- The Superpowers skills are missing.
- The change root that the command resolves is the main checkout, or its branch is unnamed or protected.
- The plan is missing. The message sends you to `/adf:propose <name>`.
- The plan names a file or symbol that the tree does not hold. Correct `plan.md` first.
- An open item of `tasks.md` has no plan task, for example after an update of the change. Revise `plan.md` first.
- Every task is complete. The message sends you to `/adf:verify`.
- Every task is complete and `verify.md` says `Verdict: FAIL`. Open an apply round with `plan.mjs reopen`.

## What it asks

The command asks only in these cases:

- A task is ambiguous or a requirement is unclear.
- The work shows that an artifact is wrong. The command names the artifact and suggests the update.
- A task needs a file outside its `**Files:**` block, for a reason the apply rules do not cover.

It stops and reports in these cases:

- A blocker or an error.
- A refused tree guard or a blocked group.
- An open reuse-sweep finding.
- A suite failure that does not also fail on the base branch.

## What it does

1. Provision the worktree with the hooks of the project's plugins.
2. Show the progress: the tasks complete, the tasks remaining, and the test-first tasks.
3. Dispatch an implementer and reviewers for each task, into the worktree of its task group. The main session never implements a task. Each implementer and fixer prompt quotes the commands of the key `checks` in `adf/settings.json`, so the agent runs the project's own commands.
4. Tick each task when its review loop is clean. A task with no code whose check only you can run, such as a bench pass, is ticked on the file that records your result.
5. Merge each group when every task of it is complete. A scoped review checks the merge.
6. Run the final review, the reuse sweep and the whole suite.

A blocked group keeps its worktree and pauses apply. Independent groups continue.

The tree guard checks after each round of dispatches that no other checkout moved. It does not stop for a move the round could not cause, and reports it as `foreign`: commits in the worktree of another change in flight that the records of that change name, or that came while those records advanced, and a fast-forward of a protected branch in the main checkout, such as a `git pull`. An uncommitted edit in the worktree of another change always stops apply.

## What it writes and commits

| Where | What |
|---|---|
| the change worktree | The code of the tasks, committed by the implementers. |
| `adf/changes/<name>/tasks.md` | One tick per task, committed as `chore(adf): tick <item> of <name>`. |
| `adf/changes/<name>/plan.md` | An "Added during apply" line for each file that no task names. |
| `adf/changes/<name>/.apply-test-record.md` | The whole-suite record, committed as `docs(adf): record the whole-suite run of <name>`. This is the last commit. |
| `.superpowers/sdd/<name>/ledger.jsonl` | The judgements of the run: deviations, debt, rulings and handoffs. |

The command pushes the change branch through the forge plugin after each group merge and after the suite record. With no forge plugin, nothing is pushed. This is not an error.

When the project has no `wholeSuiteCommand` in `adf/settings.json`, the command finds one with you and records it.

When the whole suite fails, the command runs it again on the base branch after the main run, to find the failures that are not new. When `adf/settings.json` has a `failedTestsCommand` with `{tests}`, the command runs only the failed tests on the base.

The command waits for the whole suite in the foreground, for up to 10 minutes. A longer suite runs in the background, and the command waits for it with `suite.mjs wait`, which returns the result as soon as the run ends. Each run writes a marker, `.superpowers/sdd/<name>/suite/run.json`, and the report refuses until the marker of the recorded run says done. The command never schedules a wakeup, so a headless session ends when its work ends.

## How it resumes

Run `/adf:apply` again. A script reads the state again from the Execution Graph in `plan.md`, from git, from `tasks.md` and from the ledger. Ticked tasks and merged groups stay done.

At a group boundary, the command can record a handoff and stop for a fresh session. The next run comes up from the same state.

After a `FAIL` from `/adf:verify` that needs a code change, open an apply round:

1. Write the text of the fix task into a file.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" reopen --change <name> --title "<the fix>" --task-file <file>`.
3. Run `/adf:apply`.
4. Run `/adf:verify` again.

`plan.mjs reopen` appends the task to `tasks.md` and `plan.md`, and commits both files.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
