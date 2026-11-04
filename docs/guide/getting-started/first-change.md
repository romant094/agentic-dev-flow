<!-- sources:
- plugins/adf/skills/propose/**
- plugins/adf/skills/apply/**
- plugins/adf/skills/verify/**
- plugins/adf/skills/review/**
- plugins/adf/skills/archive/**
- plugins/adf/scripts/propose.mjs
- plugins/adf/scripts/archive.mjs
- plugins/adf/scripts/lib/changes.mjs
-->

# Your first change

This page takes one small change from `/adf:propose` to `/adf:archive`. Each step names what the command asks and what it leaves on disk.

## Before you start

- Install ADF: [Claude Code](claude-code.md) or [Codex](codex.md).
- Run `/adf:init` and merge its result into the integration branch.
- Keep the main checkout free of uncommitted work. `/adf:propose` refuses when it finds some.
- Pick a change that alters what the system does, for example a small feature. A typo or a dependency bump needs no change: make it directly.

Run each command in the main checkout of the project. Each command after `/adf:propose` takes the change name as an optional argument. Without it, the command uses the active change.

## The steps

1. Run `/adf:propose <change-name>`.

   - Give the change name in kebab-case. If you give a description instead, the command asks what you want to build and derives the name.
   - The command asks you to choose the base branch and the branch name.
   - When a tracker is enabled, it asks which issues the change works on.
   - It writes the artifacts with you, one by one.
   - It commits the artifacts and opens the merge request through the forge plugin.

2. Run `/adf:apply`.

   - The command implements `plan.md` task by task with subagents, in the change's worktree.
   - It asks only when a task is ambiguous, an artifact is wrong, or a task needs a file outside its `**Files:**` block.
   - It stops on a blocker, or on a suite failure that does not also fail on the base branch.

3. Run `/adf:verify`.

   - The command checks that the code matches the change's specs, tasks and design.
   - It shows each proposed edit of a stale skill and asks you to approve it.
   - It ends with a verdict: `PASS`, `PASS WITH WARNINGS` or `FAIL`.
   - On `FAIL`, fix what the failing checks name, then run `/adf:verify` again.

4. Run `/adf:review`.

   - The command runs the project's code review over the branch.
   - It fixes the blocking findings in rounds.
   - It asks you to rule on each finding that it judges a false positive.
   - On `BLOCKED`, resolve the findings that the report names, then run `/adf:review` again.

5. Run `/adf:archive`.

   - The command runs step by step. It resumes at the first unfinished step when you run it again.
   - It asks about each recorded finding or debt that has no place yet.
   - It merges the change's delta specs into the main specs.
   - It asks for your yes before it merges locally, when the project has no forge plugin.
   - It finalizes the merge request, and removes the worktree.

The command `/adf:land` is not part of this cycle. See [the tracker role](../extension-points/contract/tracker.md).

## What you have now

| Where | What |
|---|---|
| `openspec/changes/<name>/` while the change is in flight | `brainstorm.md`, `proposal.md`, `design.md` (optional), `specs/`, `tasks.md`, `plan.md`, then `verify.md` and `review.md` |
| `openspec/changes/archive/<date>-<name>/` after `/adf:archive` | the same change directory, moved |
| `openspec/specs/` | the main specs, with the change's delta specs merged in |
| `.claude/worktrees/` | the change's worktree, removed by `/adf:archive` |
| the merge request | open on the forge, for you to merge |

A change whose specs need no edit skips the `specs` artifact. `/adf:propose` records the reason.

The flow never merges the merge request. You merge it.

The Codex form of each command is in [the Codex page](codex.md).
