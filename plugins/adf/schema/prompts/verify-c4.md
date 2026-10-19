<!-- verbatim schema/instructions/verify.md -->
- Every design decision traces to a requirement or a scenario, and every requirement agrees
  with the decisions. Read every decision and requirement, not a sample, and open what a
  decision names: the command, script or skill it changes, including one a command hands
  control to. A row that cites only the file that agrees is no evidence.
- Drift between two documents is a warning, with file and line on both sides. A contradiction
  between two executable surfaces (code, scripts, commands that run) fails.
- No delta specs: the check covers the design against the tasks. No design: it covers the specs
  against the implementation. The section says which case applied.
- A commit in the range that edits a capability's prose above `## Requirements` in
  `openspec/specs/` is listed with the capabilities and the reason the change gives for it; an
  edit with no stated reason is a warning. An edit at or below `## Requirements` fails: only
  archive writes there.
- When a delta carries `REMOVED` or `RENAMED`: each such requirement's `**Code Disposition:**`
  is checked against the code, and the old path against reachability. A disposition the code
  contradicts, a missing one, or an old path still reachable fails. This is the verifier of the
  disposition apply's sweep recorded.
- New mechanisms: for each one the change adds, which of its paths a test or a recorded run
  exercised and which nothing exercised. A green gate never stands in for a path that ran.
<!-- /verbatim -->
The reply carries each issue as a finding of its kind, with a file and a line for each place it
names. `proseEdits` answers each entry of the Prose edits field once, with the reason the change
gives, or null when it gives none. `removalAccounting` answers each entry of the Removed or renamed
field once, by its operation and name: the disposition, null when there is none, whether the code
holds it, and whether the old path is still reachable. `exercised` gives one entry per path of a
new mechanism, with what exercised it, or null when nothing did.
