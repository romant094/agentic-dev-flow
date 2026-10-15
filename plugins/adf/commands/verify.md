---
description: Verify a change - check that the implementation matches its artifacts, and commit the record
argument-hint: <change-name>
effort: medium
---

Verify a change: check that what apply built matches the change's specs, tasks and design, and
write `verify.md`, the record the review reads. Verify runs after apply and before the review.

The rules this command follows are stated in full in the verify instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/verify.md`: read it before step 2. Change selection
is stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

Each step below is one script call, or a dispatch whose prompt one script call writes; what is
yours is the judgement on its result and the talk with the developer. A question that needs more
than one file opened goes to a read-only agent that returns a verdict, named `investigate
<topic>` with a one-word topic. Read one named file directly. Check output and test output go
into the record through the section files, not through your context: read verdicts and
summaries.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, infer the change from the
conversation; if that is vague or ambiguous, the selection in step 1 asks.

1. **Select the change.** Follow the resolve instruction: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find`, have the developer confirm the
   change, and say `Using change: <name> in <root>`. From here on, pass `--change <name>
   --root <root>` to every core script and run git with `git -C <root>`.

2. **Run the preflight.** `preflight.mjs --phase verify`, as the instruction states. On
   `ok: false`, stop: show `refusal`, which names the remedy, and write nothing.

3. **Run the mechanical checks.** `verify.mjs run`, as the instruction states. Keep the verdict
   and the summary of each check; leave the output files unread.

4. **Dispatch `verify c4` and `verify c8`** in one response. First run `verify.mjs
   skill-candidates`, then write each prompt with `dispatch.mjs prompt --role verify --check
   <c4|c8>` and dispatch it to the agent the result names.

5. **Re-run a stale test record.** If `test-record` failed, run `suite.mjs run --section
   test-record --base-check`, as the instruction states. No agent runs the suite.

6. **Resolve stale skills.** Show each CONFIRMED finding's proposed edit to the developer and
   ask. On an approval, apply the edit and run `verify.mjs skill-edit`, then step 4's `verify
   c8` again; on a decline, record a ruling.

7. **Run the checks that need the developer,** if the plan assigns any to verify, and record
   each with `verify.mjs developer`.

8. **Compute the verdict.** `verify.mjs verdict --report`. On `refusals`, act on `redispatch`,
   `needsRuling` and `rerun` as the instruction states, and compute again. Record a ruling only
   on the developer's explicit words and reason.

9. **Assemble and commit the record.** `verify.mjs assemble --commit`. Push nothing.

10. **Report.** Show the `report` that `assemble` returned. End with what is blocked on the
    developer, if anything; the report carries the next step: the review on `PASS` or `PASS
    WITH WARNINGS`; on `FAIL`, the fix the failing checks name and then `/adf:verify` again.
