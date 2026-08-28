# Flow Retrospective

## Purpose

Defines the `adf-retro` skill: a standalone, manually invoked analysis of how a past Claude
Code session executed the opsx change workflow, judged on token economy and total task time
rather than on code correctness.

The requirements below fix what contributors and agents depend on — that it never runs
itself as part of the opsx cycle, how it locates the session it was asked about, what its
report is and is not about, and why it re-reads the workflow definition on every run instead
of trusting its own reference material.

## Requirements

### Requirement: Flow retrospective is invoked manually, by change or by session

The `adf-retro` skill MUST only run when explicitly invoked by the developer and MUST NOT
be triggered automatically by `/opsx:propose`, `/opsx:apply`, `/opsx:verify`,
`/opsx:archive`, or any other command. Invocation MUST accept either a change name, from
which the skill reads the change's session list, or a single Claude Code session ID. The
skill SHALL be named `adf-retro`; the name `flow-retro` MUST NOT resolve to it, because the
flow is called ADF in every other artifact naming it and one skill answering to a second
name is the condition this rename removes.

#### Scenario: Developer invokes adf-retro with a change name

- **WHEN** the developer invokes `adf-retro` with a change name and no other command in the
  opsx cycle has called it
- **THEN** the skill reads that change's session list and runs its analysis across every
  session named there

#### Scenario: Developer invokes adf-retro with a session ID

- **WHEN** the developer invokes `adf-retro` with a single session ID
- **THEN** the skill runs its analysis for that session alone, as it did before the change
  became the unit of analysis

#### Scenario: No automatic invocation from the opsx cycle

- **WHEN** `/opsx:archive` completes a change
- **THEN** `adf-retro` is not invoked as part of that completion

### Requirement: Flow retrospective locates the session transcript from its ID

Given a session ID, `adf-retro` MUST locate that session's transcript at
`~/.claude/projects/<project-key>/<session-id>.jsonl`, where `<project-key>` is the
repository's absolute path with every `/` replaced by `-`, which leaves a leading `-` because
the path begins with one. An implementation MAY also try the leading-dash-stripped form as a
fallback, and a session whose transcript resolves under either form counts as resolved. Given
a change name, it MUST resolve every session id in that change's ledger `## Sessions` list, or
in the preserved `ledger.md` when the change is already archived, and locate each transcript
the same way. If a transcript cannot be found under either form, the skill MUST report that
session as unresolved rather than dropping it, and MUST NOT fabricate an analysis or silently
average over the sessions that remain.

#### Scenario: Transcript exists

- **WHEN** `adf-retro` is given a session ID whose transcript file exists under the
  derived project directory
- **THEN** it reads that transcript as the basis for its analysis

#### Scenario: Transcript does not exist

- **WHEN** `adf-retro` is given a session ID with no matching `.jsonl` file under any
  known project directory
- **THEN** it reports that the session was not found and produces no report

#### Scenario: One session of several cannot be resolved

- **WHEN** a change's session list names three sessions and one transcript is absent from
  this machine
- **THEN** the report covers the two it resolved and names the third as unresolved, rather
  than presenting the two as the whole

### Requirement: Flow retrospective reports on token economy and task time

The report `adf-retro` produces MUST focus on token economy and total task time for the
analyzed change or session — not code correctness or quality, which `requesting-code-review`
and `/opsx:verify` already cover. It MUST identify, where present: issues caught later in the
pipeline than they could have been, a subagent re-deriving context an earlier stage already
had, and premature "done" signaling followed by further fix commits.

The report MUST contain a token economy table broken down by actor, a velocity table, and it
MUST be accompanied by a companion improvements file naming what to change, in which file,
and the expected effect, ordered by expected saving. It MUST be written to
`.claude-reports/adf-retro/<change-name-or-session-id>.md`, with the improvements file
alongside it. The prohibition on fabricating findings extends to improvements: a session with
nothing worth changing MUST get an improvements file saying so, not an invented list.

#### Scenario: Session shows a late-caught issue

- **WHEN** the analyzed session's git history shows a commit marking a change complete,
  followed by additional fix commits before the change reached a passing `/opsx:verify`
- **THEN** the report names the round trip, what was fixed, and where in the pipeline it
  could have been caught instead

#### Scenario: Session shows no efficiency issues

- **WHEN** the analyzed session's pipeline stages each caught what they could catch, with
  no late-stage rework
- **THEN** the report states this plainly rather than inventing a finding, and the
  improvements file states that no change is warranted

#### Scenario: Report location

- **WHEN** `adf-retro` finishes analyzing a change or session
- **THEN** the report file exists under `.claude-reports/adf-retro/`, with its companion
  improvements file beside it

#### Scenario: Cost is attributed by actor

- **WHEN** the report presents the analyzed session's token economy
- **THEN** the table attributes output tokens and context reads to each actor separately,
  so an orchestrator spending more than the agents it dispatches is visible as such

### Requirement: Flow retrospective re-derives current workflow shape from source

`adf-retro` MUST re-read `openspec/schemas/sdd-plus-superpowers/schema.yaml` and the
`.claude/commands/opsx/*.md` command files on every invocation to determine the current
shape of the opsx workflow's checks and instructions, rather than relying solely on a
cached or hard-coded description of them. Only the workflow's stable structure (the five
commands, the eight artifacts, the branch/worktree model) MAY be written as static
reference material in the skill.

#### Scenario: A verify check was added since the skill was last updated

