# A direct fix, without the change cycle

A fix that restores behaviour the specs already state, a typo, formatting or a dependency bump
may skip the change cycle. If the fix changes what the system must do, stop and propose a
change instead. A direct fix still leaves a record:

1. The commit message says what was wrong and why.
2. Log a `task` entry. For a fix the commit explains in full, use the one-line form:
   `node <plugin>/scripts/memory.mjs log --type task --title "<the fix>" --commit <sha> --reason "<why>"`.
   When the same task gets more work later in the session, and its entry is not committed
   yet, add `--amend` to replace that entry.
3. Ingest (`ingest.md`) the invariant the fix restored and the test that now covers it, on
   the page of the module it touched.
4. When the bug shows a spec scenario is missing, record it as technical debt in the core's
   debt store. Only archive writes the main specs, so the debt entry is the scenario's one
   home until a change adds it.
