# Change Workflow Schema

## Purpose

Defines the workflow every change in this repository follows: the vendored
`sdd-plus-superpowers` schema, its eight artifacts, and the command surface built on top of
it.

The requirements below fix the parts contributors and agents depend on — which artifact
precedes which, what belongs in `tasks.md` versus `plan.md`, which command is the single
entry point, who may write `openspec/specs/`, and the guards that keep the adapted command
surface from being regenerated back to stock.

## Requirements

### Requirement: Vendored workflow schema

The repository SHALL contain the `sdd-plus-superpowers` schema under
`openspec/schemas/sdd-plus-superpowers/`, and `openspec/config.yaml` SHALL name it as the
project default. The schema MUST validate against the installed OpenSpec CLI without
modification to that CLI, and MUST NOT require any network access or third-party
repository at runtime.

#### Scenario: Schema resolves for a new change

- **WHEN** a change is created with no explicit schema pin
- **THEN** `openspec status --change <name> --json` reports
  `"schemaName": "sdd-plus-superpowers"` and an artifact graph of `brainstorm`,
  `proposal`, `design`, `specs`, `tasks`, `plan`, `verify`, `review`

#### Scenario: Schema validates on a stock CLI

- **WHEN** `openspec schema validate sdd-plus-superpowers` runs against the CLI version
  pinned by the repository
- **THEN** it exits successfully with no errors

### Requirement: Apply is blocked until the plan exists

The schema SHALL declare `plan` as a prerequisite of `apply`, so that implementation
cannot begin from `tasks.md` alone.

#### Scenario: Apply requested without a plan

- **WHEN** `/opsx:apply` runs on a change whose `plan.md` does not exist
- **THEN** the command reports the missing artifact and stops without editing any
  source file

### Requirement: Apply confirms the implementation workspace is scoped to the change

`/opsx:apply` SHALL run a check confirming the subagent-driven implementation workspace is
named for the change being applied, and that the legacy shared path holds no ledger belonging
to another plan.

The workspace path is derived from the plan file's basename by the vendored helper, and every
change's plan is `plan.md`, so every change resolves to one shared directory. A controller
that reads a previous change's ledger as its own progress skips completed work; this has
recurred three times. The rule that prevents it — a workspace named for the change, and
explicit output paths passed to the helper scripts — is already recorded, and a rule enforced
by recall is enforced only when recalled.

#### Scenario: A foreign ledger sits on the shared path

- **WHEN** apply starts and the legacy shared workspace holds a ledger naming a different plan
- **THEN** the check reports which change it belongs to and stops before any task is
  dispatched

#### Scenario: The workspace is scoped to this change

- **WHEN** apply starts and the change's own workspace is in use
- **THEN** the check passes silently

### Requirement: English-only artifact templates

Every template under `openspec/schemas/sdd-plus-superpowers/templates/` SHALL be written
entirely in English, as SHALL the schema's own `instruction:` and `description:` fields.
No template comment or instruction may contain non-English prose, because template text is
copied verbatim into generated artifacts.

#### Scenario: Generated artifact contains only English

- **WHEN** any artifact is scaffolded from a schema template
- **THEN** the resulting file contains no non-English prose

### Requirement: No references to unavailable skills

The schema SHALL reference only skills this project can resolve: Superpowers skills from
`claude-plugins-official` and OpenSpec built-in workflows. References to
`openspec-continue-change` and `workflow-retrospective` MUST NOT appear.

#### Scenario: Every named skill resolves

- **WHEN** the schema's instruction text is searched for skill names
- **THEN** each name is either a Superpowers skill present in the installed plugin or an
  OpenSpec built-in workflow shipped with the CLI

### Requirement: Retrospective replaced by a memory ingest

`/opsx:archive` SHALL instruct an ingest into `.claude/memory/` under the convention in
`.claude/CLAUDE.md` §4, and no artifact or instruction SHALL direct the writing of a
`retrospective.md`. The instruction lives in the command rather than in the schema: the
schema format has no archive stage — its stages are the artifacts plus `apply` — so a
requirement placed there would have no home, and inventing one would pass schema validation
while instructing nobody.

#### Scenario: Archive completes

