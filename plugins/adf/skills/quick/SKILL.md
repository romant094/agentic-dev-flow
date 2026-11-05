---
name: quick
description: Fix a small defect that changes no behaviour - one quick.md, its own branch and worktree, the affected tests, one short review and a merge request. Triggers on "quick fix", "fix this bug quickly", "quick task". Triggers may be phrased in any language.
argument-hint: <key, phrase, list or a change name>
effort: medium
---
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.


Run a quick task: a small fix that restores specified behaviour, or a small addition of the same
kind, such as a missing log line. It is a change of the quick cycle: one file,
`openspec/changes/<name>/quick.md`, with the goal, the scope, a short plan that the
`quick-plan` gate holds to at most three numbered steps and, at the end, the summary. It writes
no proposal, specs, tasks, plan or verify record, and never `openspec/specs/`. A change to what the system does is `/adf:propose`. The quick task takes one
path and has no flags.

The rules of `quick.md` are stated in full in
`${CLAUDE_PLUGIN_ROOT}/schema/quick/instructions/quick.md`; the rules of the end, in
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/archive.md`. Read each before the step that uses it.

Run every script call below as one plain command per Bash call, and read its JSON from the
output: the rules for tools are stated in full under `## Tools` in
`${CLAUDE_PLUGIN_ROOT}/schema/prompts/frame.md`, and they bind this session too.

Each step below is one script call, or a dispatch whose prompt one script call writes; what is
yours is the code, `quick.md`, the judgement on each result and the talk with the developer.
This session writes the code itself and dispatches no implementer. Show every `report` a script
returns as it is: a role or a hook that no enabled plugin provides is skipped, and its report
says so and names the role (tracker, forge, knowledge, `provision`, `teardown`).

**Input:** `$ARGUMENTS` is one of: `list`; the name of a quick change in flight; tracker keys
and a phrase that describes the defect; or nothing.

**The stop rule.** When you find, while you plan or write, that the fix changes behaviour or
needs a fourth plan step, stop. Say why, and offer `/adf:propose`. The branch and `quick.md`
stay for the developer to keep or remove.

1. **List or resume.** For `list`, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find
   ```

   For each change it lists, run `changes.mjs status --change <name> --root <its root>`, and keep
   those whose `schemaName` is `quick`. Show each with its root and branch, then stop.

   For a kebab-case name, first run `archive.mjs state --change <name>` from the main checkout.
   When a step's state is not `pending`, the end is under way: resume at step 9, with the root
   `changes.mjs active --change <name>` gives (with `--archived` once `move` has run), or the
   main checkout once `remove` has run.
   Otherwise, for a name that `find` lists, run `changes.mjs status
   --change <name> --root <root>`. A `schemaName` other than `quick` is a change of the full
   cycle: say so, name its next command, and stop. Otherwise resume at the first open step:

   - `quick` not `done` in `status`: step 6.
   - `openspec/changes/<name>/review.md` committed, and `review.mjs check --file <it>` gives
     `verdict` `PASS`: step 9.
   - Otherwise compare the plan's steps with `git -C <root> log --oneline` since the base. A
     step without its commit: step 6, at that step. Every step committed: step 7.

   A name that neither lists is a new change: go on to step 2 with it as the name.

2. **Get the change name and the input.** With neither a key nor a phrase, ask one open question:
   "Which defect? Name a tracker key or describe it in a phrase, or answer none to list the open
   bugs." Unless step 1 gave the name, derive a kebab-case name from the phrase; with keys only,
   from the keys, in lower case; for the open bugs, `bugs-<YYYYMMDD>` of today. Say the name.

3. **Gather the scope.** From the main checkout. For the open bugs:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" gather --change <name> --bugs
   ```

   With keys or a phrase, ask once whether to gather the context: the tracker search and the
   debt store. On a yes, run gather with `--keys K1,K2` and `--text "<phrase>"`. On a no, run it
   with the keys alone; with no keys, run nothing and go to step 5.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" gather --change <name> [--keys K1,K2] [--text "<phrase>"]
   ```

   Show `report`. When it says the tracker plugin has no bugs operation, ask again for a key or
   a phrase, and gather again with them. When `tracker.state` is `degraded`, ask the developer to
   fix the tracker and gather again, or for a reason; on a reason, gather again with
   `--skip-tracker "<reason>"`. A run that takes only debt entries goes on this way. If `empty`,
   go to step 5.

4. **Estimate and select.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/quick.mjs" filter --change <name>
   ```

   Show `excluded` and `flagged`. When `candidates` is empty, offer `/adf:propose` and stop.
   Then write the estimate's input:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/quick.mjs" estimate-input --change <name>
   ```

   Dispatch one read-only agent named `quick-estimate` at `agent`, with the text of `file` as its
   prompt. Check its reply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/quick.mjs" estimate-check --change <name> --file <replyFile>
   ```

   On a refusal, send `errors` to the same agent once; after a second refusal, take the
   candidates to `/adf:propose`. Show each item's `fit`, `reason` and `files`. The developer
   selects; an item of fit `propose` is offered to `/adf:propose`, never taken here. Record the
   selection, and repeat until `undecided` is empty:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" select --change <name> --take K1,K2 [--exclude "<KEY>: <reason>"] [--rest "<reason>"]
   ```

5. **Make the branch, the worktree and the change.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase propose --change <name>
   ```

   If `ok` is false, show `refusal` and create nothing. If `workspace.exists`, the change is in
   flight: resume it as in step 1. Then the branch:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" suggest --change <name>
   ```

   On `keyChoices`, ask which key names the branch and run suggest again with `--key <KEY>`. Ask
   the developer, in one question, for the base (`bases`) and the branch name (`branch`, or the
   type when it is null). Wait for an explicit answer. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" create --change <name> --branch <branch> --base <integration|current> --schema quick
   ```

   It also records the phases `gather` and `estimate` in the ledger. If it refuses, show
   `refusal` or `error` and stop. `root` is the worktree: every later step passes `--change
   <name> --root <root>` and runs git with `git -C <root>`. Say: "Working on `<branch>` in
   `<root>`, base `<base>`." Provision the worktree and show its `report`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" provision --change <name> --root <root>
   ```

   When the scope holds a tracker item, run `scope.mjs start --change <name>`, show `report`,
   and when `state` is `pending` ask for a yes, then run it again with `--yes`. Open the Draft
   merge request with the summary `<scope>: <description>`, and keep its `report`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --change <name> --root <root> --summary "<scope>: <description>"
   ```

   Then record the phase:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase code --root <root>
   ```

6. **Plan and write the code.** Get the template and the instruction:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions quick --change <name> --root <root>
   ```

   Write `## Goal`, `## Scope` and `## Plan` of `quick.md` at `resolvedOutputPath`, and leave
   `## Summary` empty. Then run its gate and commit it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" done quick --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" commit --change <name> --root <root>
   ```

   On a refusal, correct `quick.md` from the failed gate and run both again. Then write the code
   of each plan step, and commit it as one commit of the step's files:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/commit.mjs" --root <root> --only <path> [--only <path> ...] --message "<type>(<scope>): <what was wrong and why>"
   ```

