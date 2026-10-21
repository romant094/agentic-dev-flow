---
description: Apply a change - execute its plan task by task with subagents, in its own worktree
argument-hint: <change-name>
effort: medium
---

Apply a change: execute its `plan.md` through `superpowers:subagent-driven-development`, task
group by task group, in the change's worktree. Apply implements; it writes no artifact. Verify
and review come after it.

The rules this command follows are stated in full in the apply instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/apply.md`, which step 3 delivers as `instruction`.
What a dispatched agent is told is stated in full in the prompt skeletons under
`${CLAUDE_PLUGIN_ROOT}/schema/prompts/`, filled by `dispatch.mjs prompt`. Change selection is
stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

A question that needs more than one file opened goes to a read-only agent that returns a
verdict, `dispatch.mjs prompt --role investigate --topic <word>`. Read one named file directly.
Keep raw suite and script output out of your context where a pass or fail line answers.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, infer the change from the
conversation; if that is vague or ambiguous, the selection in step 1 asks.

1. **Select the change.** Follow the resolve instruction: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find`, have the developer confirm the
   change, and say `Using change: <name> in <root>`. From here on, pass `--change <name>
   --root <root>` to every core script and run git with `git -C <root>`.

2. **Check that Superpowers is available.** The preflight runs that gate (the check of
   `scripts/superpowers.mjs`) and every other check apply makes before its first step, in one
   call:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase apply --change <name> --root <root>
   ```

   Run it only with the resolved name, never a placeholder. If `ok` is false, stop, print
   `refusal` verbatim, and modify nothing: a refused gate names its install command, a refused
   place means a commit there would bypass the merge request, and a `blocked` state means edit
   no source file. The way forward is `/adf:propose <name>`, which continues the artifacts up to
   the plan; re-running apply will not create them. `planFindings` are corrected in the plan
   before anything is dispatched. Then provision the change worktree, as the apply instruction
   states:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" provision --change <name> --root <root>
   ```

3. **Get the apply instructions.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions apply --change <name> --root <root>
   ```

   Read every file listed under `contextFiles`, and `guides`; never assume a file name.
   `instruction` is the procedure for step 5.

4. **Show the progress.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-status.mjs" --change <name> --root <root>` and
   show the schema (`schemaName` from step 3), "N/M tasks complete" from `progress`, the
   `remaining` tasks, and the test-driven tasks from `testFirst`.

5. **Implement.** Follow `instruction` to the end: invoke
   `superpowers:subagent-driven-development`, dispatch by wave into the group worktrees under the
   tree guard, validate every reply, tick each task as it completes, merge, review and finish
   each group, then run the final review, the reuse sweep and the whole suite, and commit the
   test record last. Do not implement a task yourself. Stop where the skill would invoke
   `superpowers:finishing-a-development-branch`.

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

6. **Report.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-status.mjs" --change <name> --root <root> --report
   ```

   Show `report` as it is: the Complete block in full, or the Paused block with `<the issue>`
   and each `<option>` written by you. End with what is blocked on the developer, if anything,
   and the next step: `/adf:verify`.
