# Flow Retrospective

## Purpose

Defines the `flow-retro` skill: a standalone, manually invoked analysis of how a past Claude
Code session executed the opsx change workflow, judged on token economy and total task time
rather than on code correctness.

The requirements below fix what contributors and agents depend on — that it never runs
itself as part of the opsx cycle, how it locates the session it was asked about, what its
report is and is not about, and why it re-reads the workflow definition on every run instead
of trusting its own reference material.

## Requirements

### Requirement: Flow retrospective is invoked manually by session ID

The `flow-retro` skill MUST only run when explicitly invoked by the developer and MUST NOT
be triggered automatically by `/opsx:propose`, `/opsx:apply`, `/opsx:verify`,
`/opsx:archive`, or any other command. Invocation MUST require a Claude Code session ID as
input, and MAY accept an optional change name.

#### Scenario: Developer invokes flow-retro with a session ID

- **WHEN** the developer invokes `flow-retro` with a session ID and no other command in the
  opsx cycle has called it
- **THEN** the skill runs its analysis for that session

#### Scenario: No automatic invocation from the opsx cycle

- **WHEN** `/opsx:archive` completes a change
- **THEN** `flow-retro` is not invoked as part of that completion

### Requirement: Flow retrospective locates the session transcript from its ID

Given a session ID, `flow-retro` MUST locate that session's transcript at
`~/.claude/projects/<project-key>/<session-id>.jsonl`, where `<project-key>` is derived from
the repository's absolute path by replacing `/` with `-` and stripping the leading `-`. If
no matching transcript file exists, the skill MUST report that the session could not be
found and MUST NOT fabricate an analysis.

#### Scenario: Transcript exists

- **WHEN** `flow-retro` is given a session ID whose transcript file exists under the
  derived project directory
- **THEN** it reads that transcript as the basis for its analysis

#### Scenario: Transcript does not exist

- **WHEN** `flow-retro` is given a session ID with no matching `.jsonl` file under any
  known project directory
- **THEN** it reports that the session was not found and produces no report

### Requirement: Flow retrospective reports on token economy and task time

The report `flow-retro` produces MUST focus on token economy and total task time for the
analyzed session — not code correctness or quality, which `requesting-code-review` and
`/opsx:verify` already cover. It MUST identify, where present: issues caught later in the
pipeline than they could have been, a subagent re-deriving context an earlier stage already
had, and premature "done" signaling followed by further fix commits. It MUST be written to
`.claude-reports/flow-retro/<session-id>.md`.

#### Scenario: Session shows a late-caught issue

- **WHEN** the analyzed session's git history shows a commit marking a change complete,
  followed by additional fix commits before the change reached a passing `/opsx:verify`
- **THEN** the report names the round trip, what was fixed, and where in the pipeline it
  could have been caught instead

#### Scenario: Session shows no efficiency issues

- **WHEN** the analyzed session's pipeline stages each caught what they could catch, with
  no late-stage rework
- **THEN** the report states this plainly rather than inventing a finding

#### Scenario: Report location

- **WHEN** `flow-retro` finishes analyzing a session
- **THEN** the report file exists at `.claude-reports/flow-retro/<session-id>.md`

### Requirement: Flow retrospective re-derives current workflow shape from source

`flow-retro` MUST re-read `openspec/schemas/sdd-plus-superpowers/schema.yaml` and the
`.claude/commands/opsx/*.md` command files on every invocation to determine the current
shape of the opsx workflow's checks and instructions, rather than relying solely on a
cached or hard-coded description of them. Only the workflow's stable structure (the five
commands, the eight artifacts, the branch/worktree model) MAY be written as static
reference material in the skill.

#### Scenario: A verify check was added since the skill was last updated

- **WHEN** `schema.yaml`'s `verify:` instruction has gained a numbered check that
  `flow-retro`'s static reference material does not mention
- **THEN** the skill's analysis reflects the current check count and content, because it
  re-read `schema.yaml` for this invocation rather than trusting stale reference material
