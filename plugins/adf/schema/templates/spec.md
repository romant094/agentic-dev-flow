<!--
Delta spec template for a change.

This template demonstrates the 4 delta section kinds; use whichever apply:
- ADDED / MODIFIED / REMOVED / RENAMED
File name and location: openspec/changes/<change-name>/specs/<capability>/spec.md
(`<capability>` matches the openspec/specs/<capability>/ directory name)

Hard format rules (validated by `specs.mjs validate`):
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

**MUST paste the full modified content** (not just a diff), because
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
Removing an existing Requirement. MUST include Reason, Migration, and Code Disposition so the
reviewer understands why it is being dropped, how existing callers should migrate, and where
the behaviour's code went.
-->

### Requirement: <!-- header being removed, exactly matching the existing spec -->

**Reason**: <!-- why it's being removed -->

**Migration**: <!-- how existing callers/dependents should adjust -->

**Code Disposition:** <!-- where the behaviour's code went: deleted, superseded by a named
path, or deliberately left in place with a reason - and whether the old path is still
reachable -->

---

## RENAMED Requirements

<!--
Renaming a Requirement header. Fixed format: FROM / TO with a code-fence header, plus
Code Disposition so the reviewer knows where the behaviour's code went and whether the old
path is still reachable.
If the name changes **and** the content changes, list the rename in RENAMED
**and** write the full content again under MODIFIED using the **new** header.

archive apply order: RENAMED → REMOVED → MODIFIED → ADDED
-->

- FROM: `### Requirement: <Old Name>`
- TO: `### Requirement: <New Name>`

**Code Disposition:** <!-- where the behaviour's code went: deleted, superseded by a named
path, or deliberately left in place with a reason - and whether the old path is still
reachable -->
