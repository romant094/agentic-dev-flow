# Apply Execution Ledger

## Purpose

Defines the record the apply phase keeps of its own execution: where the ledger lives,
what it writes for every dispatch it issues, how a deliberate departure from a rule this
flow states is logged with its reason, the code compromises accepted along the way, the
sessions that worked on the change, and the handoff block a pause writes so a fresh
session can resume from the ledger alone.

The requirements below fix the boundaries that keep the ledger honest and keep it from
becoming a second transcript — it is named after the change rather than after a plan
file's basename, it records one line per dispatch and never the dispatch's output, and it
ranks below the session transcript wherever the two disagree. Its unique contribution is
the deviation and debt lines, which no transcript can yield, because a rule departed from
and a rule correctly judged inapplicable look identical from outside.

## Requirements

### Requirement: The ledger is named after the change before the first dispatch

`/opsx:apply` SHALL resolve and state the ledger path `.superpowers/sdd/<change-name>/progress.md` before invoking `superpowers:subagent-driven-development`, and SHALL NOT use a path whose final directory is derived from the plan file's basename. A basename-derived workspace collides between changes whose plan files share a name, which has been recorded three times; naming the workspace after the change makes the collision impossible rather than unlikely.

#### Scenario: Apply names the ledger before dispatching

- **WHEN** `/opsx:apply` reaches the implementation step for a change named `adf-flow-improvements`
- **THEN** it states the ledger path `.superpowers/sdd/adf-flow-improvements/progress.md` before the first subagent is dispatched

#### Scenario: A basename-derived workspace path is refused

- **WHEN** an implementation workspace would be created at `.superpowers/sdd/plan/`
- **THEN** apply uses the change-named path instead, because `plan` is a basename shared by every change's plan file

### Requirement: The ledger records one line per dispatch

The ledger MUST carry a `## Dispatches` section in which the orchestrator records, for every dispatch it issues: the task id, the role dispatched (implementer, reviewer, read-only investigator), the capability level declared for it, and the turn count the dispatch returned after. No other per-dispatch detail is required, and the dispatch's own output MUST NOT be copied into the ledger.

#### Scenario: An implementer returns

- **WHEN** an implementer dispatched for task 3.4 returns after 41 turns
- **THEN** the ledger's `## Dispatches` section gains one line naming task 3.4, the implementer role, its declared level, and 41 turns

#### Scenario: A dispatch's output is not copied

- **WHEN** a read-only investigator returns a verdict
- **THEN** the ledger records the dispatch line only, and the verdict text is not pasted into the ledger

### Requirement: The ledger records deliberate deviations from flow rules

The orchestrator MUST write one line to the ledger's `## Deviations` section for every deliberate departure from a rule this flow states — a wave named in the execution graph that was not fanned out, a task that met the split rule and was not split, a question that needed more than one file opened and was answered without delegation — together with the reason. A rule correctly judged inapplicable is not a deviation and MUST NOT be recorded as one.

#### Scenario: A wave-1 group is not fanned out

- **WHEN** the execution graph names two wave-1 groups and apply runs them serially
- **THEN** the ledger's `## Deviations` section carries one line naming the groups and the reason they were not fanned out

#### Scenario: A rule does not apply

- **WHEN** a plan has one task group, so no fan-out is possible
- **THEN** no deviation line is written, because the rule was not departed from

### Requirement: The transcript outranks the ledger where they disagree

The session transcript SHALL be the primary source for any measurement the ledger also carries, and any analysis reading both MUST report the disagreement rather than silently preferring either. The ledger is the measured party's own account of itself; its unique contribution is the deviation and debt lines, which the transcript cannot yield because a rule departed from and a rule correctly judged inapplicable are indistinguishable from outside.

#### Scenario: Turn counts disagree

- **WHEN** the ledger records 41 turns for a dispatch and the transcript shows 63
- **THEN** the analysis uses 63 and states that the ledger disagreed

#### Scenario: A deviation has no transcript equivalent

- **WHEN** the ledger records that a task meeting the split rule was deliberately not split
- **THEN** that line is used as-is, because no transcript evidence distinguishes it from a task the rule did not reach

### Requirement: The ledger carries the change's session list

The ledger MUST carry a `## Sessions` section with one line per Claude Code session that worked on the change, recording that session's id taken from the `CLAUDE_CODE_SESSION_ID` environment variable, the window it covered, and which phase of the cycle it ran. A session that resumes work on a change MUST append its own line rather than replacing the list.

#### Scenario: A second session resumes a change

