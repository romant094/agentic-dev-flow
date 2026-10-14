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

1. **Check that Superpowers is available.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/superpowers.mjs"
   ```

   If `ok` is false, stop. Show `reason` and `install`, and create nothing (see the propose
   instruction).

2. **Get the change name.** If the input is a kebab-case name, use it and ask nothing.
   Otherwise ask one open question, with no preset options: "What change do you want to work
   on? Describe what you want to build or fix." Derive a kebab-case name from the answer. Do not
   continue without understanding what is to be built.

3. **Make the branch and the worktree.** From the main checkout, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" suggest --change <name>
   ```

   - If `dirty` is not empty, stop: show `git status` and ask the developer to deal with it.
   - If `path` already exists, the change is in flight: ask whether to continue it there or to
     choose another name.
   - Ask the developer, in one question, for the base (`bases`; offer `current` only when it is
     listed, and name both branches) and for the branch name (`branch`, or ask for the type when
     it is null). Wait for an explicit answer. Do not validate the confirmed name.

   Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" create --change <name> --branch <branch> --base <integration|current>
   ```

   If it refuses, show `error` and stop. Otherwise `root` is the worktree. Every later step
   passes `--root <root>` to the core's scripts and runs git with `git -C <root>`. Say:
   "Working on `<branch>` in `<root>`, base `<base>`."

4. **Create the change and record the session.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" new <name> --base <base> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase propose --root <root>
   ```

5. **Read the build order.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" status --change <name> --root <root>
   ```

   Use `applyRequires`, `artifacts` and `artifactPaths`; never assume a path.

6. **Write the artifacts.** Track them with the todo tool. For each artifact whose status is
   `ready`, in order:

   1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions <id> --change <name> --root <root>`.
   2. Read every completed dependency it lists.
   3. Follow `instruction`. Use `template` as the structure. Apply `context`, `rules` and
      `guides` as constraints, and do not copy them into the file.
   4. Write the file to `resolvedOutputPath`. Say "Created <id>".
   5. Run `status` again.

   Gates, stated in full in the propose instruction:

   - When `specs` is done, before `tasks`, run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/specs.mjs" validate --change <name> --root <root>`.
     Fix every invalid item before you continue.
   - When `plan` is done, run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-symbols.mjs" <name> --root <root>`. Do not
     commit until it exits 0.

   Stop when every artifact in `applyRequires` is done. If the context is unclear, ask the
   developer; otherwise make a reasonable decision and continue.

7. **Commit the artifacts.**

   ```bash
   git -C <root> add openspec/changes/<name>
   git -C <root> status --porcelain
   ```

   If anything outside `openspec/changes/<name>/` is staged, stop and show it. Otherwise:

   ```bash
   git -C <root> commit -m "docs(openspec): propose <name>"
   ```

8. **Report.** Run `status` once more, then report:
   - the change name, the branch, the worktree and the base;
   - each artifact created, in one line;
   - that no merge request was opened (no forge plugin is enabled);
   - the next step: `/adf:apply`.
