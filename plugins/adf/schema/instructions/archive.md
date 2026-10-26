The procedure `/adf:archive` executes: a reviewed change taken to the end. Its delta specs merge
into the main specs, every recorded finding and debt is placed, the change moves into the
archive, the knowledge base takes in what the change taught, the merge request is finalized (or,
with no forge, the change is merged locally on the developer's yes) and the worktree is removed.
The command file carries the step order; the rules below are stated here in full and the command
points at them. `<root>` is the change worktree the change was resolved to, `<change>` its name,
and `<main>` the main checkout, `main` in the preflight's result.

**The scripts decide; the orchestrator judges and talks.**

Every deterministic step is one call of `archive.mjs`, whose header lists what each step reads
and writes. `archive.mjs` is the only sanctioned executor of archive: if it cannot run, stop and
report why. Archive stages, moves and deletes nothing by hand: no `git add`, `git mv`, `git rm`
or `git commit` of your own; the steps commit only the paths they wrote. What stays with the
orchestrator, and with nobody's script:

- the talk with the developer about where each unplaced item goes;
- the Purpose of a new capability;
- the conflicts of the spec merge, which are `spec-merge <capability>` dispatches;
- the ingest, which is the `ingest` dispatch;
- the merge request's prose.

**The steps, their state, and resuming.**

The steps run in the order `archive.mjs next` gives: `check`, `placements`, `merge`, `move`,
`commit-specs`, `ingest`, `commit-memory`, `metrics`, `commit-metrics`, `mr`, `merge-local`,
`remove`. Each step's state is
`pending`, `done`, `degraded`, `failed` or `skipped`, kept per change in the main checkout, in
`<main>/.superpowers/sdd/<change>/archive/state.json`: the change directory moves at `move` and
the worktree goes at `remove`, and the main checkout's copy outlives both. A step runs only once
every step before it is settled (`done`, `degraded` or `skipped`). A `done` or `skipped` step is
reported as it is and never runs again; a `failed` or `degraded` step runs again. Every step is
idempotent, so `/adf:archive` run again resumes at the first step not settled. Once `remove` has
run, the worktree is gone: `state`, `next` and `report` then take `--root <main>`.

On a failed step, show the result's `refusal` and `detail` to the developer and stop, unless the
step's rule below says how to settle it here. Never edit `state.json` by hand.

1. **Preflight.** The change is selected by the resolve instruction, then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --phase archive --change <change> --root <root>
   ```

   It checks the Superpowers gate, the worktree, a branch that is named and not protected, and
   the review artifact done. Before the first step it also refuses any uncommitted file outside
   the change directory, since archive commits only what it writes. A change already moved
   passes with `archived` set; `archive.next` names the step to resume at. On a pass it records
   the session. On `ok: false`, stop, show `refusal` and write nothing.

   A change whose worktree a finished `remove` took is no longer listed by `changes.mjs find`:
   for it, run `archive.mjs next --change <change> --root <main>`, and when `next` is null show
   the report (step 14).

2. **`check`: PASS only.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" check --change <change> --root <root>
   ```

   The review record is read by `review.mjs check`'s parser, not by a grep. Archive proceeds on
   `PASS` only; a `BLOCKED` record is refused. There is one route past a blocking finding: the
   developer's ruling with a reason at review, which makes the computed verdict `PASS`. The
   record is committed, its reviewed commit is an ancestor of HEAD, and no commit after it
   touches anything but the record; the refusal names the change root and the repository root,
   so a wrong `--root` shows itself. The spec base is checked as `specs.mjs base --check`
   checks it: a requirement the deltas modify, remove or rename with no entry in
   `specs-base.json`, or with an entry taken for another delta text, refuses archive, since the
   merge must not use a base the delta was not written against; run `specs.mjs base` and commit
   the file with the edit. A change with no `specs-base.json` at all was made before the
   snapshot: it is not refused, and a warning names the fallback to the merge base.
   `detail.warnings` names that fallback, the artifacts not done and the unchecked tasks: show
   them and ask the developer whether to archive anyway. An incomplete change may be archived
   on purpose. On a no, stop; a later run resumes at `placements`. `detail.handEdited` keeps the
   capabilities `verify.md` lists as hand-edited, for the report.

3. **`placements`: every deferred item reaches a store.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" placements --change <change> --root <root>
   ```

   `detail.unplaced` lists every debt record with no `resolve`, every recorded or accepted
   review finding with no `resolve --finding`, and every `deviation` cited by no `debt` and no
   `ruling`; each entry carries the command that places it. Archive does not go on while the
   list holds anything. Put the items to the developer together, each with the destination you
   propose and why, and place each on their answer:

   - **A deviation** is cited by one of two records. One the flow forced is a defect of the
     flow: `ledger.mjs debt --change <change> --what "<the flow defect>" --reason "forced
     deviation-<n>"`, a new debt that is then placed below. A judgement about this change stands
     as it is, through the developer's ruling: `ledger.mjs ruling --change <change> --finding
     deviation-<n> --decision "<their reason>"`.
   - **Technical debt** of the product goes to the core's debt store at the registry's
     `debt.root`. Read `debt.mjs list --kind debt` first: an item an existing entry already
     covers is one more anchor on it, `debt.mjs anchor --id <id> --anchor <site>`; otherwise
     `debt.mjs add --block <id> --title <t> --anchors <sites> --class defect|debt|decision
     --source <change>`. One entry is one action, deliverable in one commit: the same edit at
     several sites is one entry with several anchors. `decision` is a decision still to be
     made. With no `debt.root`, `debt.mjs` refuses; the developer sets it with `debt.mjs root
     --set <path>`. Then `ledger.mjs resolve ... --as tech-debt --where <entry id>`.
   - **ADF debt**, a defect of the flow's own plugins, is a record of kind `adf`: write `{
     plugin, pluginVersion, class, title, body }` to a file, the version from the plugin's
     `.claude-plugin/plugin.json` and the class `defect`, `deferred wording` or `decision`, and
     run `debt.mjs adf --change <change> --file <file>`. Nothing leaves the machine; the
     plugin's maintainer files it upstream. Then `ledger.mjs resolve ... --as adf-debt --where
     <record id>`.
   - **A follow-up change** takes an item that is work for a change of its own: `--as follow-up
     --where "<the follow-up change or issue>"`.
   - **Accepted** closes an item for good with the decision stated: `--as accepted --where
     "<the decision>"`, written only after the developer's explicit yes. An accepted item gets
     no row in the debt store.

   The debt store is the one list of open product debt: a knowledge page that explains a
   mechanism may state its limitation, and the entry links to that page. Then run `placements`
   again. On a pass, the script moves each entry the change's `scope.json` takes in full (a
   debt item in state `taken`; a `partial` one stays) to its block's `resolved.md`, resolved by
   the directory `move` archives the change to, `detail.resolvedDebt`; an entry already
   resolved counts as resolved, and one in neither file is reported as `detail.goneDebt`, no
   failure. The debt store's uncommitted files are then recorded as the placement's, and
   `commit-memory` commits them; no commit message names the resolved ids.

4. **`merge`: the delta specs into the main specs.** First show the developer the preview:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/specs.mjs" merge --dry-run --change <change> --root <root>
   ```

   Show its totals (added, modified, removed, renamed), the new capabilities, the conflicts and
   `merged`, which says the main specs already hold the delta. There is no choice to archive
   without the merge: only archive writes the main specs, and an archived change is not
   archived again, so a skipped merge could never be made. The merge itself:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" merge --change <change> [--resolutions <file> ...] [--purpose <capability>=<file> ...] --root <root>
   ```

   The script merges with openspec 1.5.0's semantics, all or nothing, and writes the main specs
   itself; no agent edits them.

   - **A conflict** is a requirement this change modifies, removes or renames whose main-spec
     text changed since the base the change snapshotted at propose (`specs-base.json`; without
     it, the change's merge base, and the preview's `warnings` say so). It fails the step with
     `detail.conflicts`, one entry per capability. For each, in one response:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" attempt --change <change> --name "spec-merge <capability>" --root <root>
     node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <change> --role spec-merge --capability <capability> --root <root>
     ```

     and dispatch its `prompt` as it is, to its `agent`, named `name`. The agent writes no
     spec; it replies. Check each reply:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/specs.mjs" resolution --change <change> --capability <capability> --reply <replyFile> [--resume no] --root <root>
     ```

     It records the reply as an event of the dispatch `spec-merge <capability>` in the change's
     shared attempts log; that is the reply's one record, so it never also goes to
     `dispatch.mjs reply`. On a refusal record another attempt: `next: retry` sends the reply back
     once, to the same agent, resumed, with its `errors` (`mode: resume`); where the harness
     cannot resume it, pass `--resume no` and dispatch the prompt afresh with the errors as its
     question (`mode: fresh`). `next: stop` stops archive; a stop the environment caused ends
     only by the developer reset under step 7. Then run `merge` again with every valid
     reply, one `--resolutions` per file: the script joins them into one list. A conflict may
     instead be settled by rebasing the stale delta, with the developer.
   - **A new capability** gets a spec skeleton whose Purpose is a placeholder, and the step
     refuses until you give it. Write the Purpose from `proposal.md`: what the capability is
     for, in a few sentences, at least the validator's minimum of 50 characters. Write it to a
     file under
     `<main>/.superpowers/sdd/<change>/archive/` and pass `--purpose <capability>=<file>`. The
     report names every capability whose Purpose was written this way.

5. **`move`.** `archive.mjs move`: the ledger is copied into the change, and the change moves
   to `archive/<date>-<name>`, the date from the clock. A target that exists is refused with
   what to do.

6. **`commit-specs`.** `archive.mjs commit-specs`: one commit, `docs(specs): archive
   <change>`, of the change's old and new directories and the main spec files of its
   capabilities. Each commit step names its own paths, and any other uncommitted file of the
   change tree, the main specs, the knowledge base or the debt store refuses it, named: that
   file is the developer's to commit, move or discard, and the step then runs again.

7. **`ingest`: what the change taught, and what it made stale.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ingest.mjs" stale --change <change> --root <root>
   ```

   With `state: none` no knowledge plugin is enabled: run `archive.mjs ingest --change
   <change> --root <root>` with no reply, and the step is `skipped`, which the report says.
   Otherwise the script wrote the dispatch's input: the knowledge base's index, instruction and
   paths, and the stale list, every page that names a path the change deleted, renamed or
   rewrote and every page linked to a requirement the delta touched. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" attempt --change <change> --name ingest --root <root>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <change> --role ingest --root <root>
   ```

   and dispatch its `prompt` as it is, to its `agent`, named `name`. The agent decides what the
   change taught, and what it made stale to correct or remove: a stale page is read as fact by
   every later agent. It answers both fixed questions, the invariant no single file shows and
   what a future implementer would most plausibly get wrong, and answers every stale entry
   `updated`, `removed` or `still-true` with its argument. It writes no page: it reads the
   knowledge base and returns every page it changes, creates or deletes as a `git` patch in its
   reply, which the script applies. Claude Code asks for an interactive approval of every write
   under a project's `.claude/` directory, whatever the allow rules say, so an agent writing a
   page there would stop on a prompt. It writes no log entry and commits nothing. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" ingest --change <change> --reply <replyFile> [--resume no] --root <root>
   ```

   The script checks the whole reply before it writes anything: that the knowledge base holds no
   change the agent made itself, that each page's patch edits only that page, inside the
   knowledge base's paths and outside its log, through no symbolic link, and applies to the tree,
   and that every stale entry has an answer that holds once the edits are applied. Then it
   applies the edits in the change worktree with `git apply`, all or none, and writes the log
   entry through the knowledge role; a failed log write takes the edits back. It records the reply as an event of the dispatch `ingest`, its one record.
   On a refusal record another attempt: `detail.next` `retry` sends the reply back once, to the
   same agent, resumed, with the step's `errors` (`detail.mode` `resume`); where the harness
   cannot resume it, pass `--resume no` and dispatch the prompt afresh with the errors as its
   question (`fresh`). A refused reply leaves the tree as it was. `stop` stops archive, and so
   does every later `attempt` of `ingest`; its output names the reset command (`reset`).
   When the cause was the environment, a permission denial or a missing tool, and the
   environment is now fixed, the developer reset ends the stop, as the apply instruction states
   it (`${CLAUDE_PLUGIN_ROOT}/schema/instructions/apply.md`, "A dispatch stopped on the limit"):
   ask the developer and show the preview of

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" reset --change <change> --name ingest --reason "<the developer's reason>" --root <root>
   ```

   and on their yes run it with `--yes <plan>`, then resume this step from its `attempt`.
   `nothingLearned` writes no page, no log entry and
   no commit; an empty ingest is worse than none. The debt ids `placements` removed go into the
   log entry as one more bullet, or, with nothing learned, into an entry of their own; with no
   knowledge plugin the skipped step's report says they were not logged.

8. **`commit-memory`.** `archive.mjs commit-memory`: one commit, `docs(memory): ingest what
   <change> taught`, of only the paths the ingest and the placement wrote. Nothing to commit is
   no commit.

9. **`metrics`.** `archive.mjs metrics`: the change's metrics record, built by script after the
   ingest is committed so that the ingest is measured, written as `metrics.json` in the archived
   directory with a copy of `attempts.jsonl`; the price table is updated from the registry's
   `metrics.pricesUrl`. A failed price fetch is recorded as `stale` or `none` and does not fail
   the step; with no transcripts the step is `degraded`, the record written with the gap named.
   Neither stops archive. A record that fails its schema fails the step and writes nothing.

10. **`commit-metrics`.** `archive.mjs commit-metrics`: one commit, `chore(metrics): record
    <change>`, of only the paths `metrics` wrote and the ledger, which the step copies into the
    archived change again first, so the archive holds every record written since `move`.
    Nothing to commit is no commit.

11. **`mr`: the merge request.** Ask the forge first:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" check --root <root>
   ```

   With `state: none`, run `archive.mjs mr --change <change> --root <root>` with no body: the
   step is `skipped`, and `merge-local` follows. With a forge, `mr` with no body holds: the step
   stays `pending`, records nothing, and returns the `bodyFile` and what it is `waiting` for.
   Run `archive.mjs mr-input`, and from
   its `tasks`, `why`, `scenarios` and `evidence` write the merge request body to its `bodyFile`:
   the sections of the forge plugin's merge request template, the steps a tester follows taken
   from the scenarios, and the evidence `verify.md` recorded. When the change holds a
   `scope.json`, the body names each key it takes, its taken and partial tracker keys and debt
   ids: `mr` fails the step with the keys missing, and sends nothing. Write the body in English:
   it is an ignored file outside the change, so no commit hook checks it. Then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" mr --change <change> --body <bodyFile> --summary "<scope>: <description>" --root <root>
   ```

   A branch with no Conventional Commits type prefix takes `--title "<type>(<scope>):
   <description>"` in full instead, agreed with the developer.

   **`--no-ci`.** When the developer wants the merge request pushed with no CI run, any
   `archive.mjs` step takes `--no-ci`: it is kept in the archive state, so a resumed run keeps
   it, and `mr` passes it to the forge's `finalize` as `ci: false`. It is a forge option, never
   a marker in a title or a commit message. A forge that cannot push with no CI run refuses with
   nothing sent, and the step fails with its reason. The forge role's `finalize`
   writes the body, takes the request out of draft and pushes; archive never merges a merge
   request. `refused` fails the step with the forge's reason: correct the body and run `mr`
   again. `degraded` keeps the role's fallback commands, archive goes on, and the report says
   the request is not ready until the fallback has run and `mr` has run again.

12. **`merge-local`: with no forge only.** With a forge the step is `skipped`. With none:

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" merge-local --change <change> --root <root>
    ```

    returns the branch, the base and the `commands` of a local merge, and records nothing. Ask
    the developer whether to merge the change into its base now. Only on their explicit yes,
    run it again with `--yes`: `git merge --no-ff` in the main checkout, when the main checkout
    has the base checked out and is clean; otherwise it is refused with the commands to run.
    Nothing is pushed and the branch is kept. On a no, run it with `--no`: the developer merges
    it.

13. **`remove`.** `archive.mjs remove`: the change's worktree goes, from the main checkout,
    never forced, its branch kept. A change made in place, or a worktree already gone, is
    reported, not failed. A worktree with uncommitted changes is refused with its status, for
    the developer to settle; so is a worktree whose ledger the archived change holds no copy
    of. The worktree's active-change pointer goes to the main checkout first, so land finds the
    change. From here on, pass `--root <main>`.

14. **Report.**

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/archive.mjs" report --change <change> --root <main>
    ```

    Show its `report` as it is. It is built last, by script, from the states, from git and from
    the change's metrics record: `Archive complete` only when every step is done or skipped, or
    `metrics` is degraded; otherwise it names each step not finished and the next one to run.
    A complete archive whose scope holds a taken or partial tracker issue names `/adf:land
    <change>` as the next step, `land` in the result: after the merge it hands each issue to its
    tester. Then, each line only when it has content:

    - **The window line**: the changes archived since the last window retrospective on the
      integration ref, with the age of its fetch. The ref is fetched once; a failed fetch or
      read is reported, never fatal.
    - **The corpus lint**, due when `verify.md` lists hand-edited capability prose, which the
      line names, or when 3 or more changes were archived since the last window retrospective.
      The lint reports and never gates.
    - **Removal candidates**: the layers and checks quiet over the last archived changes,
      information only.
    - **Hurt signals** in this change's record: a stopped dispatch, the review stage stopped,
      the review round cap reached, a context compaction. With any of them the report suggests
      `/adf:retro --change <change>`; the retrospective is the developer's to run. With no record,
      because `metrics` failed or its file cannot be read, the report says the signals were not
      read.
