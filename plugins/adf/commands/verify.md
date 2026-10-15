---
description: Verify a change - check that the implementation matches its artifacts, and commit the record
argument-hint: <change-name>
effort: medium
---

Verify a change: check that what apply built matches the change's specs, tasks and design, and
write `verify.md`, the record the review reads. Verify runs after apply and before the review.

The rules this command follows are stated in full in the verify instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/verify.md`, which step 5 delivers as `instruction`.
Change selection is stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

A question that needs more than one file opened goes to a read-only agent that returns a
verdict, named `investigate <topic>` with a one-word topic. Read one named file directly. Check
output and test output go into the record through the section files, not through your context:
read verdicts and summaries.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, infer the change from the
conversation; if that is vague or ambiguous, the selection in step 2 asks.

1. **Check that Superpowers is available.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/superpowers.mjs"
   ```

   If `ok` is false, stop. Show `reason` and `install`, and write nothing.

2. **Select the change.** Follow the resolve instruction: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find`, have the developer confirm the
   change, and say `Using change: <name> in <root>`. From here on, pass `--change <name>
   --root <root>` to every core script and run git with `git -C <root>`.

3. **Confirm the worktree and the branch.**

   ```bash
   git -C <root> rev-parse --show-toplevel
   git -C <root> rev-parse --path-format=absolute --git-common-dir
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" suggest --change <name> --root <root>
   ```

   Stop on any refusal the verify instruction names: a first line other than `<root>`, `<root>`
   being the main checkout, or a `current` branch that is null or listed in `protected`.

4. **Record the session.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase verify --root <root>
   ```

5. **Get the verify instructions.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions verify --change <name> --root <root>
   ```

   `instruction` is the procedure for the steps below, `template` the record's shape, and
   `guides` carries the planning guide with the whole-suite command. If a dependency is not
   `done`, the change has no plan yet: stop, and point at `/adf:propose <name>`.

6. **Run the mechanical checks.** Run `verify.mjs run` as the instruction states: `--fresh` on
   the first run of the session, and every approved skill edit's sha. Keep the verdict and the
   summary of each check; leave the output files unread.

7. **Dispatch `verify c4` and `verify c8`** in one response, at the levels the instruction
   names, read-only, each writing its section file.

8. **Resolve stale skills.** Show each CONFIRMED finding's proposed edit to the developer and
   ask. Follow the instruction for an approval (a commit of its own, `verify.mjs run` again
   with `--skill-edit` and without clearing the directory, and `verify c8` again) and for a
   decline (a ruling).

9. **Re-run a stale test record.** If the last run's `test-record` failed, dispatch `verify c6`
   as the instruction states, base check included.

10. **Run the checks that need the developer,** if the plan assigns any to verify, and record
    them as the instruction states.

11. **Compute the verdict.** Run `verify.mjs verdict` as the instruction states. On `refusals`,
    correct the named section or ask the developer for a ruling, and compute again. Record a
    ruling only on the developer's explicit words and reason.

12. **Assemble and commit the record.** Dispatch `verify assemble` with the template, the
    verify directory and the verdict file. Confirm the record's last line is the verdict's
    `line`, then commit `verify.md` alone as the instruction states. Push nothing.

13. **Report.**

    ```text
    ## Verification <PASS | PASS WITH WARNINGS | FAIL>

    **Change:** <name>
    **Record:** openspec/changes/<name>/verify.md, commit <sha>

    Failing: <check ids, each with its summary; or none>
    Warnings: <check ids, each with its summary; or none>
    Accepted by the developer: <check ids with the reason; or none>
    ```

    End with what is blocked on the developer, if anything, and the next step: the review on
    `PASS` or `PASS WITH WARNINGS`; on `FAIL`, the fix the failing checks name and then
    `/adf:verify` again.