- **WHEN** `/opsx:archive` finishes for a change
- **THEN** the knowledge gained is recorded in `.claude/memory/` and no
  `retrospective.md` is produced

### Requirement: Task and plan granularity are separated by axis

`tasks.md` SHALL state *what* is delivered and in what order — one item per
independently reviewable deliverable, in domain terms, ordered shared → server → client,
carrying no file paths and no test commands. `plan.md` SHALL state *how* each item is
executed — one `### Task N` per `tasks.md` item, each carrying an explicit back-reference
to the item it implements, plus files, interfaces, and RED→GREEN→REFACTOR→commit steps.
`plan.md` MUST NOT introduce a deliverable that is absent from `tasks.md`.

#### Scenario: Plan item without a back-reference

- **WHEN** a reviewer reads a `### Task N` heading in `plan.md`
- **THEN** the task names the `tasks.md` item it implements (for example
  `Task 12 → tasks 3.4`)

#### Scenario: File path in tasks.md

- **WHEN** `tasks.md` is reviewed
- **THEN** it contains no source file paths — those live in `plan.md`

### Requirement: Single command entry point

`/opsx:propose` SHALL be the single entry point for starting a change, and the workflow
SHALL expose a `/opsx:verify` command that writes `verify.md` itself and a `/opsx:review`
command that writes `review.md` itself. A separate `/opsx:explore` command MUST NOT exist,
because the schema's `brainstorm` artifact covers that stage.

`/opsx:review` runs between `/opsx:verify` and `/opsx:archive`. Its artifact requires
`verify`, so a change cannot be reviewed before it has been verified, and `/opsx:archive`
reads what it writes.

#### Scenario: Contributor starts a new change

- **WHEN** a contributor begins a new feature
- **THEN** `/opsx:propose` is the command they run, and it produces `brainstorm.md`
  before `proposal.md`

#### Scenario: Verify command is available

- **WHEN** a change's implementation is complete
- **THEN** `/opsx:verify` runs and produces `verify.md`

#### Scenario: Review command is available

- **WHEN** a change has been verified
- **THEN** `/opsx:review` runs and produces `review.md`, and `/opsx:verify` names it as the
  next step

### Requirement: The generated command surface is guarded against regeneration

`openspec update` SHALL be prohibited: it MUST be denied in `.claude/settings.json`, and
the prohibition MUST also be stated in `openspec/config.yaml` and `.claude/CLAUDE.md`,
neither of which the command rewrites. It regenerates `.claude/commands/opsx/` and
`.claude/skills/openspec-*/` from the CLI's own templates, discarding every project
adaptation in them — measured at 140 deleted lines, which is the whole availability gate,
the branch model, the worktree lifecycle and the provisioning decision, plus the
reinstatement of the deleted `/opsx:explore`. The CLI itself is a prerequisite and MUST NOT
be removed — every other subcommand the workflow depends on ships in the same binary.

Because a regenerated command file no longer contains the pre-flight that would detect the
loss, the integrity check MUST NOT live only inside the commands it protects. The schema's
`apply` instruction SHALL invoke a command-integrity check, and that check SHALL report
every adaptation marker it cannot find and stop the workflow. Restoring the files is the
developer's action, not the workflow's.

An adaptation marker SHALL be a string that is present in the adapted command file and
absent from the stock template the CLI would write in its place. A marker the regenerated
file also contains reports the adaptation present after it is gone, which is worse than no
marker at all, and the check SHALL NOT rely on one. Every adapted command file SHALL carry
markers, the read-only sync preview included — a regeneration that restores a command
which writes the main specs outside archive is exactly what this check exists to catch.

#### Scenario: An agent attempts the prohibited command

- **WHEN** an agent tries to run `openspec update` in any form
- **THEN** the deny rule blocks it before it executes

#### Scenario: Someone runs the prohibited command

- **WHEN** `openspec update` has rewritten the command files and `/opsx:apply` is run
- **THEN** the integrity check names the missing adaptations and stops before any source
  file is modified

#### Scenario: Command surface intact

- **WHEN** the command files still carry every adaptation marker
- **THEN** the integrity check passes silently

### Requirement: Every adapted command file is covered by the integrity check

