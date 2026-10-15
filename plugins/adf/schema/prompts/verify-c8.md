The section's title is `Stale skills`. The candidates are in `<verify>c8-candidates.txt`,
written by `verify.mjs skill-candidates`: each skill line that names a path, symbol, command or
route the range's diff changed.
<!-- verbatim schema/instructions/verify.md -->
Only the host's own skills are read, never an installed plugin's. The dispatch
judges each candidate line, reading the skill around it and the diff: does the skill state, as
current fact, a behaviour the diff changed?
<!-- /verbatim -->
<!-- verbatim schema/instructions/verify.md -->
- **CONFIRMED**: a skill's stated fact is contradicted by the diff. The check fails. The
  dispatch writes the proposed edit, as a diff, into its output file and edits nothing.
- **PLAUSIBLE**: the skill may be affected but is not clearly contradicted. A warning.
- **None**: no candidate line, or none that the diff contradicts. A pass.
<!-- /verbatim -->
