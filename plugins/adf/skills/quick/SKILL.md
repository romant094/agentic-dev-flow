---
name: quick
description: Fix a small defect that changes no behaviour - one quick.md, its own branch and worktree, the affected tests, one short review and a merge request. Triggers on "quick fix", "fix this bug quickly", "quick task". Triggers may be phrased in any language.
argument-hint: <key, phrase, list or a change name>
effort: medium
---
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.


Run a quick task: a small fix that restores specified behaviour, or a small addition of the same
kind, such as a missing log line. A quick task is a change of the quick cycle. Its one file is
`openspec/changes/<name>/quick.md`: the goal, the scope, a short plan and, at the end, the
summary. The `quick-plan` gate holds the plan to at most three numbered steps. A quick task
writes no proposal, specs, tasks, plan or verify record, and never `openspec/specs/`. A change
to what the system does is `/adf:propose`. The quick task takes one path and has no flags.

The rules of `quick.md` are stated in full in
`${CLAUDE_PLUGIN_ROOT}/schema/quick/instructions/quick.md`. The rules of the review are in
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/review.md`, and the rules of the end in
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/archive.md`. Read each before the step that uses it.

Run every script call below as one plain command per Bash call, and read its JSON from the
output: the rules for tools are stated in full under `## Tools` in
`${CLAUDE_PLUGIN_ROOT}/schema/prompts/frame.md`, and they bind this session too.

Each step below is one script call, or a dispatch whose prompt one script call writes. What is
yours: the code, `quick.md`, the judgement on each result and the talk with the developer.
This session writes the code itself and dispatches no implementer. Show every `report` a script
returns as it is. A role or a hook that no enabled plugin provides is skipped. Its report says
so and names the role: tracker, forge, knowledge, `provision` or `teardown`.

**Input:** `$ARGUMENTS` is one of: `list`; the name of a quick change in flight; tracker keys
and a phrase that describes the defect; or nothing.

**The stop rule.** You can find, while you plan or write, that the fix changes behaviour. You
can also find that it needs a fourth plan step. Then stop, say why, and offer `/adf:propose`.
The branch and `quick.md` stay for the developer to keep or remove.

1. **List or resume.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find
   ```

   For `list`: for each change that `find` lists, run `changes.mjs status --change <name>
   --root <its root>`. Keep the changes whose `schemaName` is `quick`. Show each with its root
   and branch, then stop.

   For a kebab-case name, run `archive.mjs state --change <name>` from the main checkout. A
   step whose state is not `pending` means the end is under way: resume at step 9. Its root is
   the root that `find` lists for the change. With no such root, the root is the main checkout.

   Otherwise, a name that `find` lists is a change in flight; `<root>` is its root. Run
   `changes.mjs status --change <name> --root <root>`. A `schemaName` other than `quick` is a
   change of the full cycle: say so, name its next command, and stop. For a quick change, find
   the first open step:

   - `ledger.mjs list --change <name> --root <root>` holds no `session` record of phase `code`:
     resume at step 5, after `propose.mjs create`.
   - `quick` is not `done` in `status`: resume at step 6.
   - `openspec/changes/<name>/review.md` is committed, and `review.mjs check --file <it>` gives
     `verdict` `PASS`: resume at step 9.
   - `<root>/.superpowers/sdd/<name>/review/r1/` exists: resume at step 8, at the round.
   - Compare the plan's steps with `git -C <root> log --oneline` since the base. A step with no
     commit: resume at step 6, at `forge.mjs open`. Every step has its commit: resume at step 7.

   A name that neither call lists is a new change: go on to step 2 with it as the name.

2. **Get the change name and the input.** With neither a key nor a phrase, ask one open question:
   "Which defect? Name a tracker key or describe it in a phrase, or answer none to list the open
   bugs." Then name the change in kebab case, unless step 1 gave the name:
   - from the phrase;
   - with keys only, from the keys in lower case;
   - for the open bugs, `bugs-<YYYYMMDD>-<HHMM>` in local time.

   Say the name.

3. **Gather the scope.** From the main checkout. For the open bugs:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" gather --change <name> --bugs
   ```

   With keys or a phrase, ask once whether to gather the context: the tracker search and the
   debt store. On a yes, run gather with `--keys K1,K2` and `--text "<phrase>"`. On a no, run it
   with the keys alone. With no keys, run nothing and go to step 5.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" gather --change <name> [--keys K1,K2] [--text "<phrase>"]
   ```

   Show `report`. When it says that the tracker plugin has no bugs operation, ask again for a
   key or a phrase. Then gather again with them. When `tracker.state` is `degraded`, ask the
   developer to fix the tracker, or for a reason. After a fix, gather again. On a reason, gather
   again with `--skip-tracker "<reason>"`. A run that takes only debt entries goes on this way.
   If `empty`, go to step 5.

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

   On a refusal, send `errors` to the same agent once. After a second refusal, take the
   candidates to `/adf:propose`. Show each item's `fit`, `reason` and `files`. The developer
   selects. Offer an item of fit `propose` to `/adf:propose`; this task never takes it. Record
   the selection, and repeat until `undecided` is empty:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scope.mjs" select --change <name> --take K1,K2 [--exclude "<KEY>: <reason>"] [--rest "<reason>"]
   ```

