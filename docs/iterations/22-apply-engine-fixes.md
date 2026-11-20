# Iteration 22 — Apply engine fixes

## Goal

Apply runs a change from its plan to the whole-suite record without a hand-written deviation, a
hand tick or a stuck loop, for the ten defects that usage projects reported against the apply
engine: #27, #43, #28, #29, #48, #51, #52, #53, #54 and #55.

## Intent

The retrospective window `2026-11-19-window` (dessau-nms, xnms, adf 0.18.1 to 0.21.0) found the
same kind of cost in every change it read: the engine refused a correct step, and the
orchestrator wrote a deviation or ticked by hand to go on. Each such record is noise in the
ledger and a place where a real defect can hide. The fixes keep every guard and make it tell the
case it exists for from the case it does not.

## What exists (checked 2026-11-19, at 5328c4f)

- **The tree guard** (`lib/guard.mjs`). `snapshot` records HEAD and `git status` of every checkout
  but the dispatch targets: the main checkout, each sibling worktree and each group worktree.
  `compare` fails on any difference in any of them (`guard.mjs:59-77`). It cannot tell a write by
  the round's dispatch from a commit of a concurrent session in another change's worktree, or
  from a `git pull` in the main checkout (#27, #43).
- **An unverifiable item** (`U<n>`). `ledger.mjs ruling --as fix` refuses it for a subject
  (`lib/ledger.mjs:99`); `loopState` (`lib/loop.mjs:89`) keeps it under `unverifiable` until it is
  accepted or dismissed, `openFindings` renders only `F<n>`, and the re-review schema takes only
  `F<n>` and `S<n>` in `previous` (`re-review.schema.json`). An unverifiable item the developer
  wants fixed has no path into the fix loop (#28).
- **The whole-suite wait.** The apply instruction (`schema/instructions/apply.md`, "The whole
  suite, once, at the end") says nothing about how to wait for `suite.mjs run`, whose own timeout
  is 30 minutes against the Bash tool's 10 (#29).
- **A task with no code.** A plan task whose Commit step says none is verification-only
  (`lib/plan.mjs` `commitsNothing`): an implementer runs its check and a reviewer reads the run.
  A developer bench pass has no agent to run it, so `tasks.mjs tick --plan-task` (gated on a clean
  review loop, `lib/tasks.mjs` `tickGate`) never passes. `group-merge` (`lib/groups.mjs`
  `mergeGroup`) refuses a group branch with no commit of its own ("already in ... without a merge
  commit"), so the group stays `running` or `pending` and `apply-status` never reports
  `complete` (#48).
- **The dispatch prompts** (`schema/prompts/implementer.md`, `ai-fix.md`) name no command of the
  project: the implementer guesses how to install, build, lint and test. The planning guide holds
  them under `## How to run the checks` (`host/planning.md`) (#51).
- **Sweep ids.** `sweepState` (`lib/loop.mjs`) numbers the findings `S1`, `S2` from each apply
  round's start, so round 1's `S1` and round 0's `S1` are two findings with one id in the ledger,
  the events log and the replies (#52). Rulings and consolidation records are already read from
  the round's start; the id is what still collides.
- **An updated change.** The apply preflight (`lib/preflight.mjs`) reports only the plan symbol
  check in `planFindings`. `plan.mjs lint` knows a `tasks.md` item with no plan task
  (`unplanned-item`), but the preflight does not run it, and the propose instruction says nothing
  about the plan when an artifact is revised later (#53).
- **The base check** (`lib/suite.mjs` `runSuite`). The base run already starts after the main run
  ends: both go through `runOnce`, which waits on `spawnSync`. It always runs the whole command on
  the base, also when the main run named two failing specs (#54).
- **The plan-symbols gate** (`lib/plan-symbols.mjs` `checkPlanSymbols`). At `--phase apply` it
  skips a ticked task. At `--phase propose`, the gate `changes.mjs done` and `propose.mjs commit`
  run, it checks every `Create:` against the tree, so a plan revised after a task is done must
  rewrite that task's `Create:` to `Modify:` (#55).

## Calls made by the designer, not the developer

The developer was not available. The calls below are the designer's; the first eight were taken
before the iteration began, and the rest during it.

- **#27 and #43 are one fix.** A HEAD or status move the round could not cause does not fail the
  round. `guard.mjs compare` reports it in `foreign`, with the reason, instead of `changed`:
  1. A move in a worktree that belongs to another active change: the worktree holds a change
     directory under `openspec/changes/` other than the guarded change, and its branch is the
     same branch it was at the snapshot. Its HEAD may only have moved forward (the new HEAD
     descends from the old one). (Revised below: its status may not differ, and the commits
     need proof.)
  2. A fast-forward of a protected or integration branch in the main checkout: the same branch,
     the new HEAD descends from the old one, and the status is unchanged.
  A move in a dispatch target is never watched. Any other move still fails: a branch switch, a
  rewind, a stray worktree with no change, the guarded change's own worktree, a status change in
  the main checkout. The snapshot records each watched checkout's branch and, for a worktree of
  another change, its change names; a snapshot written before this release has neither, and
  `compare` then fails on every move, as before.
- **#29: the whole-suite run is waited for in the foreground** with the Bash tool's maximum
  timeout (600000 ms); no session of the flow schedules a wakeup. Only when the project's suite is
  known to exceed 10 minutes may it run in the background, waiting on the task notification,
  never on `ScheduleWakeup`. The text goes into `apply.md`; the review stage's and verify's suite
  runs point to that rule.
- **#54: the base check runs after the main run,** never in parallel, and only for the specs that
  failed in the main run when the runner can select them; otherwise the whole base suite runs,
  after the main run.
- **#48: a verification-only task closes on a recorded evidence file** instead of an accepted
  review, and `group-merge` marks a commit-less group complete. No hand tick and no deviation.
- **#53: the apply preflight reports in `planFindings`** every `tasks.md` item no plan task
  covers; the change-update step states that `plan.md` must be revised.
- **#55: the plan-symbols gate checks `Create:` only for tasks that are not yet done.**
- **#52: sweep finding ids are unique across the rounds of a change,** prefixed with the round.
- **#51: the implementer and fix skeletons include the planning guide's check commands.**
- **#28: a `U<n>` ruled `fix` shows among the open findings of the fix prompt,** with its
  ruling, like an `F<n>`.

Decided during the iteration:

- **#27, #43, revised by the developer (2026-11-20): isolation stays.** In another active
  change's worktree an uncommitted edit is never foreign: it fails the round, as before #43. New
  commits on the same branch, the status unchanged, are foreign only with proof that the other
  change's session made them. The strongest form: every new commit is named in that change's own
  records, `.superpowers/sdd/<other>/attempts.jsonl` or `ledger.jsonl` in its worktree. An
  accepted `impl` or `fix` reply names its commits there (`result.commits[].sha`, written by
  `dispatch.mjs reply`), so an implementer's commit is proven once its reply is recorded. The
  records do not name every commit of the flow: a tick, a group merge, a plan or record commit is
  named by no record. So the fallback applies when the first form fails: the snapshot records the
  size and the time of those two files, and the commits are foreign when either changed by the
  compare. Without either proof the round fails. Known limit of the fallback: a commit our
  dispatch makes in that worktree while that change's own session writes its records in the same
  round passes as foreign. The main-checkout rule is unchanged.
- **#27, #43.** The main checkout's fast-forward is read from its HEAD reflog: every entry since
  the snapshot's HEAD says `Fast-forward` (`git pull`, `git merge --ff-only`). A commit made in the
  main checkout also moves HEAD forward, and the reflog is what tells the two apart. A branch
  switch on one commit, which the guard did not see before, is now a move, where the snapshot
  recorded the branch.
- **#28.** The ledger accepts `--as fix` for a `U<n>`; a sweep finding is still never ruled fix.
  A `U<n>` ruled fix leaves `unverifiable` and enters `open` until a re-review answers it as
  addressed; the re-review's `previous` takes a `U<n>` id. It is rendered as
  `U<n> (unverifiable): <requirement>`, the reviewer's `check` on the next line, then the
  ruling's decision.
- **#29.** The rule is one paragraph under the whole-suite command in `apply.md`; `review.md` and
  `verify.md` point to it. The frame's Tools rule (option 2 of the issue) is not changed: it binds
  dispatched agents, and the suite runs in the orchestrator's session.
- **#29, enforced by script (the developer's follow-up, 2026-11-20; a hook was dropped by the
  developer).** `suite.mjs run` writes a run marker, `.superpowers/sdd/<change>/suite/run.json`
  (`lib/suite-run.mjs`): `{ state: "running", startedAt, pid, timeoutMs, commit }` at the start,
  `{ state: "done", startedAt, endedAt, durationMs, pid, commit, exit, timedOut, status,
  outputFile }` at the end, written whole through a temporary file. It spans the whole command,
  the base check and the record included, so a waiter never reads a result before the record is
  written; the base check's own run has `base-run.json`. A run that throws still ends `done`, with
  `exit: null` and `error`. A `running` marker is stale when its pid is gone or it has outlived
  twice its timeout plus 10 minutes (the main and the base run). `suite.mjs wait --change`
  polls the marker each second and returns a done result at once; after `--max-minutes`
  (default 9) it returns `{ state: "running" }` with exit 3, and a stale or missing marker is a
  refusal, exit 1. `readAt` is written on the first read only; `idleMs` is `readAt - endedAt`.
  A result already read is returned again (`already: true`, the same `readAt`) only after 15 s
  with no new run, since a run started in the background may not have written its marker yet.
  The marker holds the last run of the change: verify's and the review's runs overwrite apply's.
  The gate is `apply-status.mjs --report` of a complete apply: it refuses unless the marker is done
  for the commit the test record ran on, and records the report's read as the first read when no
  `wait` made it. A record of no run (`not-run`) needs no marker. A change in flight whose record
  predates the marker is refused until its suite runs again. The metrics record's `tests` group
  takes an optional `suiteRun { durationMs, idleMs }` from the marker. `apply.md` keeps one short
  paragraph in the `finish` part.
- **#48.** "Verification-only" keeps its existing meaning: a plan task whose Commit step says
  none (`commitsNothing`). `tasks.mjs tick --plan-task <N> --evidence <file>` takes such a task
  past the review gate. The evidence is a non-empty file inside the change directory, such as
  `openspec/changes/<change>/windows-pass.md`; `--commit` commits it with the tick. A task whose
  Commit step does not say none is refused, and so is `--evidence` without `--plan-task`.
  `group-merge` makes an empty merge commit (`git commit-tree` of HEAD's tree, parents HEAD and the
  group tip, subject `Merge branch '<group branch>' into <change branch>`) when the group branch's reflog shows it never
  moved since it was made, so `groupState` reads the group as merged by the subject it already
  reads. The result says `empty: true`, and an empty merge needs no merge review. A group branch
  that is in the change branch by a fast-forward someone made by hand is still refused.
- **#51.** The field is `Check commands`: each non-empty line of the planning guide's
  `## How to run the checks`, HTML comments removed, or "none in the planning guide". It goes into
  the `impl` and `fix` prompts (a task's, a group's and a consolidation's) and the review stage's
  `ai-fix`. The skeletons say to run those commands as written, and to report a command they do
  not give rather than guess one.
- **#52.** Round 0 keeps `S<n>`, so the records of every change in flight stay valid; apply round
  `k` numbers its findings `R<k>-S<n>`. The ledger, the re-review schema, the re-review's sweep
  test and `dup.mjs mark` take both forms.
- **#53.** An uncovered item that is not ticked is a refusal, like a symbol finding: apply has
  nothing to schedule for it. A ticked item with no plan task (an older hand tick) is not
  reported. The finding has `kind: "unplanned-item"`, the item, and `tasks.md` with its line. The
  "update" step is propose's continuation of a change in flight: `propose.md` states that a
  revision of `tasks.md` after the plan exists revises `plan.md` in the same commit.
- **#54.** "The runner can select them" means the planning guide has an optional
  `## Failed-tests command`, one command line with `{tests}` where the failing names go, each
  quoted for the platform shell. With it, and with failing names from the main run, the base runs
  that command with those names; without either, the whole command. The base result records the
  names it selected. The issue's "a timeout under load is not a failure of the change" is met by
  the base check running alone and on fewer specs; a spec that times out on both sides is
  pre-existing, as before. Nothing else in the verdict changes.
- **#55.** A done task is one whose `tasks.md` item is ticked, at both phases. At `--phase
  propose` only its `Create:` lines are skipped; its other lines are still checked.

## Non-goals

- A guard that tells which session made a commit: git records no session id.
- Dispatching a developer bench pass; the developer runs it and the orchestrator records it.
- Unique ids across rounds for the final review's and the consolidation loop's `F<n>`: the issue
  and the call are about sweep ids.
- A `ScheduleWakeup` rule in the frame for dispatched agents.
- A change to `CHANGELOG.md` or a version: iterations 21 to 27 go out as one release.

## Depends on

- Iteration 07: apply, the tree guard, the review loops, the whole suite.
- Iteration 14: the review loop state by script, the reuse sweep and its apply rounds.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | #27, #43: `foreign` moves in `guard.mjs compare` | `apply-git.spec.mjs` |
| 2 | #28: a `U<n>` ruled fix enters the fix loop | `dispatch.spec.mjs`, `ledger.spec.mjs` |
| 3 | #29: the whole-suite wait in `apply.md`, `review.md` and `verify.md` | `changes.spec.mjs` (instruction parts), `check-guide.mjs` |
| 4 | #48: `tick --evidence`, the empty group merge | `tasks.spec.mjs`, `apply-git.spec.mjs` |
| 5 | #51: the `Check commands` field | `dispatch.spec.mjs` |
| 6 | #52: `R<k>-S<n>` sweep ids in an apply round | `consolidation.spec.mjs`, `ledger.spec.mjs` |
| 7 | #53: uncovered `tasks.md` items in `planFindings`; the propose rule | `preflight.spec.mjs` |
| 8 | #54: the base check on the failed tests | `suite.spec.mjs` |
| 9 | #55: `Create:` of a done task at `--phase propose` | `plan-symbols.spec.mjs` |
| 10 | The guide pages of every changed source | `check-guide.mjs` |

## Result

One commit per issue on `feat/22-apply-engine-fixes`, each test written first and seen failing,
each commit gated on the full `npm test`.

- **#27, #43** (`lib/guard.mjs`). `snapshot` records each watched checkout's branch, the main
  checkout as `main`, and the change directories of another change's worktree. `compare` puts a
  forward move on the same branch in such a worktree, and a reflog-proven fast-forward of a
  protected branch in the main checkout, into `foreign` with its `reason`; `ok` stays true. A
  commit in the main checkout, a commit in a worktree of no change and a branch switch still
  fail. `apply.md` and the guide's apply page say so. Test: `apply-git.spec.mjs`, "the guard
  reports a commit in another change's worktree and a fast-forward of the main checkout as
  foreign".
- **#28** (`lib/ledger.mjs`, `lib/loop.mjs`, `re-review.schema.json`). A `U<n>` may be ruled
  `fix`; it leaves `unverifiable`, enters `open`, renders as `U<n> (unverifiable): …`, `Check: …`,
  `Ruled fix: …`, and the re-review answers it by its id. Tests: `dispatch.spec.mjs`, "an
  unverifiable item ruled fix shows among the open findings, and the re-review settles it";
  `ledger.spec.mjs`.
- **#29** (`apply.md`, `review.md`, `verify.md`). The whole-suite run is waited for in the
  foreground with the 600000 ms timeout; the background only for a suite known to exceed 10
  minutes, on its task notification; never a scheduled wakeup. No test asserts that text; the
  instruction-part size test (`changes.spec.mjs`) and `check-guide.mjs` pass.
- **#48** (`tasks.mjs`, `lib/tasks.mjs`, `lib/groups.mjs`, `workspace.mjs`). `tick --plan-task <N>
  --evidence <file>` ticks a task whose Commit step says none on a non-empty file in the change
  directory and commits it with the tick. `group-merge` merges a group branch that never moved as
  an empty merge commit, `empty: true`, with no review package. The `apply.md` paragraph sits in
  the `groups` part: the `dispatch` part is held under 16 KB by `changes.spec.mjs`. Tests:
  `tasks.spec.mjs`, "a verification-only task closes on a recorded evidence file, committed with
  its tick"; `apply-git.spec.mjs`, "a group with no commit of its own merges as an empty merge
  commit and counts as merged".
- **#51** (`dispatch.mjs`, `lib/guide.mjs`, `implementer.md`, `ai-fix.md`, `host/planning.md`).
  The `impl`, `fix` and `ai-fix` prompts carry `Check commands`, the lines of the guide's
  `## How to run the checks`. Tests: `dispatch.spec.mjs`, "the implementer and fix prompts carry
  the planning guide's check commands", and the fixer prompt test.
- **#52** (`lib/loop.mjs`, `lib/ledger.mjs`, `lib/reply.mjs`, `re-review.schema.json`). Apply
  round `k` numbers its sweep findings `R<k>-S<n>`; the ledger, the re-review and its
  `notConsolidated` take them. The lessons row of the apply-round sweep names the renamed test.
  Tests: `consolidation.spec.mjs`, "an apply round sweeps its own diff: findings and
  consolidation rounds count from the round, ids carry it"; `ledger.spec.mjs`.
- **#53** (`lib/preflight.mjs`, `propose.md`). The apply preflight adds an `unplanned-item`
  finding to `planFindings` for each open `tasks.md` item no plan task names, and refuses. The
  propose instruction states that a revision after the plan revises `plan.md`. Test:
  `preflight.spec.mjs`, "apply refuses a tasks.md item no plan task covers, naming it in
  planFindings".
- **#54** (`lib/suite.mjs`, `host/planning.md`). The base run was already sequential; with the
  guide's `## Failed-tests command` it runs only the main run's failing tests, recorded in
  `base.selected` and in the test record. Test: `suite.spec.mjs`, "the base check runs the failed
  tests alone when the guide gives a failed-tests command".
- **#55** (`lib/plan-symbols.mjs`). At `--phase propose` a ticked task's `Create:` lines are not
  checked; its other lines are. Test: `plan-symbols.spec.mjs`, "propose checks no Create of a
  done task; its other lines and an open task's Create are checked".

Checks: `npm test` before the iteration, 1834 tests, 1829 pass, 5 skipped, 0 fail; after it, 1842
tests, 1837 pass, 5 skipped, 0 fail, with `check-lessons.mjs`, `check-release.mjs` and
`check-guide.mjs` green. Nothing was run in a scratch project, and `guide-review.mjs` is left to
the release step of v0.22.0.

Left open: none of the ten issues. The design commit was made before the suite ran on it; it
holds this record alone, and the next commit's run covers it.
