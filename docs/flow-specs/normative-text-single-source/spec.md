# Normative Text Single Source

## Purpose

Defines where a rule of the change workflow is allowed to be stated in full. The flow is
described by four surfaces — the capability specs, the vendored schema, the `opsx` command
files, and `.claude/CLAUDE.md` §5 — and a rule restated on more than one of them drifts:
one copy is edited, the other is not, and an agent reading the stale copy takes the wrong
action while believing it followed the flow.

The requirements below fix what keeps that from happening — which surface owns which kind
of statement, what a pointer must carry so that not following it is still safe, that a
relocation may move text but never reword it, that a deterministic check under
`.claude/scripts/adf-regression/` catches a rule restated in a second file, and that the
benefit of a relocation is a measured byte count rather than a claim.

The check does not yet report a clean corpus. It ships with a `KNOWN_DEFERRED_DUPLICATES`
allowlist of ten normative sentences that are still stated on two surfaces: each was found
to need a wording change in order to be deduplicated, which the relocation requirement
forbids doing inside a relocation diff. Those ten are deferred findings awaiting their own
change, not exceptions to the requirements below, and the allowlist is expected to
shrink to nothing.

## Requirements

### Requirement: One normative surface per rule

Every rule of the change workflow SHALL be stated in full on exactly one surface. The four surfaces and their roles are fixed: `openspec/specs/` states what must be true of the flow and carries requirements and scenarios only; `openspec/schemas/sdd-plus-superpowers/schema.yaml` states how a phase executes and carries the full procedure; `.claude/commands/opsx/*.md` state what the operator does; `.claude/CLAUDE.md` §5 states the invariants a developer must know and MUST NOT carry mechanics. A surface other than the owning one MUST NOT restate a rule the owning surface states in full.

#### Scenario: A rule is written for the first time

- **WHEN** a change introduces a new workflow rule
- **THEN** the rule is stated in full on the surface its role assigns, and any other surface that needs it carries a pointer rather than a second statement

#### Scenario: Mechanics reach the invariant surface

- **WHEN** a change would add step-by-step procedure to `.claude/CLAUDE.md` §5
- **THEN** the procedure goes to `schema.yaml` and §5 carries only the invariant

### Requirement: A pointer carries the imperative and the consequence

A surface that defers to another SHALL carry a pointer of one sentence containing the imperative, its one-line consequence, and the surface that states it in full. Mechanics MUST live behind the pointer; the consequence MUST NOT, so that an agent which does not follow the pointer still does not take the wrong action.

#### Scenario: A command defers to the schema

- **WHEN** a command file needs a rule the schema states in full
- **THEN** the command file states the imperative and its consequence in one sentence and names `schema.yaml` as the full statement, without repeating the procedure

#### Scenario: A pointer omits the consequence

- **WHEN** a pointer names only the surface to read
- **THEN** it is incomplete and the consequence is added to the pointer itself

### Requirement: Relocating normative text preserves meaning

A change that relocates normative text SHALL preserve its meaning exactly. A rule whose wording must change in order to be deduplicated MUST be recorded as a finding and deferred to its own change, and MUST NOT be rewritten inside a relocation diff. The reviewability of a relocation rests on the claim that nothing changed meaning, and a semantic edit hidden inside it makes that claim uncheckable.

#### Scenario: Two statements of one rule disagree

- **WHEN** deduplication finds that two surfaces state a rule differently and no single wording preserves both
- **THEN** the finding is recorded with both wordings and deferred, and neither statement is edited in the relocation diff

#### Scenario: A relocation is reviewed

- **WHEN** a reviewer reads a relocation diff
- **THEN** every moved passage is identical to its source apart from the pointer left behind

### Requirement: A deterministic check detects a restated rule

The repository SHALL carry a check that fails when one normalised normative sentence appears in two files of the flow-defining set. The check MUST live under `.claude/scripts/adf-regression/` with a test beside it, so that verification runs it as part of the existing regression set rather than as an additional numbered check. It MUST match only sentences carrying a normative modal, MUST ignore fenced code blocks and tables, and MUST carry its own file set as a constant rather than reading it from a gitignored personal file, so that its result does not differ between machines.

#### Scenario: A rule is restated in a second file

- **WHEN** a normative sentence in `schema.yaml` is restated in a command file
- **THEN** the regression set reports that item as a finding and verification fails

#### Scenario: An ordinary sentence appears twice

- **WHEN** the same non-normative sentence appears in two flow-defining files
- **THEN** the check reports nothing, because it matches only sentences carrying a normative modal

### Requirement: Acceptance of a relocation is a measured number

A change that relocates normative text SHALL record the byte count of normative prose each phase must read, before and after the relocation, and hand it to `adf-metrics.mjs` as a trendable indicator. A relocation that does not reduce what a phase must read has not achieved its purpose, and the measurement is what distinguishes the two outcomes from an assertion.

#### Scenario: A relocation completes

- **WHEN** the relocation is finished
- **THEN** the per-phase byte counts before and after are recorded and the difference is reported

#### Scenario: The count did not fall

- **WHEN** the after count is not lower than the before count for any phase
- **THEN** the change reports that result rather than claiming an improvement
