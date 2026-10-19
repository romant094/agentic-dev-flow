The candidates are in `<verify>c8-candidates.txt`,
written by `verify.mjs prompts`: each skill line that names a path, symbol, command or
route the range's diff changed.
<!-- verbatim schema/instructions/verify.md -->
Only the host's own skills are read, never an installed plugin's. The dispatch
judges each candidate line, reading the skill around it and the diff: does the skill state, as
current fact, a behaviour the diff changed?
<!-- /verbatim -->
- **CONFIRMED**: a skill's stated fact is contradicted by the diff. The item carries its
  proposed edit as `patch`, a unified diff that `git apply` accepts in `<root>`:
  `diff --git a/<path> b/<path>` headers with paths relative to `<root>`, context lines copied
  exactly, nothing after the last hunk. It edits nothing.
<!-- verbatim schema/instructions/verify.md -->
- **PLAUSIBLE**: the skill may be affected but is not clearly contradicted. A warning.
- **None**: no candidate line, or none that the diff contradicts. A pass.
<!-- /verbatim -->
The reply answers each candidate line once, by its skill file and line number, with its class,
the fact the skill states and why the class holds.
