---
description: Land a merged change - write the hand-off comment of each tracker issue it took and hand each to its tester. Triggers on "land the change", "hand off the issues", "the merge request is merged". Triggers may be phrased in any language.
argument-hint: <change-name>
effort: medium
---

Land a change after its merge: each tracker issue the change took gets one comment, rendered by
the tracker plugin from fields an agent writes and the script checks, and goes to its tester. A
partial issue gets a comment of what remains and keeps its status. The issue that mirrors a
group of debt entries the change took is handed off too, once no entry of its group remains in
the debt tree; while some remain it is partial. Land runs after
`/adf:archive`, once the merge request is merged, or with no forge once the branch is merged into
its base. Land merges nothing and pushes nothing.

Each step below is one `land.mjs` call, or the dispatch whose prompt `comment-input` writes;
what is yours is the judgement on its result and the talk with the developer. Every step records
its result in the main checkout, so a rerun of `/adf:land` resumes: a finished step returns what
it recorded. The inputs and the replies stay in their files: read the script's results and
refusals.

**Input:** `$ARGUMENTS` is the change name. Without it, ask which archived change to land.

1. **Resume.** From the main checkout:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" report --change <name>
   ```

   `complete` or `skipped`: show `report` and stop. `stopped`: the merge request was closed
   without a merge; show `report` and stop. Otherwise go to the step `next` names.

2. **Check the scope and the tracker.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" check --change <name>
   ```

   `skipped`: show `report`, which says why (no tracker plugin, the tracker skipped for this
   change, or no tracker issue taken and no tracked debt), and stop. `degraded`: show `report` and `hint`, ask the
   developer to fix the tracker, and run it again.

3. **Wait for the merge.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" wait --change <name>
   ```

   `done`: go on. `waiting`: the merge request is open or a draft, or the branch is not in its
   base yet; show `report` and `waiting`, and stop until the developer says it is merged, then
   run `/adf:land` again. `closed` (`ok: false`): show `refusal` and stop; nothing is handed
   off. `degraded`: show `hint`, and run it again once the forge is fixed.

4. **Write the comment inputs and dispatch the agents.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" comment-input --change <name>
   ```

   For each entry of `dispatches`, dispatch a read-only agent named `name` at `agent`, with the
   text of `promptFile` as its prompt, all in parallel.

5. **Check each reply.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" comment --change <name> --key <KEY> --file <replyFile>
   ```

   On a refusal, send `errors` to the same agent once; after a second refusal, write the fields
   with the developer and pass them in a reply file of the same shape. Repeat until `missing` is
   empty.

6. **Hand off, held for the developer's yes.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/land.mjs" handoff --change <name>
   ```

   When `state` is `pending`, show `report`, the tracker's preview of each comment and status
   change, and ask the developer for a yes. On the yes only, run it again with `--yes`. A
   `failed` item: run it again with `--yes`, and the plan resumes where it stopped. `refused`:
   show `error`, and run it without `--yes` for a new plan.

7. **Report.** Run step 1's `report` call and show its `report` as it is.
