# Iteration 20 — Quick task

## Goal

A developer fixes a small defect with `/adf:quick` many times faster than through
`/adf:propose`, and the fix still leaves a record: one short quick-task file, a commit that says
what was wrong and why, the wiki memory and the log updated, a merge request with the links of
what it took, and the tracker issues handed off after the merge.

## Intent

A fix that restores already-specified behaviour may skip the change cycle today (the direct-fix
rule, `plugins/adf-memory/instructions/fix.md`), but then it has no branch policy, no merge
request from the flow, no tracker hand-off and no check. The full cycle is too slow for it: a
small change in the origin project (`settings-sidebar-layout`, 7 tasks) took about two hours of
agent work, 430 turns and $19.47 (its `metrics.json`). The typical case: an SNMP request is not
written to the log, and the fix adds the log line.

## Studied: `/gsd:quick` (2026-11-05)

From `.claude/commands/gsd/quick.md` and `.claude/get-shit-done/workflows/quick.md` in a project
of the developer's that uses it (14 quick tasks):

- One planner agent writes a plan of 1–3 tasks, one executor agent writes the code with one commit
  per task and a summary. By default no discussion, research, plan check, verification or code
  review; flags (`--discuss`, `--research`, `--validate`, `--full`) add them.
- The artifacts: `PLAN.md` and `SUMMARY.md` in `.planning/quick/<id>-<slug>/`, and one row in a
  "Quick Tasks Completed" table of `STATE.md`. Plans are 3–14 KB: per task the files, the
  problem, the action, the verification and the done criterion.
- `list`, `status <slug>` and `resume <slug>`; a branch only when the project configures one.

Taken: the short plan and the summary as the only artifacts, atomic commits, resume. Not taken:
the flags, the separate planner and executor agents, the work on the current branch.

## Settled by the developer (2026-11-05)

1. **Only a fix that does not change behaviour.** A bug fix restoring specified behaviour, or a
   small addition of the same kind, such as a missing log line. No proposal, specs, tasks or
   plan artifacts, and `openspec/specs/` is never written. A complex path is `/adf:propose`.
2. **No flags.** The quick task always takes one short path.
3. **Context gathering is the developer's choice.** The command asks whether to gather it.
   - No: the work starts from the developer's description or the tracker keys given.
   - Yes: the tracker (when one is enabled) and the debt store are gathered; what is clearly
     large is dropped; the rest is estimated by reasoning (what to fix, where, roughly how many
     files, whether behaviour changes); the developer selects. Several bugs may go in one quick
     task.
4. **The result follows the main cycle.** Its own branch and worktree from the base, the branch
   named by the tracker key as propose names it, the merge request through the forge plugin,
   `/adf:land` after the merge.
5. **Checks before the merge request:** no build; only the tests the change affects; one short
   code review.
6. **The session writes the code itself**, with no implementer agent.
7. **Every stage calls the same roles and hooks as the main cycle** (tracker, forge, knowledge,
   `provision` and `teardown`, the English check and the other host hooks); a stage whose role or
   hook no enabled plugin provides is skipped and said.
8. **The technical debt is the core's** and is always available; the wiki memory is the
   `adf-memory` plugin's (`knowledge` role), so the ingest runs only when it is enabled.
9. The merge request links come from iteration 19, which runs first.
10. **With no key and no phrase**, the quick task asks for a key or a phrase. With neither, it asks
    the tracker for the project's open bugs and shows them for the selection. This is a new
    tracker operation and a contract change; `adf-jira` implements it.
11. **Two cycles of one flow: `full` and `quick`.** The core's schemas are named by cycle, `full`
    (the cycle from propose to archive) and `quick`; prose says "the full cycle" and "the quick
    cycle". The commands stay `/adf:propose` and `/adf:quick`.
12. **Metrics are mandatory.** Every quick task writes its metrics record, so that its speed and
    cost can be analysed and compared with the main cycle.

## Calls made by the designer, not the developer