The command-integrity check SHALL carry adaptation markers for every file under
`.claude/commands/opsx/`, including files the OpenSpec CLI has no template for. A command
the CLI cannot regenerate is not thereby safe: `openspec update` rewrites the directory
from its own templates, and a file with no template is simply absent afterwards, which is
precisely the loss the check exists to detect.

Adding a command to the workflow SHALL therefore include adding its markers and raising the
check's file count. A marker SHALL satisfy the existing rule — present in the adapted file,
absent from any stock template that could replace it.

#### Scenario: A new command is added to the workflow

- **WHEN** `.claude/commands/opsx/review.md` is added
- **THEN** `check-opsx-commands.mjs` carries markers for it and exits 0 when the file is
  intact

#### Scenario: Regeneration removes a command with no stock template

- **WHEN** `openspec update` has run and `.claude/commands/opsx/review.md` no longer exists
- **THEN** the integrity check names the missing adaptations and stops the workflow before
  any source file is modified

### Requirement: No parallel command surface bypasses the gate

The CLI-generated skill twins of the change commands SHALL be removed —
`.claude/skills/openspec-propose/`, `.claude/skills/openspec-apply-change/`,
`.claude/skills/openspec-archive-change/` and `.claude/skills/openspec-verify-change/`.
They duplicate the slash commands as description-addressable skills, carrying none of the
gate, branch or worktree adaptations, so an agent selecting one by description would
author change artifacts on `develop` with no preflight.

`openspec-verify-change` SHALL be removed on the same reasoning, and is not exempt from
it. "Not invoked by any command" is not "not reachable": the skill's description — verify
that an implementation is complete, correct and coherent before archiving — matches what a
user asks for at exactly the stage `/opsx:verify` owns, and the skill writes no
`verify.md`, runs no availability gate, enters no worktree and runs no validation. An
agent that reaches it by description reports a change verified while the `verify` artifact
stays absent, and `/opsx:archive` then warns about a missing artifact the user has already
been told is done.

`openspec-sync-specs` SHALL be kept, because `/opsx:archive` invokes it by name to write
the main specs and its merge semantics have no second home — but being invoked by a command
is not an exemption, since a skill reachable through a command is still reachable through
its description. Its description SHALL name it as a subroutine of `/opsx:archive` and SHALL
NOT offer to update the main specs without archiving the change, and its first step SHALL
refuse any invocation that does not carry the change name, the workspace path and the delta
summary that command's dispatch supplies. It is the only retained skill that writes
`openspec/specs/`, which is why it is narrowed rather than merely justified.

#### Scenario: Agent selects a skill by description

- **WHEN** an agent looks for a skill that proposes a change
- **THEN** no such skill exists, and `/opsx:propose` is the only surface it can reach

#### Scenario: Agent looks for a way to verify before archiving

- **WHEN** a user asks for the change to be verified before archiving and an agent
  searches the skill catalogue by description
- **THEN** no verification skill exists, and `/opsx:verify` is the only surface it can
  reach — the one that writes and commits `verify.md`

#### Scenario: Agent looks for a way to update the main specs without archiving

- **WHEN** a user asks for a change's delta specs to be merged into the main specs while
  the change stays active, and an agent searches the skill catalogue by description
- **THEN** no skill offers that mode, and the merge skill it does find refuses the
  invocation and names `/opsx:archive` as the only way to reach the merge

### Requirement: Only archiving writes the main specifications

`openspec/specs/` SHALL be written only by `/opsx:archive`, and only from the delta specs
of the change being archived. No other command, skill, script or contributor writes that
tree: it is never hand-authored, never backfilled, and never synced ahead of archiving.
Every other surface that reads a delta spec — the preview command, the verification
command, the review of a change — SHALL be read-only with respect to it.

The main specs are the record of what is built. A requirement that reaches them before its
change is archived describes behaviour that does not exist, and it hides itself while doing
so: the coherence check compares delta against main, finds them identical, and reports the
deltas as already synced, so the change is archived with nothing left to write and no
commit ever ties those spec edits to the change that caused them.