5. **Make the branch, the worktree and the change.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase propose --change <name>
   ```

   If `ok` is false, show `refusal` and create nothing. If `workspace.exists`, the change is in
   flight: resume it as in step 1. Then get the branch:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" suggest --change <name>
   ```

   On `keyChoices`, ask which key names the branch, and run suggest again with `--key <KEY>`.
   Ask the developer, in one question, for the base (`bases`) and the branch name. The name is
   `branch`; when it is null, ask for the type. Wait for an explicit answer. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" create --change <name> --branch <branch> --base <integration|current> --schema quick
   ```

   It also records the phases `gather` and `estimate` in the ledger. If it refuses, show
   `refusal` or `error` and stop. `root` is the worktree. Every later step passes `--change
   <name> --root <root>`, and runs git with `git -C <root>`. Say: "Working on `<branch>` in
   `<root>`, base `<base>`." Provision the worktree, and show its `report`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" provision --change <name> --root <root>
   ```

   When the scope holds a tracker item, run `scope.mjs start --change <name>` and show
   `report`. When `state` is `pending`, ask for a yes, then run it again with `--yes`. Then
   record the phase:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase code --root <root>
   ```

6. **Plan, open the merge request, and write the code.** Get the template and the instruction:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" instructions quick --change <name> --root <root>
   ```

   Write `## Goal`, `## Scope` and `## Plan` of `quick.md` at `resolvedOutputPath`. Leave
   `## Summary` empty. Then run its gate, and commit the change directory:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" done quick --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/propose.mjs" commit --change <name> --root <root>
   ```

   On a refusal, correct `quick.md` from the failed gate, and run both again. Then open the
   Draft merge request with the summary `<scope>: <description>`. Keep its `report`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" open --change <name> --root <root> --summary "<scope>: <description>"
   ```

   On a resume, this call reuses the open merge request. Then write the code of each plan
   step. Commit each step as one commit of its files:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/commit.mjs" --root <root> --only <path> [--only <path> ...] --message "<type>(<scope>): <what was wrong and why>"
   ```

7. **Run the affected tests.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase tests --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/quick.mjs" tests --change <name> --root <root>
   ```

   - `skipped`: say that the branch changed no file, so no test ran, and go on.
   - `waiting`: read the project's test runner: the `package.json` scripts, the `Makefile`, the
     CI configuration. Propose one command, with `{files}` where the paths go. On the
     developer's yes, write it as one line in backticks under `## Affected tests command` of
     `<root>/openspec/planning.md`. Commit that file alone with `commit.mjs`, with the message
     `chore(flow): the affected tests command`. Then run `quick.mjs tests` again. On a no,
     report that no affected tests ran.
   - A failure: fix the code, commit the fix, and run the tests again.

