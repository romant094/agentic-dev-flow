---
name: "OPSX: Sync"
description: Sync delta specs from a change to main specs
category: Workflow
tags: [workflow, specs, experimental]
---

Sync delta specs from a change to main specs.

This is a **read-only preview**. It reads the delta specs, compares them against the main
specs, and reports what `/opsx:archive` would apply. It writes nothing.

`openspec/specs/` is written only by `/opsx:archive`. Stated in full in
`.claude/CLAUDE.md` §5. Syncing mid-implementation would make the main specs describe
behaviour that is not built and whose change was never archived, and the next
`/opsx:verify` would then report those deltas as already synced. If the specs should be
updated, archive the change.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name after `/opsx:sync` (e.g., `/opsx:sync add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **If no change name provided, prompt for selection**

   Run `openspec list --json` to get available changes. Use the **AskUserQuestion tool** to let the user select.

   Show changes that have delta specs (under `specs/` directory).

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose.

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

4. **For each delta spec, report what archive would apply**

   For each repo-local capability delta spec path returned by the CLI:

   a. **Read the delta spec** to understand the intended changes

   b. **Read the main spec** at `openspec/specs/<capability>/spec.md` (may not exist yet)

   c. **Classify each requirement**, and write nothing:

      - **ADDED** — absent from the main spec, so archive would add it; or already
        present, so archive would update it to match.
      - **MODIFIED** — present in the main spec; report which scenarios would be added
        or changed and which existing content would be preserved.
      - **REMOVED** — present in the main spec; archive would remove the whole block.
      - **RENAMED** — report the FROM and TO names, and whether FROM is actually there.

      Where the delta and the main spec already agree, say "already synced" for that
      requirement.

   d. **Capability absent from `openspec/specs/`** — report that archive would create
      `openspec/specs/<capability>/spec.md`, and list the requirements it would carry.

   Do not create, edit or delete any file under `openspec/specs/`. If the developer asks
   you to apply the changes, say that `/opsx:archive` is what applies them, and stop.

5. **Show the preview**

   Nothing has been written. Summarize what `/opsx:archive` would apply:
   - Which capabilities archive would update, and which it would create
   - Which requirements it would add, modify, remove or rename
   - Which requirements are already synced, so archive would change nothing

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

**Key Principle: What the merge would do**

Report the merge as partial updates rather than whole-file replacements:
- To add a scenario, just include that scenario under MODIFIED - don't copy existing scenarios
- The delta represents *intent*, not a wholesale replacement
- the delta represents intent, so report the intent; archive performs the merge

**Output On Success**

```
## Sync Preview: <change-name>

Nothing was written. `/opsx:archive` would apply:

**<capability-1>**:
- Add requirement: "New Feature"
- Modify requirement: "Existing Feature" (1 scenario added)

**<capability-2>**:
- Create the main spec
- Add requirement: "Another Feature"

Run `/opsx:archive <change-name>` when the implementation is complete, verified and reviewed.
```

**Guardrails**
- Read both the delta spec and the main spec before reporting anything
- Report which existing content archive would preserve; preserve nothing yourself,
  because you write nothing
- If something is unclear, ask for clarification
- Say what archive would change, capability by capability, as you go
- Do not create, edit or delete any file under `openspec/specs/`. `/opsx:archive` is the
  only writer, and running this command twice reports the same preview because it
  changes nothing either time
