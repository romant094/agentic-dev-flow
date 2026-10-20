The procedure `/adf:retro` executes: a retrospective over archived changes. A script selects
the changes and computes every number, one agent reasons over them and replies in JSON, a
script checks the reply, renders the report into `.adf/retro/`, commits it on the
retrospective's own branch and integrates it, and the flow findings go upstream on the
developer's yes. The command file carries the step order; the rules below are stated here in
full and the command points at them. `<main>` is the main checkout, `<wt>` the retrospective's
worktree, `detail.worktree` of `start`.

**What a retrospective assesses, and what it writes.**

It assesses how the flow worked over its changes, and nothing else. It writes no debt: product
debt is the ingest's, and ADF debt records are archive's. The only files it commits are its
report and its sidecar, `.adf/retro/<id>.md` and `.adf/retro/<id>.json`. The input, the replies,
the prompt and the attempts log stay in `.superpowers/retro/<id>/`, which is ignored.

**Modes and ids.**

- **window**, the default: the changes merged into the integration branch since the last window
  retrospective, all of them when there is none. Only a window retrospective starts the next
  window, and only once its sidecar is on the fetched integration ref.
- **change**, `--change <name>`: one archived change, as archive's report suggests when the
  change's record shows a hurt signal.
- **period**, `--from <YYYY-MM-DD> --to <YYYY-MM-DD>`: the changes merged in those dates.

A retrospective is named by its id: `<date>-window`, `<date>-period` or `<date>-<change>`, the
date from `--date`, default today. Several retrospectives may share a date. The id names its
branch `chore/retro/<id>`, its worktree `.claude/worktrees/retro-<id>`, its state, its files
and its dispatch, `retro <id>`. A second `start` of an id with another scope is refused, and so
is a change named after a mode, `window`, `change` or `period`. Every step after `start` takes `--id <id>`; without it,
the newest retrospective started.

**The scripts decide; the orchestrator judges and talks.**

Every deterministic step is one call of `retro.mjs`, whose header lists what each step reads and
writes. Stage, commit, merge and remove nothing by hand. What stays with the orchestrator: the
dispatch of the `retro <id>` agent, the talk with the developer, and their yes for a local merge
and for filing upstream. The input, the prompt and the replies stay in their files: read the
scripts' results, counts and refusals.

**The steps, their state, and resuming.**

The steps run in this order: `start`, `window`, `reply`, `render`, `record`, `publish`, `file`,
`remove`. Each step's state is `pending`, `done`, `degraded`, `failed` or `skipped`, kept in
`<main>/.superpowers/retro/<id>/state.json`. A step runs once every step before it is settled
(`done`, `degraded` or `skipped`); `file` needs only the steps before `publish`. A `done` or
`skipped` step is reported as it is, not run again; a `failed` or `degraded` one runs again, as
archive's steps do. `retro.mjs state --id <id>` names the next step, so `/adf:retro` run again resumes there.
A step that waits for the developer's yes holds: `pending`, nothing recorded. Only the scripts
write `state.json`.

1. **`start`.** `retro.mjs start [--date <d>] [--change <name> | --from <d> --to <d>] --root
   <main>`: the integration ref fetched, then the branch and the worktree made from the
   integration branch, as propose makes a change's; the main checkout is never switched. A
   worktree a failed run made is adopted.

2. **`window`.** `retro.mjs window --id <id> --root <wt>`: the sidecar over the fetched ref,
   the knowledge base's paths left out of the diff figures; the agent's input and its prompt
   written; the dispatch recorded. `detail.changes` lists the changes and `detail.coverage`
   how many have a metrics record: show both. `detail.dispatch` is the plan of the dispatch.

3. **`reply`: the `retro <id>` agent.** Dispatch the content of `detail.dispatch.promptFile` as
   it is, to `detail.dispatch.agent`, named `detail.dispatch.name`, in `<wt>`. The agent writes
   its JSON reply to `detail.dispatch.replyFile` and nothing else. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs" reply --id <id> --file <replyFile> [--resume no] --root <wt>
   ```

   The script checks the reply against `schema/retro.schema.json` and the rules the schema
   cannot state: every evidence, cost, basis and saving key is a key of the input's values;
   every waiting item is answered once; the removal candidate is computed or listed, or `none`
   with a reason; a finding's plugin is enabled or installed. A valid reply is computed, every
   key resolved to its value, and kept in the state. A refused reply goes back once:
   `detail.next` `retry` has already recorded the retry's dispatch, `detail.dispatch`, so the
   metrics count it; send the `errors` to the same agent, resumed (`detail.mode` `resume`), with
   `detail.dispatch.replyFile` as its reply file. Where the harness cannot resume the agent,
   pass `--resume no` on the refused reply's call and dispatch the prompt afresh with the errors
   as its question (`fresh`). `next: stop` ends the retrospective: report it to the developer.

4. **`render`.** `retro.mjs render --id <id> --root <wt>`: `.adf/retro/<id>.json`, the sidecar
   with the computed reply, and `.adf/retro/<id>.md`, the report, in `<wt>`. Every figure in
   the report comes from the sidecar or a key the reply cited; the agent writes no number.

5. **`record`.** `retro.mjs record --id <id> --root <wt>`: one commit of only those files,
   `docs(retro): <mode> retrospective <date>`, with ` of <change>` for one change. Pass the
   retro worktree as `--root`: the english-check hook reads the committed files under the
   `--root` the call names, and they exist only in `<wt>`. A commit a failed run made is
   adopted, not made twice.

6. **`publish`.** `retro.mjs publish --id <id> --root <wt>`. With a forge, its `open` makes a
   merge request into the integration branch that is not a draft and is pushed with no CI run
   (`ci: false`); the retrospective never merges it. `refused` fails the step with the forge's
   reason; `degraded` keeps the forge's fallback. With no forge, the call holds and returns the
   `commands` of a local merge. Ask the developer whether to merge the branch into the
   integration branch in the main checkout now. Only on their explicit yes, run it again with
   `--yes`: `git merge --no-ff` in the main checkout, when it has the integration branch checked
   out and is clean; otherwise refused with the commands. Nothing is pushed and the branch is
   kept. On a no, run it with `--no`: the step is `skipped`, the developer merges the branch by
   hand with the commands it keeps, and `file` and `remove` can run. A local merge starts the next window only after the developer pushes the integration
   branch, since the window reads the fetched ref.

7. **`file`.** `retro.mjs file --id <id> --root <wt>` asks the `upstream` role. With no
   provider, the step is `skipped` and the findings stay in the sidecar. With one, the call
   holds and returns `would`, the findings it would file: show them and ask the developer. Only
   on their explicit yes, run it again with `--yes`, and `--findings R1,R2` when they chose only
   some. A retrospective with no finding files nothing.

8. **`remove`.** `retro.mjs remove --id <id> --root <main>`: the retro worktree goes from the
   main checkout, as archive removes a change's: never forced, the branch kept, a worktree with
   uncommitted changes refused with its status for the developer to settle. From here on, pass
   `--root <main>`.

**Report.** Name the id, the changes covered, the findings by id and title, the removal
candidate, the merge request or the local merge, what was filed upstream, and each step not
finished with the next one to run.
