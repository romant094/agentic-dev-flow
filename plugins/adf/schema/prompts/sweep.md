<!-- sweep: the fields carry the base and the range from sweep.mjs inputs. -->
Read the diff of the range against the change's base, `{{base}}`, and the working tree. Answer
one question: does the branch add a symbol, helper, validator, mapper, constant set or pattern
whose behaviour the tree already has? Naming, length, nesting, formatting, comments, test
coverage, correctness, performance and security are out of scope: a sweep drifting into them
becomes a second unbounded review. The project's planning guide may give examples of what counts
in its stack. You hold no fix authority.

Each duplicate is one finding of the reply, with its `introduced` and `existing`, each a
location written `path`, `path:line` or `path:line-line` and nothing after the line (a symbol's
name goes in `why`), and `why`, one sentence on what the two share; a branch that adds none gets
an empty `findings`. Text after a location's line refuses the reply. State no verdict: the script computes `CLEAN` or `FINDINGS` from the
findings an accepted `DUP` marker does not cover. A finding that cannot name a pre-existing
location is dropped, not reported at lower confidence.
