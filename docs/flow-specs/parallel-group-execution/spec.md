# Parallel Group Execution

## Purpose

Defines how a plan's tasks are partitioned into groups that apply can run concurrently:
the execution graph authored in `plan.md`, the coupling score that decides which groups
may share a wave, the concurrency cap, the short-lived group worktrees apply creates,
and how each group's work merges back into the change branch under mandatory re-review.

The requirements below fix the boundaries that keep a fan-out from corrupting the change
branch — the graph is authored statically and never recomputed at apply time, no group
worktree survives apply, every merge is gated by a scoped re-review, and a group that
blocks isolates only its own dependents.

## Requirements

### Requirement: Execution graph is authored statically in plan.md

`writing-plans` SHALL partition a plan's tasks into groups and compute a two-tier
execution graph — wave 1 (parallel-eligible) and wave 2 (depends on one or more wave-1
groups) — written into `plan.md` as an `## Execution Graph` section, at plan-authoring
time. The section SHALL be present in every `plan.md` without exception: a plan whose
tasks do not partition MUST state that it is a single group and why, rather than omitting
the section. An omitted section is indistinguishable from a partition never attempted,
which is how a plan of 22 tasks came to run serially with nothing out of order.

No group SHALL depend on another wave-2 group; the graph MUST NOT nest beyond two
tiers. The graph MUST NOT be recomputed at apply time — apply reads the graph `plan.md`
already carries.

#### Scenario: Plan with independent groups

- **WHEN** `writing-plans` produces a plan whose tasks fall into groups with no shared
  or writer-overlapping files
- **THEN** `plan.md` contains an `## Execution Graph` section assigning those groups to
  wave 1

#### Scenario: Plan with a dependent group

- **WHEN** one group's tasks require another group's output (for example, a group that
  wires a service which a wave-1 group creates)
- **THEN** the dependent group is assigned to wave 2, and the graph names which wave-1
  group(s) it waits on

#### Scenario: Plan whose tasks do not partition

- **WHEN** every task in a plan writes files that every other task also writes, so no
  independent groups exist
- **THEN** `plan.md` still carries an `## Execution Graph` section, stating that the plan
  is one group and naming the shared files that make it one

### Requirement: Coupling score is a mechanical floor with a judgment ceiling

A coupling score of `none`, `weak`, `medium`, or `strong` SHALL be computed for every
pair of groups from the file sets in each group's tasks' `**Files:**` blocks: zero
overlap yields `none`; overlap limited to files neither group writes yields `weak` or
`medium`; any file both groups write yields `strong`. `writing-plans` MAY raise a
pair's score above this floor when it identifies coupling the file lists do not show,
but MUST NOT lower a score below the floor the file overlap establishes. When a pair is
scored `medium`, the stated reasoning for that score MUST be recorded in the Execution
Graph and MUST say whether the overlap is high or low criticality.

#### Scenario: Two groups write the same file

- **WHEN** two groups' `**Files:**` blocks both list a modification to the same file
- **THEN** their coupling score is `strong`, regardless of any judgment applied on top

#### Scenario: No file overlap but a shared contract

- **WHEN** two groups touch disjoint files but both implement one shared contract
- **THEN** `writing-plans` MAY raise their score above `none`, stating the reasoning in
  the Execution Graph

#### Scenario: Medium-coupled pair

- **WHEN** two groups share only non-authoritative reference files
- **THEN** their score is `weak` or `medium`, and if `medium`, the Execution Graph
  states whether that overlap is high or low criticality

### Requirement: Scheduling excludes strong and high-criticality medium coupling from the same wave

Two groups SHALL NOT be scheduled into the same wave when their coupling score is
`strong`, or `medium` with reasoning marking it high-criticality. Every other pairing
MAY be scheduled into the same wave, subject to the concurrency cap.

#### Scenario: Strongly coupled pair

- **WHEN** two groups are scored `strong`
- **THEN** they are not both assigned to wave 1, and neither runs concurrently with the
  other

#### Scenario: Weakly coupled pair

- **WHEN** two groups are scored `none` or `weak`, or `medium` with low-criticality
  reasoning
- **THEN** they may both be assigned to wave 1 and run concurrently, subject to the
  concurrency cap

### Requirement: Concurrency is capped at 2-3 groups

Apply SHALL run at most 2-3 groups concurrently within a wave. Groups beyond the cap
SHALL queue for the next available slot within their wave rather than launching
unconditionally.

Fan-out within the cap is mandatory, not discretionary: when the execution graph names
two or more wave-1 groups eligible to share a wave, apply MUST run them in sibling
worktrees up to the cap, and MUST NOT run them serially by default. Running them serially
is a deliberate deviation and SHALL be recorded as one, with its reason. No post-hoc
verification check is added for this, because a gate that fires after the work has already
run serially reports history rather than preventing it.

