---
description: Apply a change - execute its plan task by task with subagents, in its own worktree
argument-hint: <change-name>
effort: medium
---

Apply a change: execute its `plan.md` through `superpowers:subagent-driven-development`, task
group by task group, in the change's worktree. Apply implements; it writes no artifact. Verify
and review come after it.

The rules this command follows are stated in full in the apply instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/apply.md`, which step 5 delivers as `instruction`.
Change selection is stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

A question that needs more than one file opened goes to a read-only agent that returns a
verdict, named `investigate <topic>` with a one-word topic. Read one named file directly. Keep
raw suite and script output out of your context where a pass or fail line answers.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, infer the change from the
conversation; if that is vague or ambiguous, the selection in step 2 asks.

1. **Check that Superpowers is available.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/superpowers.mjs"
   ```

   If `ok` is false, stop. Show `reason` and `install`, and modify nothing.

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

   Stop if the first line is not `<root>`, or if `<root>` is the main checkout: a change with
   no worktree of its own is refused. Read `current` and `protected` from the third result. If
   `current` is null or is listed in `protected`, stop: a commit there would bypass the merge
   request. Keep `current` as the change branch and `protected` for the pushes.

4. **Check the SDD workspace and record the session.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sdd.mjs" --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase apply --root <root>
   ```

   If the first exits non-zero, stop and print its output verbatim. Run it only with the
   resolved name, never a placeholder.

5. **Get the apply instructions.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions apply --change <name> --root <root>
   ```

   Read `state`:
   - `blocked`: name `missingArtifacts` (or the tasks problem `instruction` states) and stop;
     edit no source file. The way forward is `/adf:propose <name>`, which continues the
     artifacts up to the plan; re-running apply will not create them.
   - `all_done`: say every task is complete and stop; the next step is `/adf:verify`.
   - `ready`: continue.

6. **Read the context.** Read every file listed under `contextFiles`, and `guides`; never assume
   a file name. `instruction` is the procedure for steps 7 and 9.

7. **Check the plan against the tree.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-symbols.mjs" <name> --phase apply --root <root>
   ```

   If it exits non-zero, stop and print `findings` verbatim. Dispatch nothing; the plan is
   corrected first.

8. **Show the progress.** Show the schema (`schemaName`), "N/M tasks complete" from `progress`,
   the remaining tasks from `tasks`, and which tasks are test-driven.

9. **Implement.** Follow `instruction` to the end: invoke
   `superpowers:subagent-driven-development`, dispatch by wave into the group worktrees under the
   tree guard, validate every reply, tick each task as it completes, merge, review and remove
   each group and push after each merge, then run the final review, the reuse sweep and the
   whole suite, and commit the test record last. Do not implement a task yourself. Stop where
   the skill would invoke `superpowers:finishing-a-development-branch`.

   Keep each change within its task's **Files:** block. Keep going until every task is done or
   apply is blocked. Pause, report and wait in these cases; never guess:
   - a task is ambiguous, or a requirement unclear: ask before it is dispatched;
   - the implementation shows that an artifact is wrong: name the artifact and suggest the
     update;
   - a task would change a file outside its `**Files:**` block for a reason the instruction does
     not cover;
   - a blocker, an error, a refused tree guard, a blocked group, an open sweep finding, or a
     suite failure that does not also fail on the base.

   If a skill cannot be invoked, stop and report which one is missing (see the apply
   instruction).

10. **Report.** Show the tasks completed this session and "N/M tasks complete", then one of:

    ```text
    ## Implementation Complete

    **Change:** <name>
    **Schema:** <schema name>
    **Progress:** M/M tasks complete

    ### Completed This Session
    - [x] <task>

    Whole suite: <passed | failed only where the base fails too, named as separate work | not run, and why>
    Pushed: <after each group merge | no forge plugin is enabled, nothing was pushed | degraded: hint>
    Open debt: <count from ledger.mjs list --unresolved-debt>

    Run /adf:verify, then the review, before archiving this change.
    ```

    ```text
    ## Implementation Paused

    **Change:** <name>
    **Schema:** <schema name>
    **Progress:** N/M tasks complete

    ### Issue Encountered
    <the issue; a blocked group with its kept worktree>

    **Options:**
    1. <option>
    2. <option>
    3. Other approach

    What would you like to do?
    ```

    End with what is blocked on the developer, if anything, and the next step: `/adf:verify`.
