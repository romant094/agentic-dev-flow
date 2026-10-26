---
description: Archive a change - merge its specs, place its debt, ingest what it taught, finalize the merge request and remove the worktree. Triggers may be phrased in any language.
argument-hint: <change-name> [--no-ci]
effort: medium
---

Archive a reviewed change: merge its delta specs into the main specs, place every recorded
finding and debt, move the change into the archive, ingest what it taught into the knowledge
base, finalize the merge request (or, with no forge, merge locally on the developer's yes) and
remove the worktree. Archive runs after review, on a `PASS` record.

The rules this command follows are stated in full in the archive instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/archive.md`: read it before step 2. Change selection
is stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

Run every script call below as one plain command per Bash call, and read its JSON from the
output: the rules for tools are stated in full under `## Tools` in
`${CLAUDE_PLUGIN_ROOT}/schema/prompts/frame.md`, and they bind this session too.

Each step below is one script call, or a dispatch whose prompt one script call writes; what is
yours is the judgement on its result and the talk with the developer. A question that needs more
than one file opened goes to a read-only agent that returns a verdict, named `investigate
<topic>` with a one-word topic. Read one named file directly. The specs, the conflict texts and
the replies stay in their files: read the scripts' verdicts, counts and refusals.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, a change the conversation
names is passed as the name; otherwise the active change answers in step 1. `--no-ci` in it asks
for the merge request pushed with no CI run.

1. **Select the change and run the preflight.** Follow the resolve instruction: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" active [--change <name>]`, which answers
   without asking unless `ask` is true, and say `Using change: <name> in <root>`. Then run `preflight.mjs --phase archive`,
   as the instruction states. On `ok: false`, stop: show `refusal`, which names the remedy, and
   write nothing. Keep `main`, the main checkout. From here on, pass `--change <name> --root
   <root>` to every core script and run git with `git -C <root>`. A change whose worktree is
   already removed is resumed from the main checkout, as the instruction states.

2. **Ask for the next step.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" next --change <name> --root <root>
   ```

   `next` null: go to step 4. Otherwise run that step (step 3) and ask again. A re-run of
   `/adf:archive` resumes here, at the first step not settled.

3. **Run the step**, one `archive.mjs <step>` call, with what the instruction's rule for that
   step gives it:
   - `check`: show `detail.warnings`, if any, and ask whether to archive anyway. A stale or
     missing spec base entry refuses: `specs.mjs base`, commit, and run `check` again.
   - `placements`: put each `detail.unplaced` item to the developer with the destination you
     propose; place it with the commands the instruction names; run `placements` again.
   - `merge`: show `specs.mjs merge --dry-run` first. Dispatch `spec-merge <capability>` for
     each conflict and check each reply with `specs.mjs resolution`; write a new capability's
     Purpose from `proposal.md`; pass them as `--resolutions` and `--purpose`.
   - `move`, `commit-specs`, `commit-memory`, `metrics`, `commit-metrics`, `remove`: the call
     alone; a `degraded` `metrics` does not stop archive. After `remove`, pass
     `--root <main>`.
   - `ingest`: `ingest.mjs stale`, then dispatch `ingest` and pass its reply as `--reply`;
     with no knowledge plugin, the call with no reply.
   - `mr`: `forge.mjs check`; with a forge, write the body from `archive.mjs mr-input` and pass
     `--body` and `--summary`: a call with no body holds, `pending`, and names what it needs;
     with none, the call with no body. With `--no-ci` in the input, pass `--no-ci` to the
     first step you run, as the instruction's `mr` rule states.
   - `merge-local`: the call shows the commands; ask the developer, then `--yes` or `--no`.

   On `ok: false`, show the step's `refusal` and `detail` and stop, unless the instruction's
   rule for the step settles it here. Push nothing yourself.

4. **Report.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" report --change <name> --root <main>
   ```

   Your final message is its `report`, as it is: it names each step not finished and the next
   one to run, then the changes since the last window retrospective, the corpus lint when due,
   the removal candidates and the record's hurt signals with a suggested `/adf:retro --change`,
   as the instruction's report rule states.
