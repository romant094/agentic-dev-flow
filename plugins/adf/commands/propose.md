---
description: Propose a change - make its branch and worktree, then write every artifact up to the plan. Triggers may be phrased in any language.
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

Run every script call below as one plain command per Bash call, and read its JSON from the
output: the rules for tools are stated in full under `## Tools` in
`${CLAUDE_PLUGIN_ROOT}/schema/prompts/frame.md`, and they bind this session too.

A question that needs more than one file opened goes to a read-only agent that returns a
verdict, named `investigate <topic>` with a one-word topic. Read one named file directly.

**Input:** `$ARGUMENTS` is the change name in kebab-case, or a description of the change, and
any tracker keys the change works on.

1. **Get the change name.** If the input is a kebab-case name, use it and ask nothing.
   Otherwise ask one open question, with no preset options: "What change do you want to work
   on? Describe what you want to build or fix." Derive a kebab-case name from the answer. Do not
   continue without understanding what is to be built. Keep any tracker keys the input names,
   and the description as the phrase.

2. **Check that Superpowers is available.** From the main checkout, run the preflight:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase propose --change <name>
   ```

   If `ok` is false, show `refusal` and create nothing; for uncommitted work, also show
   `git status`. If `workspace.exists`, the change is in flight: ask whether to continue it there
   or to choose another name. To continue, `workspace.path` is the root; make it the active
   change there with `changes.mjs active --change <name> --root <root>`, as the resolve
   instruction states, and go to step 8.

3. **Gather the scope.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" gather --change <name> [--keys K1,K2] [--text "<phrase>"]
   ```

   Show `report`. If `empty`, go to step 6. If `tracker.state` is `degraded`, ask the developer
   to fix it and run gather again, or to give a reason and run gather again with
   `--skip-tracker "<reason>"`. With a tracker enabled and neither keys nor a phrase, ask once
   for the keys, or none. The rules: `schema/instructions/propose.md`, "The scope is gathered
   before the branch is named".

4. **Select the scope.** Show the items and propose which fit this change; the developer
   decides. Record it, and repeat until `undecided` is empty:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" select --change <name> --take K1,K2 [--partial "<KEY>: <reason>"] [--exclude "<KEY>: <reason>"] [--rest "<reason>"]
   ```

5. **Check each taken or partial item.** Write the inputs:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" check-input --change <name>
   ```

   For each entry of `dispatches`, dispatch a read-only agent named `name` at `agent`, with the
   text of `promptFile` as its prompt, all in parallel. Check each reply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" check --change <name> --key <KEY> --file <replyFile>
   ```

   On a refusal, send `errors` to the same agent once; after a second refusal, ask the developer
   about the item. Put every question of every item to the developer in one message. Record
   each answer, then the verdict:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" answer --change <name> --key <KEY> --question <n> --answer "<text>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" answer --change <name> --key <KEY> --verdict current|corrected|obsolete [--reason "<text>"]
   ```

   Then send the bugs that do not reproduce to a retest. Run
   `scope.mjs retest --change <name>`; when `state` is `pending`, show `report` and ask for a yes;
   on the yes, run it again with `--yes`.

6. **Choose the base and the branch.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" suggest --change <name>
   ```

   On `keyChoices`, ask which key names the branch and run suggest again with `--key <KEY>`.
   Ask the developer, in one question, for the base (`bases`; offer `current` only when it is
   listed, and name both branches) and for the branch name (`branch`, or ask for the type when
   it is null). Wait for an explicit answer.

7. **Make the branch, the worktree and the change.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" create --change <name> --branch <branch> --base <integration|current>
   ```

   If it refuses, show `refusal` or `error` and stop. Otherwise `root` is the worktree, and the
   change is its active change (`active`), so the later commands need no name. Every later step
   passes `--root <root>`. Say: "Working on `<branch>` in `<root>`, base `<base>`."
   When the scope holds a tracker item, start it: run `scope.mjs start --change <name>`, show
   `report`, and when `state` is `pending` ask for a yes, then run it again with `--yes`.

8. **Write the artifacts.** Track them with the todo tool. Repeat:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" next --change <name> --root <root>
   ```

   - `done: true`: go to step 9.
   - `ok: false` with `blockedBy`: fix what its `gates` report in that artifact, run the `done`
     command the `refusal` names, and repeat.
   - Otherwise `artifact` is the next one to write:
     1. Read every file in `dependencyFiles`.
     2. Follow `instructions.instruction`, with `instructions.template` as the structure and
        `context`, `rules` and `guides` as constraints.
     3. Write to `instructions.resolvedOutputPath`; never assume a path. For an `optional`
        artifact the change does not need, run the skip command `optionalNote` names instead.
     4. For the proposal, when `create` reported `scope`, run
        `scope.mjs render --change <name> --root <root>` first: it writes the
        `## Scope sources` section.
     5. Run the command in `then`. If it refuses, fix what it reports and run it again. Say
        "Created <id>".

   If the context is unclear, ask the developer; otherwise make a reasonable decision and
   continue.

9. **Commit the artifacts.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" commit --change <name> --root <root>
   ```

   If it refuses, show `refusal` or `error` and stop.

10. **Open the merge request.** Write the summary as `<scope>: <description>` for the change,
   with no draft prefix. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --change <name> --root <root> --summary "<scope>: <description>"
   ```

   On `refused`, the artifacts stay committed; do not retry with other input. Keep its
   `report`, the merge request line(s).

11. **Report.** Show the `report` of this call as it is, then step 10's `report` as it is:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" status --change <name> --root <root> --report
   ```
