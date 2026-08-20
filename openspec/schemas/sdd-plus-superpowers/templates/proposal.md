## Why

<!--
Explain the motivation for this change. What problem does this solve? Why now?

Hard limit: 50 <= character count <= 1000 (enforced by the OpenSpec zod schema).
- Too short: `Why section must be at least 50 characters`
- Too long: `Why section should not exceed 1000 characters`

Suggested structure: current pain -> why now -> expected benefit (1-2 sentences each).
-->

## What Changes

<!--
Describe what will change. Be specific about new capabilities, modifications, or removals.

For behaviour changes with a clear before/after, use the From/To format
(markdown has no inline diff):

**<Section or Behavior Name>**
- From: <current state / requirement>
- To: <future state / requirement>
- Reason: <why this change is needed>
- Impact: <breaking / non-breaking, who's affected>

Repeat the block for each change; pure additions or removals can use a plain list.
-->

## Capabilities

### New Capabilities
<!--
Capabilities being introduced. Replace <name> with kebab-case identifier.
Naming rule: use a compound noun of at least two words — `user-auth`,
`data-export`, `api-rate-limiting` — never a single word.
Each creates specs/<name>/spec.md
-->
- `<name>`: <brief description of what this capability covers>

### Modified Capabilities
<!--
Existing capabilities whose REQUIREMENTS are changing (not just implementation).
Only list here if spec-level behavior changes. Each needs a delta spec file.
Use existing spec names from openspec/specs/. Leave empty if no requirement changes.
-->
- `<existing-name>`: <what requirement is changing>

## Impact

<!-- Affected code, APIs, dependencies, systems -->