**One exception, narrow and structural.** A delta replaces, removes and renames
*requirements*; a capability's introductory prose — the paragraphs above its `## Requirements`
heading — is not a requirement, so no merge can ever reach it. When a change makes that prose
contradict the requirements it introduces, the change MAY edit that prose by hand, subject to
all of the following: the edit touches only prose above `## Requirements`, never a requirement
body; it happens on the change's own branch, in the change's own commits, never ahead of the
change; and `verify.md` records which capabilities were edited this way and why. Everything
below `## Requirements` remains archive's alone. The reasoning above does not apply here — the
hiding failure it describes is a property of requirement text the coherence check compares,
and introductory prose is compared by nothing.

#### Scenario: A merge is requested mid-implementation

- **WHEN** a developer asks for a change's delta specs to be applied to the main specs
  while the change is still active
- **THEN** nothing writes `openspec/specs/`, and the developer is told that archiving the
  change is the only path that writes it

#### Scenario: The preview command reports what a merge would do

- **WHEN** the read-only preview runs against a change with delta specs
- **THEN** it reports the requirements a merge would add, modify, remove or rename, and
  writes no file

#### Scenario: Archiving writes the main specs

- **WHEN** `/opsx:archive` runs and the developer chooses to sync at the sync prompt
- **THEN** the deltas are merged into `openspec/specs/` and committed in the same commit
  as the archive move, on the change's own branch

#### Scenario: A change makes a capability's introductory prose contradict its requirements

- **WHEN** a change's delta removes or modifies a requirement that the capability's
  introductory prose describes as current behaviour
- **THEN** the change edits that prose by hand on its own branch, changes nothing below the
  capability's `## Requirements` heading, and `verify.md` names the capability and the reason

#### Scenario: A hand edit is attempted below the requirements heading

- **WHEN** an edit to `openspec/specs/` would change a requirement body outside
  `/opsx:archive`
- **THEN** it is refused, regardless of the introductory-prose exception

### Requirement: Brainstorm is grounded in the memory and the code

Brainstorming SHALL begin by reading `.claude/memory/index.md` and the pages it points at
for the area in question, and by reading the code that area actually contains. What the
developer proposes MUST then be checked against both before any approach is offered. The
agent MUST NOT accept a stated approach on the strength of it having been stated, and MUST
NOT invent an alternative without having looked at what exists.

Having looked, the agent SHALL do one of two things and say which: agree with the
developer's approach, naming the evidence that supports it; or propose a better
alternative, naming what in the memory or the code makes it better. Agreement is a valid
outcome and MUST NOT be avoided for the sake of appearing thorough. Disagreement MUST cite
something read, never a general principle alone.

Where the memory and the code disagree, the code SHALL be treated as the fact and the
memory as stale, and the discrepancy MUST be reported so it can be corrected.

#### Scenario: Developer proposes an approach that the code already contradicts

- **WHEN** the developer describes an approach and the existing code already solves that
  problem differently
- **THEN** the agent names the file it read, explains the conflict, and proposes the
  alternative that fits what is there

#### Scenario: Developer proposes an approach the evidence supports

- **WHEN** the memory and the code both support what the developer proposed
- **THEN** the agent says so plainly, cites what it read, and does not manufacture an
  alternative

#### Scenario: Memory contradicts the code

- **WHEN** a memory page claims something the code no longer does
- **THEN** the code wins, and the stale page is named for correction

### Requirement: Work is dispatched to a model matched to the task

Every unit of work handed to an agent SHALL run on a capability level chosen to match
that unit's difficulty, rather than inheriting whatever the session happens to run on.
Mechanical work with a complete specification takes the cheapest capable level;
integration and debugging work takes a middle level; architecture, adjudication and
whole-branch review take the highest available. The rule SHALL be expressed in terms of
capability levels only — never as named models, vendors or products — because the project
is executed by more than one agent runtime and each names its levels differently. Where a
runtime exposes no such choice, the rule is satisfied by that runtime's own equivalent
control, or noted as unavailable.

#### Scenario: Mechanical task with a complete specification

- **WHEN** a task's instructions already carry the exact content to write
- **THEN** it is dispatched at the cheapest level that can execute it, and the chosen
  level is stated in the dispatch

#### Scenario: Whole-branch review

- **WHEN** a change's implementation is complete and the final review runs
- **THEN** it is dispatched at the highest capability level available, not at the
  session default