#### Scenario: Wave with more groups than the cap

- **WHEN** a wave contains more parallel-eligible groups than the concurrency cap
- **THEN** only up to the cap run at once, and the remainder start as slots free up

#### Scenario: Wave with two eligible groups

- **WHEN** the execution graph names two wave-1 groups scored `none` against each other
- **THEN** apply runs both concurrently in sibling worktrees rather than one after the other

#### Scenario: Fan-out is deliberately skipped

- **WHEN** apply runs two eligible wave-1 groups serially because the developer asked it to
- **THEN** the ledger records one deviation line naming the groups and that reason

### Requirement: Group worktrees are a scoped, apply-phase-only exception

A group's worktree SHALL be created at `.claude/worktrees/<TASK-ID>--group-<N>/`,
branched from the change branch's current HEAD, entirely within the apply phase's
group-dispatch step. It SHALL run `subagent-driven-development` over only that group's
tasks. The main change worktree (`.claude/worktrees/<TASK-ID>/`) SHALL remain the sole
worktree that persists past apply and the sole merge target for every group. A group
worktree MUST be merged and removed before apply concludes; archive MUST NOT observe
one.

#### Scenario: Group worktree created for a wave-1 group

- **WHEN** apply dispatches a wave-1 group
- **THEN** a worktree at `.claude/worktrees/<TASK-ID>--group-<N>/`, branched from the
  change branch, is created for it, distinct from the main worktree

#### Scenario: Apply concludes

- **WHEN** apply finishes all waves
- **THEN** no `.claude/worktrees/<TASK-ID>--group-*` worktree remains, and only the
  main worktree is left

### Requirement: A group merges as soon as it completes, gated by mandatory re-review

A group's branch SHALL merge into the change branch as soon as every task in the
group's ledger is `complete`. Any merge conflict SHALL be resolved by a scoped
subagent, with no restriction to non-overlapping or mechanical hunks. The merge MUST
NOT be considered complete until a mandatory scoped re-review of the merge diff passes,
checking semantic compatibility and not merely the absence of conflict markers.

#### Scenario: Clean merge

- **WHEN** a group's branch merges into the change branch with no conflicts
- **THEN** the merge still requires a scoped re-review to pass before the group is
  considered merged

#### Scenario: Merge conflict

- **WHEN** merging a group's branch produces a conflict
- **THEN** a scoped subagent resolves it, and the resolution is not considered complete
  until the scoped re-review of the merge diff passes

### Requirement: Post-merge load-bearing findings fix forward

When a merge's scoped re-review finds a load-bearing problem, apply SHALL dispatch one
fix in the change branch plus one scoped re-review of the fix, the same mechanism
`subagent-driven-development` uses for a single task's fix loop. The merge SHALL NOT be
rolled back. Escalation to human adjudication SHALL happen only at the same round-5
breaker `subagent-driven-development` already defines.

#### Scenario: Re-review finds a load-bearing problem

- **WHEN** a merge's scoped re-review reports a load-bearing finding
- **THEN** one fix dispatch and one scoped re-review run in the change branch, and the
  merge commit is not reverted

#### Scenario: Fix loop reaches the breaker

- **WHEN** a merge's fix loop reaches round 5 with the finding still open
- **THEN** the same adjudication process `subagent-driven-development` defines for a
  task's fix loop applies, at group-merge scope

### Requirement: A blocked group isolates only its dependents

A group SHALL remain `BLOCKED` when its own fix loop reaches the round-5 breaker with a
load-bearing finding: its worktree SHALL NOT be removed, its branch SHALL NOT be
merged, and other already-running or already-queued independent groups SHALL continue
unaffected. Only wave-2 groups that depend on the blocked group SHALL wait for its
resolution.

#### Scenario: One wave-1 group blocks

- **WHEN** one wave-1 group's fix loop reaches the breaker with a load-bearing finding
- **THEN** other wave-1 groups continue to completion and merge, and only wave-2 groups
  that depend on the blocked group wait

### Requirement: Verify confirms no group worktree remains

`/opsx:verify` SHALL check that `git worktree list` shows no
`.claude/worktrees/<TASK-ID>--group-*` entry. A remaining group worktree SHALL make
this check FAIL, surfacing an apply that stopped mid-fan-out before the change reaches
archive.

#### Scenario: All groups merged and cleaned up

- **WHEN** verify runs after apply completed every wave
- **THEN** `git worktree list` shows no group worktree, and the check passes

#### Scenario: Apply stopped mid-fan-out

- **WHEN** verify runs while a group worktree still exists
- **THEN** the check FAILs and names the leftover worktree
