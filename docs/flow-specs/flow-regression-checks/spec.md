# Flow Regression Checks

## Purpose

Defines how a confirmed defect in this flow stops recurring: it becomes a deterministic
script under `.claude/scripts/adf-regression/` rather than another paragraph of
instruction prose. A script catches the defect every time and costs no agent context; a
paragraph catches it only when an agent reads and honours the paragraph.

The requirements below fix what keeps that set of checks useful as it grows — each script
records the incident it was written for and the date it last reported a finding,
verification runs the whole set as one check reporting per item rather than adding a check
per incident, every retrospective names a removal candidate or states that none qualifies,
and a change that adds a check corrects the count literals it makes stale in that same
change.

## Requirements

### Requirement: A confirmed flow defect becomes a deterministic check

A flow defect confirmed by a retrospective or by an incident SHALL become a script under `.claude/scripts/adf-regression/`, rather than another paragraph of instruction prose. A defect caught by a script is caught deterministically and costs no agent context; a defect caught by prose is caught only if an agent reads and honours the paragraph, which is precisely what failed for the execution graph requirement that already existed and produced nothing.

#### Scenario: A retrospective confirms a defect

- **WHEN** a retrospective confirms that a stated flow rule was skipped and the skip went unnoticed
- **THEN** a script under `.claude/scripts/adf-regression/` is added that detects that skip

#### Scenario: A defect that no script can detect

- **WHEN** a confirmed defect depends on judgment no script can evaluate
- **THEN** the retrospective states that the defect cannot be made deterministic, rather than adding a script that cannot detect it

### Requirement: Each regression script records its origin and its last firing

Every script under `.claude/scripts/adf-regression/` MUST record the incident it was written for and the date it last reported a finding. The last-firing date is what makes retirement decidable: a check that has not fired across several changes is saturated, and saturation is the signal the removal rule acts on.

#### Scenario: A script reports a finding

- **WHEN** a regression script reports a finding during verification
- **THEN** its recorded last-fired date is updated to that run

#### Scenario: A script has never fired

- **WHEN** a script has recorded no firing since it was added
- **THEN** that absence is readable from the script itself, without reconstructing history from git

### Requirement: One verification check runs the whole regression set

Verification SHALL run the regression set as a single check that reports per item, and SHALL NOT add one check per script. The workflow shape check derives the verification check count from the numbered sections of the verification template and compares it against the sites that declare it, so a set growing by one check per incident would move that count on every future change; one check keeps the declared shape stable while the set behind it grows.

#### Scenario: Three regression scripts, one check

- **WHEN** `.claude/scripts/adf-regression/` holds three scripts and verification runs
- **THEN** the report contains one check section listing three per-item results

#### Scenario: The regression directory is empty

- **WHEN** no regression script has been written yet
- **THEN** the check reports zero items and passes, rather than failing on an empty directory

### Requirement: Every retrospective names a removal candidate

A retrospective MUST name one rule or check as a candidate for removal, together with the incident it last prevented, or MUST state explicitly that none qualifies. A check set with no retirement mechanism grows monotonically, and a retirement rule with no set to act on is a report section; the two ship and operate together.

#### Scenario: A saturated check exists

- **WHEN** a retrospective finds a check that has not fired since it was added several changes ago
- **THEN** the retrospective names it as a removal candidate and states the incident it was written for

#### Scenario: Every rule is still load-bearing

- **WHEN** every check has fired recently and every rule has a recent incident behind it
- **THEN** the retrospective states that no candidate qualifies, rather than nominating one to satisfy the requirement

### Requirement: A change adding a check corrects the count literals it makes stale

A change that adds a verification check MUST update, in that same change, every site declaring the check count — the verification template's numbered sections and the verification command's statement of how many sections and checks its report has. The workflow shape check reports a disagreeing site as blocking, so this obligation is enforced rather than remembered.

#### Scenario: A change adds two checks

- **WHEN** a change adds two numbered sections to the verification template
- **THEN** the same change updates the verification command's stated section and check counts, and the shape check reports no finding

#### Scenario: A literal is left stale

- **WHEN** a change adds a check section without updating the stated count
- **THEN** the shape check names the site, the derived count and the declared count, and verification records a blocking finding