#### Scenario: Runtime without selectable levels

- **WHEN** the workflow runs on an agent runtime that does not expose model selection
- **THEN** the requirement is met by that runtime's nearest equivalent control, and no
  named model appears in any project artifact

### Requirement: In-flight changes use the new schema

Every change directory under `openspec/changes/` that is not yet archived SHALL pin
`schema: sdd-plus-superpowers` in its `.openspec.yaml`. For a migrated change, an existing
`design.md` stands in for `brainstorm.md`, which is marked done rather than written after
the fact.

#### Scenario: Existing change is picked up after migration

- **WHEN** work resumes on a change proposed before this migration
- **THEN** it runs the eight-artifact flow, and its brainstorm stage is satisfied by the
  design it already has

### Requirement: Verification runs the tests for what the change touched

`/opsx:verify` SHALL run the tests of every workspace package the change modified, together
with the packages that depend on them, and MUST derive that set from the change's own
`plan.md` rather than from a comparison against a base branch, which would also select work
the branch carries for other reasons. The run MUST be a real execution: a result served
from a build cache is a replay of an earlier run against earlier code and MUST NOT be
recorded as a pass. A failure in a package the change touched MUST make the verdict FAIL.
Verification MUST NOT run the whole suite; a failure elsewhere is not evidence about this
change, and a gate that fails on work it does not own is one that gets overridden by habit.

`/opsx:apply` MUST run the **whole** test suite once, after `subagent-driven-development`
returns — all wave groups merged and its own final whole-implementation review already run
— and MUST record the result — pass/fail counts, confirmation nothing was served from
cache, and the commit SHA it ran against — in the change directory. The apply-time run is
deliberately broader than verification's: it is the only place in the cycle where a
cross-package or cross-group regression is visible, because a task group's own checks see
only the packages its `**Files:**` blocks name, and two groups that are each green in
isolation can merge into a change branch that is not.

A failure in the apply-time run MUST pause apply and MUST be reported, with one exception:
a failure that also reproduces on `origin/develop` MUST be reported as pre-existing, MUST
NOT block the change, and MUST be named as separate work. Without that exception the gate
fails on work the change does not own, which is how the previous whole-suite gate came to be
overridden by habit.

`/opsx:verify` check 6 MUST check for that record before running the tests again: if the
record exists and no commit has landed on top of the SHA it ran against — checked against
the whole repository, not scoped to the change directory, since the record's own commit
always lands there — the check MUST cite the record instead of re-running; otherwise it MUST
run the tests exactly as it does when no record exists. Citing a record from a superseded
commit is equivalent to accepting a stale cached result and MUST NOT happen.

#### Scenario: The affected packages are green

- **WHEN** verification runs for a change that modified one or more packages and their
  tests report no failures
- **THEN** the check passes and the record carries the real counts and the evidence that
  nothing was replayed

#### Scenario: An affected package is red

- **WHEN** a package the change modified reports any failure
- **THEN** the verdict is FAIL, the failing tests are named, and the change does not
  proceed to archive on the strength of a rewritten verdict

#### Scenario: The change touched no package

- **WHEN** the change modified only files outside every workspace package
- **THEN** the check records which directories were touched, runs nothing, and passes

#### Scenario: The build cache offers a stale pass

- **WHEN** the run would be answered from the cache of an earlier run
- **THEN** the check forces a real execution and records the evidence that nothing was
  replayed, rather than accepting the cached verdict

#### Scenario: Apply's whole-suite run finds a cross-package regression

- **WHEN** apply's whole-suite run fails in a package no `**Files:**` block named, and the
  same test passes on `origin/develop`
- **THEN** apply pauses and reports the failure as caused by this change

#### Scenario: Apply's whole-suite run finds a pre-existing failure

- **WHEN** apply's whole-suite run fails in a package the change did not touch, and the same
  failure reproduces on `origin/develop`
- **THEN** the failure is recorded as pre-existing, apply does not block on it, and it is
  named as separate work

#### Scenario: Apply already recorded a passing run at the current commit

- **WHEN** `/opsx:verify` check 6 runs and finds an apply-time test record whose SHA
  matches the current commit, with no commits landed since
