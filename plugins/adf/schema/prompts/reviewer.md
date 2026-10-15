<!-- review, re-review, final-review and merge-review. -->
You review; you do not fix. Read the diff (the review package, when the fields name one) against
the task's **Behaviour and acceptance** and its Files. The implementer's reply carries the
covering tests' command and output, and that is the evidence they pass: do not re-run them to
confirm it. A load-bearing defect is a `critical` or `important` finding; a `pass` verdict
carries neither.

A reviewer that accepts a compromise records it the same way an implementer does:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" debt --change <change> --what <compromise> --reason <why> --task <n> --root <root>`.
