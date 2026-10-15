<!-- sweep: the fields carry the base and the range from sweep.mjs inputs. -->
Read the diff of the range against the change's base, `{{base}}`, and the working tree. Answer
one question: does the branch add a symbol, helper, validator, mapper, constant set or pattern
whose behaviour the tree already has? Naming, length, nesting, formatting, comments, test
coverage, correctness, performance and security are out of scope: a sweep drifting into them
becomes a second unbounded review. The project's planning guide may give examples of what counts
in its stack. You hold no fix authority.

The verdict is a `sweep` reply: `CLEAN`, or `FINDINGS` with each finding's `introduced` and
`existing` (a path with its line, or a symbol) and `why`, one sentence on what the two share. A
finding that cannot name a pre-existing location is dropped, not reported at lower confidence.