- **THEN** the check cites that record's pass/fail counts and cache-evidence instead of
  re-running the test command

#### Scenario: A commit landed after the apply-time record

- **WHEN** `/opsx:verify` check 6 finds an apply-time test record, but the repository has at
  least one commit made after the recorded SHA (other than the record file itself or a
  `verify.md` update)
- **THEN** the check re-runs the test command in full, exactly as if no record existed

### Requirement: Verification checks whether the change makes an existing skill stale

`/opsx:verify` SHALL run an eighth check that compares the change's diff against the documented
scope of every `.claude/skills/*/SKILL.md` (and its `README.md`/manifest, where present), to
determine whether the change makes any skill's documented process or facts inaccurate. A skill
whose documentation states, as current fact, a behavior the diff has changed MUST be classified
CONFIRMED stale; a plausible but unconfirmed candidate MUST be classified PLAUSIBLE and recorded as
a non-blocking warning. A CONFIRMED finding MUST make the verdict FAIL.

No skill file MAY be edited by the verifying process to resolve a CONFIRMED finding without first
posting the proposed edit to the developer and receiving explicit approval. An explicit developer
decline, recorded with its reasoning in `verify.md`, MUST be treated as resolving the finding and
MUST allow verification to pass; an edit MUST NOT be applied silently under any circumstance,
regardless of confidence in the CONFIRMED classification.

This check MUST be implemented consistently across `openspec/schemas/sdd-plus-superpowers/schema.yaml`
(the canonical instruction), `.claude/commands/opsx/verify.md` (the executable command steps), and
`openspec/schemas/sdd-plus-superpowers/templates/verify.md` (the output template) — a check
described in only one of the three is not executable and MUST NOT be considered implemented.

#### Scenario: A change makes a skill's documented process wrong

- **WHEN** a change modifies code or behavior that a `SKILL.md` describes as current fact
- **THEN** the check classifies the affected skill CONFIRMED stale
- **AND** the verdict is FAIL until the developer either approves a posted proposed edit or
  explicitly declines with a recorded reason

#### Scenario: A developer approves the proposed skill edit

- **WHEN** the verifying process posts a proposed edit to a CONFIRMED-stale skill file and the
  developer approves it
- **THEN** the edit is applied to the skill file
- **AND** verification is re-run to confirm the finding is resolved

#### Scenario: A developer declines the proposed skill edit

- **WHEN** the developer explicitly declines a proposed edit, with a stated reason
- **THEN** the decline and its reason are recorded in `verify.md`
- **AND** the check no longer blocks the verdict on that finding

#### Scenario: No skill is affected

- **WHEN** a change's diff touches no code or behavior any `SKILL.md` documents as current fact
- **THEN** the check passes with no findings

#### Scenario: The check is only implemented in schema.yaml

- **WHEN** the eighth check's instruction exists in `schema.yaml` but `.claude/commands/opsx/verify.md`
  or `templates/verify.md` was not updated to match
- **THEN** the check is not considered implemented, since it cannot actually execute or record its
  result through the real `/opsx:verify` command

### Requirement: Verification checks the shape declarations against the derived shape

Verification SHALL run a check that derives the workflow's shape from the files that define
it and compares it against the places that declare that shape. The check MUST NOT carry the
current counts as constants: a check that remembers "seven artifacts" goes stale exactly like
the declarations it inspects, and would become another instance of the defect it exists to
end.

The shape SHALL be derived from the artifact ids in the vendored schema, the command files
under `.claude/commands/opsx/` excluding the non-cycle commands the check names, and the
numbered sections of the verification template.

