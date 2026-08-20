---
name: openspec-sync-specs
description: Internal subroutine of /opsx:archive step 7. Merges a change's delta specs into the main specs as part of archiving that change. Not a standalone action - it is dispatched by /opsx:archive and by nothing else, and it is never used to update the main specs without archiving.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.5.0"
---

Merge a change's delta specs into the main specs. This is the spec-writing step of
`/opsx:archive` and it has no other caller.

This is an **agent-driven** operation - you will read delta specs and directly edit main specs to apply the changes. This allows intelligent merging (e.g., adding a scenario without copying the entire requirement).

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: supplied by `/opsx:archive` step 7 and by nothing else: the change name, the
absolute path of the workspace to work in, and the delta spec summary that command has
already analysed. There is no interactive entry point — see step 1.

**Steps**

1. **Refuse any invocation that does not come from `/opsx:archive`**

   A valid invocation arrives from `/opsx:archive` step 7 and carries three things: the
   change name, the absolute path of the workspace to work in, and the delta spec summary
   that command already analysed.

   If any of the three is missing — including an invocation that names no change, and any
   request to update the main specs without archiving the change — STOP, print the line
   below, and edit nothing:

   `openspec/specs/ is written only by /opsx:archive. Run /opsx:archive <change> and choose "Sync now" at the sync prompt.`

   Do not prompt for a change to select and do not run `openspec list`. Merging outside
   archive makes the main specs describe behaviour that is not built and whose change was
   never archived; the next `/opsx:verify` compares the delta against the main spec, finds
   them identical, and records the deltas as already synced, so no commit ever associates
   those spec edits with the change that caused them.

   With all three supplied, enter the workspace and confirm it before writing anything:

   ```bash
   cd <the absolute path from the dispatch>
   git rev-parse --show-toplevel
   ```

   It must print that same path. If it prints anything else, STOP: a merge run from the
   wrong repository root writes this change's requirements onto whatever branch that
   checkout holds.

2. **Resolve change context**

   Run:
   ```bash
   openspec status --change "<name>" --json
   ```

3. **Find delta specs**

   Use `artifactPaths.specs.existingOutputPaths` from the status JSON as the list of delta spec files.

   Each delta spec file contains sections like:
   - `## ADDED Requirements` - New requirements to add
   - `## MODIFIED Requirements` - Changes to existing requirements
   - `## REMOVED Requirements` - Requirements to remove
   - `## RENAMED Requirements` - Requirements to rename (FROM:/TO: format)

   If no delta specs found, inform user and stop.

4. **For each delta spec, apply changes to main specs**

   For each repo-local capability delta spec path returned by the CLI:

   a. **Read the delta spec** to understand the intended changes

   b. **Read the main spec** at `openspec/specs/<capability>/spec.md` (may not exist yet)

   c. **Apply changes intelligently**:

      **ADDED Requirements:**
      - If requirement doesn't exist in main spec → add it
      - If requirement already exists → update it to match (treat as implicit MODIFIED)

      **MODIFIED Requirements:**
      - Find the requirement in main spec
      - Apply the changes - this can be:
        - Adding new scenarios (don't need to copy existing ones)
        - Modifying existing scenarios
        - Changing the requirement description
      - Preserve scenarios/content not mentioned in the delta

      **REMOVED Requirements:**
      - Remove the entire requirement block from main spec

      **RENAMED Requirements:**
      - Find the FROM requirement, rename to TO

   d. **Create new main spec** if capability doesn't exist yet:
      - Create `openspec/specs/<capability>/spec.md`
      - Add Purpose section (can be brief, mark as TBD)
      - Add Requirements section with the ADDED requirements

5. **Show summary**

   After applying all changes, summarize:
   - Which capabilities were updated
   - What changes were made (requirements added/modified/removed/renamed)

**Delta Spec Format Reference**

```markdown
## ADDED Requirements

### Requirement: New Feature
The system SHALL do something new.

#### Scenario: Basic case
- **WHEN** user does X
- **THEN** system does Y

## MODIFIED Requirements

### Requirement: Existing Feature
#### Scenario: New scenario to add
- **WHEN** user does A
- **THEN** system does B

## REMOVED Requirements

### Requirement: Deprecated Feature

## RENAMED Requirements

- FROM: `### Requirement: Old Name`
- TO: `### Requirement: New Name`
```

**Key Principle: Intelligent Merging**

Unlike programmatic merging, you can apply **partial updates**:
- To add a scenario, just include that scenario under MODIFIED - don't copy existing scenarios
- The delta represents *intent*, not a wholesale replacement
- Use your judgment to merge changes sensibly

**Output On Success**

```
## Specs Synced: <change-name>

Updated main specs:

**<capability-1>**:
- Added requirement: "New Feature"
- Modified requirement: "Existing Feature" (added 1 scenario)

**<capability-2>**:
- Created new spec file
- Added requirement: "Another Feature"

Main specs are now updated in the workspace this run was given. Return control to /opsx:archive, which commits these edits together with the archive move.
```

**Guardrails**
- Read both delta and main specs before making changes
- Preserve existing content not mentioned in delta
- If something is unclear, ask for clarification
- Show what you're changing as you go
- The operation should be idempotent - running twice should give same result
- This skill is not a standalone action. `/opsx:archive` step 7 is its only sanctioned
  caller, and step 1 refuses anything else — the main specs are written during archiving
  and at no other time.