7. **Run the affected tests.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase tests --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/quick.mjs" tests --change <name> --root <root>
   ```

   On `waiting`, read the project's test runner (the `package.json` scripts, the `Makefile`, the
   CI configuration) and propose one command with `{files}` where the paths go. On the
   developer's yes, write it as one line in backticks under `## Affected tests command` of
   `<root>/openspec/planning.md`, commit that file alone with `commit.mjs` and the message
   `chore(flow): the affected tests command`, and run `quick.mjs tests` again. On a no, report
   that no affected tests ran. On a failure, fix the code, commit the fix, and run the tests
   again.

8. **Review the branch.** One round:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase review --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" start --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" round --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" input --round 1 --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <name> --role ai-review --round 1 --root <root>
   ```

   `recordStands: true` from `start`: the record stands; go to step 9. An empty diff: run
   `review.mjs assemble --not-reviewed "<reason>" --commit` and go to step 9. Otherwise dispatch
   `ai-review r1` at `agent` with the printed `prompt`, and store its reply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" response --change <name> --round 1 --file <reply json> --root <root>
   ```

   Retry an invalid reply once, as `next` and `mode` say. Fix each blocking finding yourself, in
   the order `review.mjs fixplan --change <name> --round 1 --root <root>` lists them. Commit each
   fix with `commit.mjs`, touching only the finding's file and its tests. Write the reply with
   Write, as `schema/review-fix.schema.json` states it:
   `{ "finding": "F<n>", "outcome": "fixed", "sha": "<commit>", "failureMode": "<what failed>" }`.
   Record it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" fix --change <name> --round 1 --finding F<n> --file <fix json> --root <root>
   ```

   A finding you judge false goes to the developer with your argument; record their ruling and
   its disposition as the review instruction states. Give each non-blocking finding left as it
   is a `review.mjs disposition --as recorded` with its body. After the last fix, run
   `quick.mjs tests --change <name> --root <root>` again. Then assemble and commit the record:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" assemble --change <name> --commit --root <root>
   ```

   On `refusals`, run the calls they name and assemble again. A finding a second round would need
   goes to `/adf:propose`. Show the `report`.

9. **End the change.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase end --root <root>
   ```

   Write `## Summary` of `quick.md`: what was wrong, what changed, the tests run, and the
   review's result, with what was fixed and what was not. Leave it uncommitted: `commit-specs`
   commits it with the move, and a commit of it after the review record makes `check` refuse.
   Then run the archive's steps, one at a time, as `next` gives them:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" next --change <name> --root <root>
   ```

   Run each step as `archive.mjs <step> --change <name> --root <root>`, with what the
   instruction's rule for that step gives it:
   - `check`, `placements`: as the instruction states. A spec scenario that the fix shows missing
     goes to the debt store with `debt.mjs add`.
   - `merge`: the call alone; it is skipped with the reason `quick task`.
   - `ingest`: `ingest.mjs stale`, then dispatch `ingest` and pass its reply as `--reply`; with
     no knowledge plugin, the call with no reply.
   - `mr`: `forge.mjs check`; with a forge, write the body from `archive.mjs mr-input`: its
     `goal`, `summary` and `plan`. Its QA section takes the plan's **Check:** lines and the
     affected tests record, `.superpowers/sdd/<name>/quick/tests.json`. The scope's keys stay
     out of the body: `links` carries them. Pass `--body` and `--summary`.
   - `merge-local`: the call shows the commands; ask the developer, then `--yes` or `--no`.
   - The rest: the call alone. After `remove`, pass `--root <main>`.

   On `ok: false`, show the step's `refusal` and `detail` and stop, unless the instruction's rule
   for the step settles it here. Push nothing yourself.

10. **Report.**

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" report --change <name> --root <main>
    ```

    Show its `report` as it is. Then tell the developer: after the merge request is merged, run
    `/adf:land <name>`.