The check SHALL compare that derived shape against **declaration sites** — the specific
places where the cycle's shape is stated as such — and MUST NOT scan documentation prose for
numbers. Scanning prose does not work and cannot be made to work at acceptable cost: a
count beside `artifact`, `command` or `check` almost always counts a subset in English
("four commands call this", "three checks moved earlier", "the five artifacts most likely to
quote it"), and the artifact ids are themselves ordinary words — `plan`, `tasks`, `specs`,
`design`, `review` — so an enumeration rule fires on any sentence mentioning three of them.
Measured against this repository, a prose scan produced ten findings and every one was a
false positive, including one that flagged the very grep command written to hunt the drift.
A check whose findings are all noise is switched off, which leaves less protection than none.

The declaration sites SHALL be: the cycle line, the stated artifact count and the artifact
table in the workflow documentation's change-workflow section, the artifact sequence in the
vendored schema's own description, and the verification command's statement of how many
sections and checks its report has. The stated count is its own site: a table whose rows are
correct beside a sentence that miscounts them is the drift this check exists to name, and
reporting them together would hide which one is wrong. A site whose declaration disagrees with the derived shape is a blocking finding.
A site whose anchor cannot be found is a finding too: a check that goes silent when its own
anchor is edited fails exactly when the shape is being changed, which is the one moment it
exists for.

The schema description's sequence MAY omit an artifact that no other artifact requires —
`design` is optional and deliberately absent from it — and the check SHALL derive that
allowance from the schema's own `requires` edges rather than naming the artifact.

This is deliberately narrower than catching every mention. Incidental prose is not checked,
and a change that adds a check SHALL still correct any count literal its own addition makes
stale, in the same change, whether or not the check would have caught it.

#### Scenario: A declaration states a stale artifact count

- **WHEN** the workflow documentation's artifact table declares seven artifacts and the schema
  defines eight
- **THEN** the check names the site and the derived count, and verification records the finding

#### Scenario: A declaration omits a command

- **WHEN** the cycle line names four commands and the command directory holds five cycle
  commands
- **THEN** the check names the omission

#### Scenario: The schema description omits an optional artifact

- **WHEN** the schema's description sequence omits `design`, which no other artifact requires
- **THEN** the check does not report it, because the allowance is derived from the schema's
  own dependency edges

#### Scenario: Prose counts a subset

- **WHEN** a memory page says "four commands call `git status --porcelain`" and five cycle
  commands exist
- **THEN** the check does not report it, because that sentence is not a declaration site

### Requirement: Structural validation happens at propose time

`/opsx:propose` MUST run `openspec validate --all --json` immediately after the `specs`
artifact is written and before that artifact is committed. Every item returned MUST report
`"valid": true` before the commit step runs. If any item is invalid, the requirement text
MUST be fixed in place and the validation re-run — an invalid spec MUST NOT be committed.

#### Scenario: A requirement fails validation at propose time

- **WHEN** `/opsx:propose` runs `openspec validate --all --json` after writing a `specs`
  artifact whose requirement text places `SHALL`/`MUST` after the first line of its body
- **THEN** the command reports the failing item, fixes the requirement text so the
  normative keyword is on the first line, re-runs validation, and only commits once every
  item reports `"valid": true`

#### Scenario: A requirement passes validation at propose time

- **WHEN** every requirement in a newly written `specs` artifact places `SHALL`/`MUST` on
  its first line
- **THEN** `openspec validate --all --json` reports every item `"valid": true` and the
  commit step proceeds without further action

### Requirement: Plan authoring reconciles design risks before completion

The `plan` artifact instruction MUST require, before `plan.md` is considered done, that
every risk listed in the change's `design.md` Risks/Trade-offs section has an explicit
line in `plan.md` naming which task's text addresses it, or an explicit, reasoned
statement that the risk is deferred. A task's instructions MUST NOT contradict a named
risk's stated mitigation or a requirement in the change's own `specs/`; a plan found to
contradict either MUST be rewritten before the artifact is marked done.

#### Scenario: A plan task contradicts a named design risk

- **WHEN** `design.md`'s Risks/Trade-offs section names a specific failure mode and its
  mitigation, and a drafted `plan.md` task instructs the implementer to do the opposite of
  that mitigation
- **THEN** the risk-reconciliation check catches the contradiction before `plan.md` is
  marked done, and the task's text is rewritten to match the mitigation before apply can
  proceed

#### Scenario: Every design risk is addressed in the plan

- **WHEN** `plan.md` is drafted from a `tasks.md` and `design.md` whose Risks/Trade-offs
  section lists one or more risks
- **THEN** each listed risk has a corresponding line in `plan.md` naming the task that
  addresses it, or an explicit reasoned deferral, before the `plan` artifact is marked done
