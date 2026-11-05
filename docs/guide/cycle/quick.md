<!-- sources:
- plugins/adf/skills/quick/**
- plugins/adf/scripts/quick.mjs
- plugins/adf/scripts/lib/quick.mjs
- plugins/adf/schema/quick/**
- plugins/adf/schema/quick-estimate.schema.json
- plugins/adf/schema/prompts/quick-estimate.md
-->

# /adf:quick

`/adf:quick` fixes a small defect in one short cycle. It makes a branch and a worktree, writes one file, runs the affected tests, reviews once and ends the change. For the full cycle, see [The main cycle](README.md).

## What it is for

Use it for a small fix that restores specified behaviour. A small addition of the same kind also fits, for example a missing log line.

It is not for a change to what the system does. A quick change writes no proposal, no specs, no tasks, no plan and no verify record. It never writes `openspec/specs/`. When the fix changes behaviour, take [/adf:propose](propose.md).

The command takes one path and has no flags.

## How to start

The command takes one of these inputs.

| Input | Meaning |
|---|---|
| tracker keys and a phrase | The command works on the issues that the keys name and on the defect that the phrase describes. |
| a change name in kebab-case | The command resumes that change when it is in flight. |
| `list` | The command lists the quick changes in flight. |
| nothing | The command asks: which defect? You name a key, describe it in a phrase, or answer none. |

With none, the command gathers the open bugs. The tracker adds its open bugs when its plugin provides the `bugs` operation. The debt store adds each open entry of class `defect`. See [the tracker role](../extension-points/contract/tracker.md). The change name is `bugs-<YYYYMMDD>-<HHMM>`, in local time.

With a phrase, the change name comes from the phrase. With keys only, it comes from the keys in lower case. The command says the name.

## The context choice

With keys or a phrase, the command asks once whether to gather the context. The context is the tracker search and the debt store. On a yes, it searches with the keys and the phrase. On a no, it uses the keys alone. On a no with a phrase and no keys, it gathers nothing and goes on to the branch.

When the tracker is degraded, the command asks you to fix it, or for a reason to go on without it. A reason lets the run take debt entries only.

## The estimate and the selection

The command filters the candidates before it makes a branch. It excludes these:

- a tracker epic or a tracker story;
- a debt entry that is not a defect;
- a debt entry anchored in more than three files.

It never excludes a key that you named. It flags that item as too large, and you decide. When no candidate is left, it offers `/adf:propose` and stops.

Then one read-only agent, `quick-estimate`, estimates every candidate. For each one it names the files of the fix and says whether the fix changes behaviour. It gives a `fit`: `quick` or `propose`. For a tracker issue it also gives a verdict: `current`, `corrected` or `obsolete`. A script checks the reply. The agent gets one retry. After a second refusal, the candidates go to `/adf:propose`.

The command shows each item with its `fit`, its reason and its files. You select the items to take. An item with `fit` `propose` goes to `/adf:propose`. This command never takes it. A behaviour change is always a `propose`, whatever the agent marked.

## The branch, the worktree and the Draft

The command asks one question for the base and the branch name. It then makes the branch and the worktree, as [/adf:propose](propose.md) does. When the scope holds a tracker item, it starts the issue after your yes.

The command writes `quick.md` and commits the change directory. It then opens a Draft merge request through the forge plugin. Without a forge plugin, it opens none.

## quick.md

`quick.md` is the one file of the change, in `openspec/changes/<name>/`. It has four sections:

| Section | Content |
|---|---|
| `## Goal` | One or two sentences: what is wrong and what the change achieves. |
| `## Scope` | What the change covers and leaves out. It names each key or debt id it takes. |
| `## Plan` | One to three numbered steps. Each step has a `**Files:**` line, an action and a check. |
| `## Summary` | Empty at first. The end of the change fills it. |

The `quick-plan` gate refuses a plan of more than three steps and a step with no file. The session then writes the code of each step and commits each step as one commit.

## The affected tests

After the code, the command runs the affected tests. It reads one command from the section `## Affected tests command` of `openspec/planning.md`. It runs the command in the worktree on the files that the change changed. It leaves out the change directory, `openspec/planning.md` and the files under `.superpowers/`. `{files}` in the command stands for those paths. An example command for vitest is `npx vitest related --run --passWithNoTests {files}`. The run goes into a record, `quick/tests.json`, under the change's state directory.

- With no changed file, no test runs.
- With an empty section, the command waits. The session reads your test runner and proposes one command. On your yes, it writes the command into the section and commits that file alone. On a no, no affected tests run.
- After a failure, the session fixes the code and runs the tests again.

For the other sections of the planning guide, see [Host files](../concepts/host-files.md).

## The one review

A quick change has one review round. The session dispatches the reviewer and fixes each blocking finding itself. It commits each fix and records it. No second round re-reviews the fixes. After the last fix, the affected tests run again. When they fail, the session fixes the failure. It then starts a fresh review run with one new round. The `--fresh` option discards the stored round. When the branch has no change to review, the record says so. A finding that needs a second round goes to `/adf:propose`. For the rules of the round, see [/adf:review](review.md).

## The end

The session writes `## Summary`: what was wrong, what changed, the tests run and the result of the review. It leaves the summary uncommitted, because the end commits it with the move. It then runs the steps of [/adf:archive](archive.md) one at a time. The `merge` step is skipped, with the reason `quick task`. The step `merge-local` asks you first.

The command pushes nothing itself. At the end it shows a report. It tells you to run `/adf:land <name>` after the merge request is merged.

## Resume and list

Run `/adf:quick <name>` again to resume. The command finds the first open step from the ledger, the status of `quick.md`, the review record and the commits of the branch. When the end is under way, it resumes at the end. When the name is a change of the full cycle, the command names the next command of that cycle and stops.

Run `/adf:quick list` to see the quick changes in flight. Each line shows the root and the branch.

## The metrics record

The metrics record of a quick change has the key `cycle` with the value `quick`. See [Metrics](../concepts/metrics.md). Its phases are `gather`, `estimate`, `code`, `tests`, `review` and `end`.

## When it stops

The command stops and offers `/adf:propose` in these cases:

- The fix changes behaviour.
- The plan needs a fourth step.
- No candidate fits a quick task.

The branch and `quick.md` stay. You keep them or remove them.

Not checked: how the reviewer's findings and the dispositions are worded in the review record. This page describes the flow only.