- **The quick task is a change of its own schema.** It lives in `openspec/changes/<name>/` like any
  change, with `meta.schema` set to `quick`. The core's one schema today is named `adf`
  (`schema/schema.json:2`) and that name is in the metadata of every change written so far; it is
  renamed `full`, and `adf` read in a change's metadata means `full`, so no change in flight or in
  an archive is migrated. Today every script loads the one schema directory
  (`lib/schema.mjs:9`) and nothing reads `meta.schema` (`lib/changes.mjs:79`); `loadSchema` takes
  the change's schema from it, and every caller passes the change's (`forge.mjs`, `propose.mjs`,
  `plan.mjs`, `specs.mjs`, `lib/archive.mjs`). The `quick` schema's one artifact is `quick.md`:
  the goal, the scope taken, a plan of 1–3 steps (files, action, check), and after the code a
  summary (what was wrong, what changed, the tests run, the review's result). `/adf:quick list`
  and a rerun to resume, as the other commands resume.
- **Gathering reuses `scope.mjs`.** `gather` and `select` as in propose. Tracker keys the developer
  gives are always read, also when the developer declines the gathering; the decline only skips
  the search. The "clearly large" filter is a script step over what gather returns, on data the
  contract already carries: a tracker item of kind `epic` or `story`; a debt entry whose class is
  not `defect`, or with more than three files in its anchors. The filter needs no contract change: an issue with
  sub-tasks is left to the estimate. The estimate is one read-only agent for all remaining
  candidates, its JSON reply checked by script; it reads each item and the code its anchors or
  text point to, and marks each `quick` or `propose` with its reason. For a taken tracker issue
  the same reply gives the verdict that `scope.mjs start` requires (`lib/scope.mjs:867`:
  `current`, `corrected` or `obsolete`), so propose's per-issue check (`check-input`) is not run.
- **The open bugs.** A new `tracker` operation `bugs` (the next contract minor version, in
  `operationSince`): input `change`, `stateDir`; result `items` in the shape of `gather`'s, every
  item of kind `bug`, open and not `excluded`; `notes`. `adf-jira` maps it to a JQL query of the
  profile's project for open issues of its bug type. `scope.mjs gather --bugs` calls it in place
  of the search and merges the result as it merges `gather`'s; the debt store is gathered as
  always. A tracker plugin declared for an older contract has no `bugs`: the quick task says so
  and asks for a key or a phrase again.
- **The merge request** opens as a Draft right after the branch and the worktree
  (`forge.mjs open`, as propose does), and leaves Draft at the end (`finalize`). Its body is
  written from `quick.md` (the goal and the summary) and the links of iteration 19; the archive's
  `mrInput` (`lib/archive.mjs:769`) reads `quick.md` for a quick change in place of
  `proposal.md` and `tasks.md`.
- **The stop rule.** When the session finds, while it plans or writes, that the fix changes
  behaviour or needs more than the plan's three steps, it stops, says why, and offers
  `/adf:propose`; the branch and the quick-task file stay for the developer to keep or remove.
- **The affected tests.** A new section of the planning guide, `## Affected tests command`, one
  command with a `{files}` placeholder (such as `npx vitest related --run {files}`), proposed by
  `/adf:init` from the project's test runner and confirmed by the developer. When the section is
  empty, the quick task proposes a command and writes it on the developer's yes, as apply does
  for the whole-suite command. A script runs it with the changed files of the branch.
- **The review.** One read-only agent over the branch's diff. It runs through `review.mjs` with
  `--change`, so its record `review.md` is assembled and committed and the archive's review gate
  (`lib/archive.mjs:350`) holds as it is; a quick change takes the branch as its range with no
  `review-range` ruling. The session fixes what it finds, in one round, and the summary names
  what was fixed and what was not.
- **The end.** After the summary: the ingest (`ingest.mjs`, when the knowledge plugin is
  enabled), the `log.md` entry, the metrics record, the move into `openspec/changes/archive/`,
  the forge's `finalize` (the merge request leaves Draft), and the worktree removed with
  `teardown` first. The archive's steps are reused; for a quick change the spec merge and the
  debt placement of review findings are recorded as skipped with the reason "quick task", since
  `runStep` refuses a step before every earlier one has settled (`lib/archive.mjs:246`). A spec scenario
  the fix shows missing goes to the debt store.
- **The metrics record.** The same `metrics.json` and schema as the main cycle
  (`contract/metrics-format.md`), written by `metrics.mjs extract` at the end and committed in
  its own commit. The record names the change's cycle in a new optional top-level key
  `cycle`, `full` or `quick`; a record without it reads as `full`. The quick task records its phases in the
  ledger (`gather`, `estimate`, `code`, `tests`, `review`, `end`), so `activeMinutes.byPhase` and
  `tokens.byPhase` split by them; `timing.tasks` counts the plan's steps in `quick.md`. Groups
  with no source in a quick task (verify, the implementer dispatches) are `null` with their
  `coverage` reason, as the format requires. `/adf:retro` reads quick records and reports them
  as a group of their own, beside the main cycle's, with the same figures (active minutes,
  turns, tokens, cost per change).
- **The success measure.** A one-file fix, from the command to the merge request, takes under
  20 minutes and a small fraction of the cost of the same fix through propose; the metrics
  record of the behaviour check (step 8) shows it.

## Non-goals

- A feature or any change to what the system must do.
- Flags or optional stages.
- Writing `openspec/specs/`.
- A quick task without a branch and a worktree.

## Depends on

- Iteration 19: the merge request description with the links of the issues and the debt taken.
- Iteration 13: `scope.mjs` gather and select, the tracker role's `start` and `handoff`, `/adf:land`.
- Iteration 09: `review.mjs` on a `--range` without the full change.
- Iteration 10 and 11: the archive's move, ingest, metrics, `finalize` and worktree removal.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Schemas by change: the core's schema renamed `full`, with `adf` read as `full`; `loadSchema` from `meta.schema` in every caller; the `quick` schema, one artifact `quick.md`, its template and its gates (a plan of at most three steps, a summary before the end) | `schema` and `changes.mjs` unit tests; the `full` schema's tests unchanged but for the name |
| 2 | `quick.mjs`: the large-item filter over `scope.mjs gather`, the estimate input, the reply check and the verdicts it records for `scope.mjs start` | unit tests on gathered fixtures |
| 2a | The `bugs` operation: contract, `scope.mjs gather --bugs`, the `adf-jira` provider | contract and `scope.spec.mjs` tests; `adf-jira` tests on a recorded reply |
| 3 | `## Affected tests command` in the planning guide, `/adf:init`'s proposal of it, and the script that runs it on the branch's changed files | unit tests |
| 4 | The review of a quick change with `--change` and the branch as its range, one fix round | `review.spec.mjs` |
| 5 | The end: the archive's steps for a quick change, the skipped ones recorded; `mrInput` from `quick.md` | `archive.spec.mjs` |
| 5a | Metrics: the record's `cycle` key, the quick phases in the ledger, `timing.tasks` from `quick.md`; `/adf:retro` reports quick changes as their own group | `metrics.spec.mjs`, `retro.spec.mjs` |
| 6 | The `/adf:quick` skill for Claude Code and Codex, with `list` and the resume | the guide's checks |
| 7 | The guide: `docs/guide/cycle/quick.md` and the cycle page | `check-guide.mjs` |
| 8 | A behaviour check: one real small fix in a scratch project, with and without a tracker, from the command to land | the run's notes and metrics in the `## Result` |
