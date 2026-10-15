---
description: Propose a change - make its branch and worktree, then write every artifact up to the plan
argument-hint: <change-name or description>
effort: high
---

Propose a change: the single entry point for a feature or for a change to what the system does.
Its brainstorm covers exploration. A fix that restores already-specified behaviour, a typo,
formatting or a dependency bump is made directly instead; if such a "fix" changes what the
system should do, stop and propose it.

This command writes, under `openspec/changes/<name>/`: `brainstorm.md`, `proposal.md`,
`design.md` (optional), `specs/**/*.md`, `tasks.md` and `plan.md`. `verify.md` and `review.md`
are written later, by their own phases, not here.

The rules this command follows are stated in full in
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/propose.md`. Read it before step 1.

A question that needs more than one file opened goes to a read-only agent that returns a
verdict, named `investigate <topic>` with a one-word topic. Read one named file directly.

**Input:** `$ARGUMENTS` is the change name in kebab-case, or a description of the change.

1. **Get the change name.** If the input is a kebab-case name, use it and ask nothing.
   Otherwise ask one open question, with no preset options: "What change do you want to work
   on? Describe what you want to build or fix." Derive a kebab-case name from the answer. Do not
   continue without understanding what is to be built.

2. **Check that Superpowers is available.** From the main checkout, run the preflight:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase propose --change <name>
   ```

   If `ok` is false, show `refusal` and create nothing; for uncommitted work, also show
   `git status`. Otherwise read `workspace`:
   - If `workspace.exists`, the change is in flight: ask whether to continue it there or to
     choose another name. To continue, `workspace.path` is the root; go to step 4.
   - Ask the developer, in one question, for the base (`workspace.bases`; offer `current` only
     when it is listed, and name both branches) and for the branch name (`workspace.branch`, or
     ask for the type when it is null). Wait for an explicit answer.

3. **Make the branch, the worktree and the change.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" create --change <name> --branch <branch> --base <integration|current>
   ```

   If it refuses, show `refusal` or `error` and stop. Otherwise `root` is the worktree. Every
   later step passes `--root <root>`. Say: "Working on `<branch>` in `<root>`, base `<base>`."

4. **Write the artifacts.** Track them with the todo tool. Repeat:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" next --change <name> --root <root>
   ```

   - `done: true`: go to step 5.
   - `ok: false` with `blockedBy`: fix what its `gates` report in that artifact, run the `done`
     command the `refusal` names, and repeat.
   - Otherwise `artifact` is the next one to write:
     1. Read every file in `dependencyFiles`.
     2. Follow `instructions.instruction`, with `instructions.template` as the structure and
        `context`, `rules` and `guides` as constraints.
     3. Write to `instructions.resolvedOutputPath`; never assume a path. For an `optional`
        artifact the change does not need, run the skip command `optionalNote` names instead.
     4. Run the command in `then`. If it refuses, fix what it reports and run it again. Say
        "Created <id>".

   If the context is unclear, ask the developer; otherwise make a reasonable decision and
   continue.

5. **Commit the artifacts.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" commit --change <name> --root <root>
   ```

   If it refuses, show `refusal` or `error` and stop.

6. **Open the merge request.** Write the summary as `<scope>: <description>` for the change,
   with no draft prefix. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --change <name> --root <root> --summary "<scope>: <description>"
   ```

   On `refused`, the artifacts stay committed; do not retry with other input. Keep its
   `report`, the merge request line(s).

7. **Report.** Show the `report` of this call as it is, then step 6's `report` as it is:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" status --change <name> --root <root> --report
   ```
