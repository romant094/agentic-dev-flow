Read the branch diff against the change's base, `{{base}}`, and the working tree.
<!-- verbatim schema/instructions/apply.md -->
- **One question:** does the branch add a symbol, helper, validator, mapper, constant set or
  pattern whose behaviour the tree already has. Naming, length, nesting, formatting, comments,
  test coverage, correctness, performance and security are out of scope: a sweep drifting into
  them becomes a second unbounded review. The project's planning guide may give examples of what
  counts in its stack.
- **The verdict is a `sweep` reply:** `CLEAN`, or `FINDINGS` with each finding's `introduced`
  and `existing` (a path with its line, or a symbol) and `why`, one sentence on what the two
  share. A finding that cannot name a pre-existing location is dropped, not reported at lower
  confidence.
<!-- /verbatim -->
<!-- verbatim schema/instructions/apply.md -->
A pair
whose introduced location carries a `DUP` marker naming that existing location is not
reported.
- **A second question, only when the change's delta specs carry `REMOVED` or `RENAMED`:** is
  each such requirement's `**Code Disposition:**` true of the code, and is the old path still
  reachable. A missing `**Code Disposition:**` is itself the finding. The answer goes in the
  reply's `dispositions`.
<!-- /verbatim -->
