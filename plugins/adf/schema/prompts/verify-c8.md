The section's title is `Stale skills`.
<!-- verbatim schema/instructions/verify.md -->
Compare the range's diff with every `<root>/.claude/skills/*/SKILL.md`, and the `README.md` and
manifest beside it where present: does a skill state, as current fact, a behaviour the diff
changed? Only the host's own skills are read, never an installed plugin's.

- **CONFIRMED**: a skill's stated fact is contradicted by the diff. The check fails. The
  dispatch writes the proposed edit, as a diff, into its output file and edits nothing.
- **PLAUSIBLE**: the skill may be affected but is not clearly contradicted. A warning.
- **None**: the diff touches nothing any skill documents as current fact. A pass.
<!-- /verbatim -->
