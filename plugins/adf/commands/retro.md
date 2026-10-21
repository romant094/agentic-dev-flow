---
description: Run a retrospective - how the flow worked over a window of archived changes, one change or a period. Triggers may be phrased in any language.
argument-hint: "[--change <name> | --from <YYYY-MM-DD> --to <YYYY-MM-DD>]"
effort: medium
---

Run a retrospective: a script selects the archived changes and computes every number, one agent
reasons over them, its findings and the open ADF debt are filed upstream on the developer's yes,
and the checked report is committed in `.adf/retro/` on its own branch and integrated. The
retrospective assesses the flow only: it writes no debt and commits nothing outside
`.adf/retro/`, except the Filed column of the ADF debt it files.

The rules this command follows are stated in full in the retro instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/retro.md`: read it before step 1.

Each step below is one `retro.mjs` call, or the dispatch whose prompt `window` writes; what is
yours is the judgement on its result and the talk with the developer. The input, the prompt and
the replies stay in their files: read the scripts' results, counts and refusals.

**Input:** `$ARGUMENTS`, optional, picks the mode:

- nothing: the window, every change merged since the last window retrospective;
- `--change <name>`: one archived change;
- `--from <YYYY-MM-DD> --to <YYYY-MM-DD>`: the changes merged in that period.

`<main>` is the main checkout; `<wt>` is the retro worktree, `detail.worktree` of `start`; `<id>`
is the retrospective's id, `id` in every result. A re-run resumes at
`retro.mjs state --id <id> --root <main>`'s `next`.

1. **Start.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs" start <mode arguments> --root
   <main>`. On `ok: false`, show `refusal` and stop. Keep `id` and `detail.worktree`.

2. **Window.** `retro.mjs window --id <id> --root <wt>`. Show the changes covered, their
   record coverage and the ADF debt not yet filed, `detail.adfDebt`.

3. **Dispatch** the `retro <id>` agent with the prompt `detail.dispatch.promptFile`, as the
   instruction's `reply` step states.

4. **Reply.** `retro.mjs reply --id <id> --file <replyFile> --root <wt>`. On `detail.next`
   `retry`, send the errors back as the instruction states and run `reply` again; on `stop`,
   report and stop.

5. **File upstream.** `retro.mjs file --id <id> --root <wt>`. With an `upstream` provider, the
   call holds: show `would`, the findings and the ADF debt records by id and title, and ask the
   developer; only on their yes run it again with `--yes`, with `--findings` and `--debt` when
   they chose some (`none` files none of that kind). `degraded`: show the hint; the developer
   fixes it and runs `file` again, or goes on without filing. `failed`: show `refusal`. With
   no provider, it is skipped: the findings stay in the sidecar and the debt unfiled.

6. **Render.** `retro.mjs render --id <id> --root <wt>`.

7. **Record.** `retro.mjs record --id <id> --root <wt>`, with the retro worktree as `--root`
   so that the english-check hook finds the files it commits.

8. **Publish.** `retro.mjs publish --id <id> --root <wt>`. With a forge, report the merge
   request: no draft, no CI run. With none, the call holds with the commands of a local merge:
   ask the developer, and only on their yes run it again with `--yes`; on a no, with `--no`. Tell them the next
   window starts here only once they push the integration branch.

9. **Remove.** `retro.mjs remove --id <id> --root <main>`. A dirty worktree is refused: show
   its status to the developer.

10. **Report** as the instruction states. Push nothing yourself.