- **WHEN** a new session runs `/opsx:apply` on a change whose ledger already carries one session line
- **THEN** the ledger's `## Sessions` section carries two lines, the earlier one unchanged

#### Scenario: The session id is read from the environment

- **WHEN** a session writes its `## Sessions` line
- **THEN** the id recorded is the value of `CLAUDE_CODE_SESSION_ID`, not a value inferred from a transcript filename

### Requirement: The ledger carries code-debt lines with their reasons

The ledger MUST carry a `## Debt` section taking one line per code compromise accepted during implementation — a stub taken, a duplication accepted, a refactor deferred — each stating what was compromised and why. These lines share the ledger with the flow-rule deviations and MUST NOT be written to a separate file.

#### Scenario: An implementer accepts a duplication

- **WHEN** an implementer duplicates a helper rather than extracting it, because extraction reaches files outside its task's `**Files:**` block
- **THEN** the ledger's `## Debt` section gains one line naming the duplication and that reason

#### Scenario: No compromise was taken

- **WHEN** a change's implementation took no stub, duplication or deferred refactor
- **THEN** the `## Debt` section is present and empty, rather than absent

### Requirement: A handoff pause writes a resumable block at a group boundary

When apply pauses for a fresh session, it MUST finish the current task group first, and MUST write a `## Handoff` block to the ledger naming what merged, what remains, what is blocked, the next dispatch, and every open deviation. Apply MUST NOT pause mid-group or mid-dispatch. A session resuming from that block MUST be able to continue from the ledger, `tasks.md` and `git log` alone, without the previous session's transcript.

#### Scenario: The threshold is reached mid-group

- **WHEN** the handoff threshold is reached while a task group is still executing
- **THEN** apply completes that group, then writes the handoff block and stops

#### Scenario: A resumed session reconstructs state

- **WHEN** a fresh session is given only the ledger, `tasks.md` and `git log` for a paused change
- **THEN** it determines what merged, what remains, what is blocked and what to dispatch next without reading the prior transcript

### Requirement: The pause threshold uses observable proxies rather than a token count

The handoff threshold MUST be expressed in signals the orchestrator can observe directly — a group boundary reached with a stated number of groups already merged in the session, a harness compaction signal, or a dispatch returning after an anomalous turn count — and MUST NOT be expressed as a context-size number the orchestrator measures about itself. An agent cannot reliably read its own context size at the moment the decision is made, which is the same reason the task-split bound is structural.

#### Scenario: A harness compaction signal arrives

- **WHEN** the harness signals compaction between two task groups
- **THEN** the threshold is treated as reached and the handoff block is written

#### Scenario: A context-size estimate is not a trigger

- **WHEN** the orchestrator has no observable proxy and only an estimate of its own context size
- **THEN** the threshold is not treated as reached on that estimate alone

### Requirement: Archiving preserves the ledger's durable half into the change

`/opsx:archive` MUST write `openspec/changes/<change-name>/ledger.md` carrying the ledger's `## Sessions` list and every unresolved `## Debt` line, and MUST do so before removing the change's worktree, so the file travels into `openspec/changes/archive/<date>-<change-name>/`. Per-dispatch and deviation lines MUST NOT be preserved: they are working notes reduced to tables by the metrics extractor while the worktree still exists. `ledger.md` is not a schema artifact — it SHALL have no artifact id, no row in the workflow documentation's artifact table, and no effect on the artifact count.

#### Scenario: A change is archived

- **WHEN** `/opsx:archive` completes for a change whose ledger carries two sessions and one unresolved debt line
- **THEN** `openspec/changes/archive/<date>-<change-name>/ledger.md` exists carrying both session lines and that debt line, and no per-dispatch lines

#### Scenario: The artifact count is unaffected

- **WHEN** the workflow shape check derives the artifact count from the vendored schema
- **THEN** `ledger.md` does not appear among the artifacts, because it has no artifact id

### Requirement: Archiving resolves every remaining debt line

`/opsx:archive` MUST turn each unresolved `## Debt` line into either a page in `.claude/memory/` or a task in a follow-up change, and MUST NOT close a change leaving a debt line addressed only by a commit message. A line the developer decides to accept permanently is recorded as accepted, with that decision stated.

#### Scenario: A deferred refactor is still open at archive

- **WHEN** archiving a change whose ledger records a deferred refactor
- **THEN** the refactor becomes a memory page or a follow-up task before the change is archived

#### Scenario: A compromise is accepted permanently

- **WHEN** the developer decides a recorded duplication is acceptable and will not be revisited
- **THEN** the line is recorded as accepted with that decision stated, rather than silently dropped