- **WHEN** `schema.yaml`'s `verify:` instruction has gained a numbered check that
  `adf-retro`'s static reference material does not mention
- **THEN** the skill's analysis reflects the current check count and content, because it
  re-read `schema.yaml` for this invocation rather than trusting stale reference material

### Requirement: The ledger is a second input alongside the transcript

`adf-retro` MUST read the change's execution ledger in addition to the session transcripts, and MUST use its deviation and debt lines as evidence the transcript cannot supply. Where a number appears in both, the transcript SHALL be treated as the fact and the disagreement SHALL be reported rather than resolved silently.

#### Scenario: The ledger records a deviation

- **WHEN** the ledger records that two eligible wave-1 groups were run serially, with a reason
- **THEN** the report names that deviation and its reason rather than inferring intent from the worktree history

#### Scenario: The ledger and the transcript disagree

- **WHEN** the ledger's turn count for a dispatch differs from the transcript's
- **THEN** the report uses the transcript's number and states that the ledger disagreed

### Requirement: Every number comes from a deterministic extractor, not from an agent

The numbers in a retrospective MUST come from `.claude/scripts/adf-metrics.mjs`, which computes them from the ledger's session list, the resolved transcripts, `git` and `openspec/` without an agent in the loop. `adf-retro` SHALL interpret those numbers rather than re-deriving them by reading transcripts itself, because a script cannot fabricate a figure and cannot inflate the context it is measuring.

#### Scenario: The skill reports token economy

- **WHEN** `adf-retro` presents a token economy table
- **THEN** the figures in it are the extractor's output, not counts the skill produced by reading the transcript in its own context

#### Scenario: The extractor has not been run for a change

- **WHEN** `adf-retro` is invoked for a change with no metrics output
- **THEN** it runs the extractor first rather than substituting its own estimates

### Requirement: Metrics are produced automatically at archive

`/opsx:archive` MUST run `.claude/scripts/adf-metrics.mjs` for the change being archived, writing the token economy, velocity, fourth-axis and rule-compliance tables to `.claude-reports/adf-retro/`. This run SHALL NOT invoke `adf-retro` or any other agent: it is a script run, and the prohibition on automatic retrospective invocation is unchanged. The numbers accumulate whether or not a retrospective is ever run, because five iterations of this flow produced exactly one measurement and that one was unrequested.

#### Scenario: A change is archived

- **WHEN** `/opsx:archive` completes for a change
- **THEN** the metrics output for that change exists under `.claude-reports/adf-retro/`, and no retrospective agent was dispatched

#### Scenario: A session transcript is missing at archive

- **WHEN** the extractor cannot resolve one of the change's sessions
- **THEN** it names that session as unresolved in its output rather than omitting it from the tables without comment

### Requirement: Metrics report whether the flow's own rules were followed

The metrics output MUST contain a rule-compliance table comparing what the flow's rules required against what the change actually did — at minimum, the wave-1 groups the execution graph named against the group worktrees `git` shows were created. A rule that was mandatory and was not followed SHALL appear as a number in that table.

#### Scenario: A mandatory fan-out did not happen

- **WHEN** a change's `plan.md` names two eligible wave-1 groups and `git` shows no group worktrees were created
- **THEN** the compliance table reports the fan-out as required and not performed

#### Scenario: Rules were followed

- **WHEN** every mandatory rule the table covers was followed
- **THEN** the table states that, so a compliant change is distinguishable from an unmeasured one

### Requirement: Metrics report whether the code is getting harder to change

The metrics output MUST report three maintainability indicators, all computed from `git` and `openspec/` without an agent and without a session id: insertions against deletions per change, per-file churn across archived changes, and capability count against how often existing capabilities are edited. This axis exists because the declared model tier and the rule-removal pressure are both cost wins purchasable with maintainability, invisibly, and what is measured is what gets optimised.

#### Scenario: A change only adds

- **WHEN** a change's diff carries insertions and almost no deletions
- **THEN** the ratio appears in the output, so a flow that only accumulates is visible as such

#### Scenario: A file is edited by every change

- **WHEN** one file appears in the diff of most archived changes
- **THEN** the per-file churn table names it as a hotspot

### Requirement: The retrospective has stated invocation triggers

`adf-retro`'s triggers SHALL be stated rather than left to memory: every third to fifth archived change, because fewer points cannot separate a trend from noise, and immediately after a change that hurt — a task group left `BLOCKED`, a review that reached the three-round cap, a compaction inside apply, or a defect found by hardware or by the developer rather than by the pipeline. Stating the triggers does not make invocation automatic; the skill stays manually invoked.

#### Scenario: A change reached the review round cap

- **WHEN** a change's review stage recorded BLOCKED after three rounds
- **THEN** that change meets a stated trigger for a retrospective

#### Scenario: Four changes archived without one

- **WHEN** four changes have been archived since the last retrospective
- **THEN** the interval trigger is met

### Requirement: Archive states how long it has been since the last retrospective

`/opsx:archive` MUST print one line naming how many changes have been archived since the last retrospective. That line SHALL be a reminder only and MUST NOT invoke the skill, because the ordinary way a manually invoked instrument dies is being forgotten, and the ordinary way an automatic one distorts its subject is by measuring it from inside.

#### Scenario: Three changes since the last retrospective

- **WHEN** `/opsx:archive` completes and three changes have been archived since the last retrospective report
- **THEN** it prints that count and does not run the skill

#### Scenario: A retrospective was just run

- **WHEN** the change being archived is the one a retrospective was just run for
- **THEN** the line states that, rather than being omitted
