Create the specification files that define WHAT the system must do.

Write delta specs under this change only. The project's `openspec/specs/` is written by archive
alone; a hand-authored main spec drifts from the archived deltas.

Create one spec file per capability listed in the proposal's Capabilities section:
- New capabilities: use the exact kebab-case name from the proposal (`specs/<capability>/spec.md`).
- Modified capabilities: use the existing folder name from `openspec/specs/<capability>/` for the
  delta spec at `specs/<capability>/spec.md`.

Delta operations (`##` headers):
- **ADDED Requirements**: new behaviour.
- **MODIFIED Requirements**: changed behaviour — MUST include the full updated content.
- **REMOVED Requirements**: MUST include **Reason**, **Migration** and **Code Disposition:**
  (where the behaviour's code went: deleted, superseded by a named path, or deliberately left in
  place with a reason — and whether the old path is still reachable). Removed behaviour whose
  code stayed reachable otherwise goes unaccounted.
- **RENAMED Requirements**: name changes only — use the FROM:/TO: format — MUST include
  **Code Disposition:** (same meaning as above).

Format:
- Each requirement: `### Requirement: <name>` followed by its description.
- Use SHALL or MUST for normative requirements (avoid should or may).
- Each scenario: `#### Scenario: <name>` in WHEN/THEN form.
- Scenarios MUST use exactly four hashtags (`####`). Three hashtags or bullets fail silently.
- Every requirement MUST have at least one scenario.

Specs are testable: each scenario is a potential test case.

Before marking specs done, read every SHALL, MUST and MUST NOT back against what the proposal
intends. A requirement whose polarity is inverted — MUST where MUST NOT is meant — validates
cleanly and specifies the opposite behaviour; one such slip reached verify past both whole-branch
reviews.

The `specs` gates check the structure, the capability contract and each delta header against
the main spec; the propose block states how a gate binds. The polarity read above is yours: no
gate can see it.
