<!--
Delta spec template for a change.

This template demonstrates the 4 delta section kinds; use whichever apply:
- ADDED / MODIFIED / REMOVED / RENAMED
File name and location: openspec/changes/<change-name>/specs/<capability>/spec.md
(`<capability>` matches the openspec/specs/<capability>/ directory name)

Hard format rules (validated by OpenSpec):
- A requirement sentence MUST contain `SHALL` or `MUST`
- Every Requirement MUST have at least one `#### Scenario:`
- Scenario MUST use level-4 (`####`); level-3 or bullets fail silently
-->

## ADDED Requirements

<!-- New behavior. List the new Requirements this change adds to the capability. -->

### Requirement: <!-- requirement name -->
<!-- requirement text — must contain SHALL or MUST -->

#### Scenario: <!-- scenario name -->
- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## MODIFIED Requirements

<!--
Modifying an existing Requirement. **MUST use the exact same normalized header
as openspec/specs/<capability>/spec.md** (trimmed, case-sensitive comparison),
otherwise the delta apply during archive fails to find the matching requirement.

**MUST paste the full modified content** (not just a diff), because OpenSpec
archive applies MODIFIED as a whole-text replacement.
-->

### Requirement: <!-- same header as in the existing spec -->
<!-- full modified requirement text — must contain SHALL or MUST -->

#### Scenario: <!-- scenario name (new or modified) -->
- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## REMOVED Requirements

<!--
Removing an existing Requirement. MUST include Reason and Migration so the
reviewer understands why it is being dropped and how existing callers should migrate.
-->

### Requirement: <!-- header being removed, exactly matching the existing spec -->

**Reason**: <!-- why it's being removed -->

**Migration**: <!-- how existing callers/dependents should adjust -->

---

## RENAMED Requirements

<!--
Renaming a Requirement header. Fixed format: FROM / TO with a code-fence header.
If the name changes **and** the content changes, list the rename in RENAMED
**and** write the full content again under MODIFIED using the **new** header.

archive apply order: RENAMED → REMOVED → MODIFIED → ADDED
-->

- FROM: `### Requirement: <Old Name>`
- TO: `### Requirement: <New Name>`