8. **Review the branch.** One round. Record the phase and start the run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase review --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" start --change <name> --root <root>
   ```

   On a resume at the round, run neither of these calls: `start` refuses a run with rounds.
   Read the result of `start` first:
   - `recordStands: true`: the record stands; go to step 9.
   - `empty: true`: run `review.mjs assemble --change <name> --not-reviewed "<reason>" --commit
     --root <root>`, and go to step 9.

   Otherwise open the round, and write the reviewer's input and prompt:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" round --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" input --round 1 --change <name> --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <name> --role ai-review --round 1 --root <root>
   ```

   On a resume, `round` gives `already: true` for a round with no stored reply. When
   `<root>/.superpowers/sdd/<name>/review/r1/findings.json` exists, the reply is stored: go on
   to the fixes. Otherwise dispatch `ai-review r1` at `agent`, with the printed `prompt`. Store
   its reply:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" response --change <name> --round 1 --file <reply json> --root <root>
   ```

   Retry an invalid reply once, as `next` and `mode` say. Then list the blocking findings:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" fixplan --change <name> --round 1 --root <root>
   ```

   Fix each blocking finding yourself, in that order. Commit each fix with `commit.mjs`. A fix
   commit touches only the finding's file and its tests. Write the reply with Write, in the
   shape of `${CLAUDE_PLUGIN_ROOT}/schema/review-fix.schema.json`:
   `{ "finding": "F<n>", "outcome": "fixed", "sha": "<commit>", "failureMode": "<what failed>" }`.
   Record it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" fix --change <name> --round 1 --finding F<n> --file <fix json> --root <root>
   ```

   Put a finding that you think is false to the developer, with your argument. Record their
   ruling and its disposition as the review instruction states. Write a body file for each
   non-blocking finding left as it is, and record it with `review.mjs disposition --change
   <name> --finding F<n> --as recorded --body-file <file> --root <root>`. After the last fix,
   run `quick.mjs tests --change <name> --root <root>` again. Then assemble and commit the record:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" assemble --change <name> --commit --root <root>
   ```

   On `refusals`, run the calls they name, and assemble again. A finding that needs a second
   round goes to `/adf:propose`. Show the `report`.

9. **End the change.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" session --change <name> --phase end --root <root>
   ```

   Write `## Summary` of `quick.md`: what was wrong, what changed, the tests run, and the
   review's result. Name what was fixed and what was not. Leave the summary uncommitted:
   `commit-specs` commits it with the move. A commit of it after the review record makes `check`
   refuse. Then run the archive's steps, one at a time, as `next` gives them:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" next --change <name> --root <root>
   ```

   Run each step as `archive.mjs <step> --change <name> --root <root>`. Give it what the
   instruction's rule for that step gives it:
   - `check`, `placements`: as the instruction states. A spec scenario that the fix shows
     missing goes to the debt store with `debt.mjs add`.
   - `merge`: the call alone. It is skipped with the reason `quick task`.
   - `ingest`: run `ingest.mjs stale`, then dispatch `ingest`, and pass its reply as `--reply`.
     With no knowledge plugin, run the call with no reply.
   - `mr`: run `forge.mjs check`. With a forge, write the body from `archive.mjs mr-input`: its
     `goal`, `summary` and `plan`. The QA section takes the plan's **Check:** lines. It also
     takes the affected tests record, `<root>/.superpowers/sdd/<name>/quick/tests.json`. The
     scope's keys stay out of the body: `links` carries them. Pass `--body` and `--summary`.
   - `merge-local`: the call shows the commands. Ask the developer, then pass `--yes` or `--no`.
   - The other steps: the call alone. After `remove`, pass `--root <main>`.

   On `ok: false`, show the step's `refusal` and `detail`, and stop. The exception: the
   instruction's rule for the step settles it here. Push nothing yourself.

10. **Report.**

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" report --change <name> --root <main>
    ```

    Show its `report` as it is. Then tell the developer: after the merge request is merged, run
    `/adf:land <name>`.
