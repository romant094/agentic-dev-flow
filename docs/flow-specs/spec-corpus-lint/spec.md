# Spec Corpus Lint

## Purpose

Defines the `spec-corpus-lint` skill: a manually invoked read of `openspec/specs/` as a
whole, judged on whether the capability corpus still says one thing. Capabilities enter the
corpus one delta merge at a time and each merge is reviewed against its own change, never
against the rest of the corpus, so a requirement that contradicts a neighbour is added
without anything noticing.

The requirements below fix what keeps that read useful — what it looks for, that it reports
and never blocks, and the cadence that makes it a lint somebody actually runs. It is
deliberately wired into nothing: no command dispatches it, no schema instruction names it,
and no CI job runs it. The measured disease of this flow is monotonic gate growth, so this
check buys its coherence report by staying out of every phase's path.

## Requirements

### Requirement: The capability corpus has a coherence lint

The repository SHALL carry a manually invoked lint that reads `openspec/specs/` as a whole and reports contradictions between capabilities, requirements that no capability owns, and introductory prose that contradicts the requirements below it. The capability set grows monotonically through delta merges and is never read back whole, so nothing else detects a corpus that has stopped saying one thing.

#### Scenario: Two capabilities state opposite rules

- **WHEN** the lint runs over a corpus in which two capabilities require incompatible behaviour of the same subject
- **THEN** it reports both capabilities and the incompatible requirements

#### Scenario: Introductory prose contradicts its own requirements

- **WHEN** a capability's prose above `## Requirements` describes behaviour its requirements no longer specify
- **THEN** the lint reports that capability

### Requirement: The corpus lint never blocks a phase

The corpus lint SHALL report only. It MUST NOT gate `/opsx:verify`, `/opsx:archive`, or any other phase, and its findings MUST be acted on by a human decision rather than by a failing exit code. The measured disease of this flow is monotonic gate growth, so a coherence report that blocked a phase would cost more than the incoherence it detects.

#### Scenario: The lint reports findings

- **WHEN** the lint finds contradictions
- **THEN** it writes them to its report and no phase fails as a result

### Requirement: The corpus lint runs on a stated cadence

The corpus lint SHALL run every third to fifth archived change, and immediately after any change that hand-edited a capability's introductory prose. A lint with no cadence is a lint nobody runs, and a hand edit to capability prose is the event most likely to have created the incoherence the lint detects.

#### Scenario: A change hand-edits capability prose

- **WHEN** a change records in `verify.md` that it edited a capability's introductory prose
- **THEN** the corpus lint runs after that change is archived

#### Scenario: Several changes archive without a hand edit

- **WHEN** the fifth change archives with no corpus lint run since the last one
- **THEN** the lint runs
