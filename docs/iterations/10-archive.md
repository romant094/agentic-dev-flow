# Iteration 10 — Archive and wiki memory

## Goal

`/adf:archive` takes a reviewed change to the end: it merges the delta specs into the main specs,
places every recorded finding and debt, moves the change into the archive, ingests what the
change taught into the knowledge base, finalizes the merge request (or, with no forge, offers a
local merge) and removes the worktree. Every deterministic step is a script, and archive resumes
from the step that failed. The LLM keeps a spec conflict, a new capability's Purpose, the ingest,
the merge request's prose and the placement talk with the developer. The rules and their reasons
are in `docs/lessons/archive.md` and `docs/lessons/memory.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/specs.mjs` merge, pure: openspec 1.5.0's `buildUpdatedSpec` semantics on the port's parser (pre-validation of duplicates and cross-section conflicts; RENAMED, REMOVED, MODIFIED, ADDED in that order; MODIFIED replaces the whole block; original order kept, new blocks appended; a skeleton for a new capability with a placeholder Purpose); every rebuilt spec validated strict before any write, all or nothing; a delta whose every block equals main is `merged` | `specs-merge.spec.mjs`, including byte equality with openspec 1.5.0 on fixtures |
| 2 | Three-way check: for every MODIFIED, REMOVED and RENAMED requirement, the main text now against its base text; a requirement edited since is a `conflict` with the three texts; `--resolutions <file>` applies replies for the conflicts only. The base is the change's `specs-base.json`, snapshotted at propose by the `specs` gate `specs-base` (`specs.mjs base`: kept for an unchanged delta block, refreshed for a changed one, dropped for one no longer touched) and checked by verify's `specs-base` check (`specs.mjs base --check`), since a rebase or squash moves the merge base (42 of the origin's 47 merges); a missing entry refuses the merge; without the file, the merge base, with a warning | `specs-merge.spec.mjs` against real git repositories, a rebase included; `verify.spec.mjs`; `propose.spec.mjs` |
| 3 | `specs.mjs merge --dry-run --change`: the read-only preview (counts, conflicts, new capabilities, `merged`); the writing merge only as `archive.mjs merge`, after the gate | `specs.spec.mjs`, `archive.spec.mjs` |
| 4 | Conflict dispatch `spec-merge <capability>` at level `architecture`: skeleton `spec-merge.md`; `spec-merge-resolution.schema.json` (capability, requirement, text, reason) checked by script; one retry, a second invalid reply stops archive | `dispatch.spec.mjs`, `archive.spec.mjs` |
| 5 | `preflight.mjs --phase archive`; `archive.mjs check`: the review record through `review.mjs check`, `PASS` only (a `BLOCKED` record is refused), the reviewed commit, the staleness scan naming both roots, artifacts not done and unchecked tasks as `warnings` | `preflight.spec.mjs`, `archive.spec.mjs` |
| 6 | Placements: `ledger.mjs resolve --finding F<n>`; `archive.mjs placements` lists the unresolved debt, the recorded and accepted findings with no resolve, and every deviation cited by no `debt` and no `ruling`; archive refuses to go on while the list holds anything | `ledger.spec.mjs`, `archive.spec.mjs` |
| 7 | Debt store in the core: `debt.mjs list`, `add`, `anchor`, `remove`, `check`, and `flow --change --file <json>`, a record of kind `flow` with the plugin, its version and the change; registry `debt.root`, asked by `/adf:init` | `debt.spec.mjs`, `registry.spec.mjs` |
| 8 | Memory plugin `plugins/memory/`: role `knowledge` (`context`, `log`, `check`); `lib/rotate.mjs` (creates `log-archive/` when absent, reads the zone-suffixed header); `log` (UTC time, author from `git config user.name`, inserted at its timestamp's place, `--commit --reason`, `--amend`, rotation first); `check` (unindexed pages, broken links, malformed headers, order); host skeleton and the ingest, query and lint instructions | `memory.spec.mjs`, `rotate.spec.mjs` |
| 9 | Contract `1.3`: the `knowledge` role; with no provider archive skips the ingest and says so and brainstorm reads no index; verify's out-of-plan check allows the paths `context` declares | `roles.spec.mjs`, `verify.spec.mjs`, `extensions.spec.mjs` |
| 10 | Ingest dispatch `ingest` at level `architecture`. `archive.mjs stale` lists every memory page that names a path the change deleted, renamed or rewrote, and every page linked to a touched requirement. `ingest.schema.json`: `nothingLearned`, `pages[{path, why}]`, `stale[{path, outcome updated\|removed\|still-true, argument}]`, `invariant`, `likelyMistake`, `log {title, bullets}`. The script checks that the pages listed are exactly the changed files under the knowledge base, that every stale entry has an answer, and writes the log through `knowledge.log` | `dispatch.spec.mjs`, `archive.spec.mjs` |
| 11 | `changes.mjs archive --change`: target `archive/<date>-<name>`, the date from the clock; an existing target refused; the ledger copied once, any failure but a missing ledger refuses; the directory moved | `changes.spec.mjs` |
| 12 | Commits through `commit.mjs --only`: `docs(specs): archive <name>` and `docs(memory): ingest what <name> taught`, each with only the paths archive wrote; any other uncommitted file in the change tree or the knowledge base is refused and named; nothing to commit is no commit; `archive.mjs` and `changes.mjs` join the English check's list | `archive.spec.mjs`, `hook.spec.mjs` |
| 13 | Resumable archive: `archive.mjs state` persists each step's state (`done`, `degraded`, `failed`, `pending`) in the change's SDD directory; every step is idempotent; a re-run starts at the first step not done; `archive.mjs report` builds the final report last, from the states | `archive.spec.mjs`, a failure injected at each step |
| 14 | Merge request: `archive.mjs mr-input`; the orchestrator writes `merge-request.md`; `forge.mjs finalize`; `degraded` keeps the fallback file and the report says the request is not ready | `archive.spec.mjs`, `roles.spec.mjs` |
| 15 | No forge: `archive.mjs merge-local` after the developer's yes: `git merge --no-ff` in the main checkout only when it has the base checked out and is clean, otherwise refused with the commands printed; nothing pushed; the branch kept | `archive.spec.mjs` against real git repositories |
| 16 | `workspace.mjs remove --change`: the worktree of the change's branch; already removed or in place reported, not failed; a dirty tree refused; never `--force`; the branch kept | `workspace.spec.mjs` |
| 17 | Surfaces: `commands/archive.md`, `instructions/archive.md`, the `archive` block in `schema.json`; brainstorm reads `context` | `schema.spec.mjs`, `flow-regression.spec.mjs` |
| 18 | Parity tools: `origin-spec-merge.mjs`, `origin-log.mjs`, `origin-debt-tree.mjs`, `origin-archive-ledgers.mjs` | `npm run parity -- <origin>` |
| 19 | Close every row pending on iteration 10; versions: adf 0.9.0, memory 0.1.0, english-check 0.4.0 | `check-lessons.mjs` |

## Decisions

Settled by the developer on 2026-10-19.

- The wiki memory is a separate `memory` plugin providing the role `knowledge`; contract 1.3
  adds that role only.
- The debt ledger is the core's, at the registry's `debt.root`.
- Flow debt stays on the host machine as a record of kind `flow`. Archive sends nothing
  anywhere. Filing it as issues of the plugin's repository is the maintainer's plugin
  (iteration 10b): only the maintainer has its token, and the script checks push permission on
  the repository before any write.
- The spec merge is a script; the three-way check sends a requirement another change edited
  since the branch was made to the `spec-merge` agent.
- "Archive without syncing" is removed; a conflict stops archive.
- The ingest is a dispatched agent at level `architecture`. It adds what the change taught and
  corrects or removes what the change made stale; the script gives it the stale list and checks
  every entry has an answer.
- With no forge, the local merge is `git merge --no-ff` after the developer's yes; the branch is
  kept.
- The log inserts an entry at its timestamp's place, in UTC.
- Archive is resumable, and the final report is built last from each step's state.
- Port fixes of origin defects: one verdict route (`PASS` only); archive commits only the paths
  it wrote; a ledger copy failure stops archive; the rotation creates its directory; a recorded
  finding's placement is checked.

## Result

- `npm test`: 704 tests, 703 pass, 0 failures, 1 skipped (the live openspec parity, with
  `OPENSPEC_DIST` not set); `check-lessons.mjs`: ok, 706 rows, 53 pending, no row pending on
  iteration 10.
- `npm run parity -- <origin>`: all sixteen tools PASS. The four new ones:
  - `origin-spec-merge.mjs`: 50 commits on `origin/develop`, 67 changes, 140 files; 134 equal,
    6 deliberate differences, 0 unexplained: a hand edit (`f2c2b3dd device-module-routing`),
    three stale siblings (`2406ec38 change-workflow-schema`, `ac9deac9 device-form-schemas`,
    `ac9deac9 device-form-rendering`), an archive order (`7f9d17a8
    discovered-device-inventory`), and `05e6e054 config-snapshots`, archived unsynced; 2 of
    them are refused by the port's merge. The three-way check on the origin flags none of the 6
    stale cases: 42 of 47 merges with a base were rebased, so the merge base already held the
    other change's edit (5 with a base, 3 without; 57 capabilities checked, 6 flagged where the
    outputs are equal). This is the reason for the spec base snapshot, `specs-base.json`.
  - `origin-log.mjs`: 354 entries over six months (2026-05 to 2026-10); of 18 rotations, 8 equal
    and 10 differences, all explained by the zone suffix; the file layer differs where the
    origin's rotation stops on a missing `log-archive/` and the port creates it; `check` finds
    18 entries out of order and 1 malformed header; 0 unexplained.
  - `origin-debt-tree.mjs`: 11 files, 176 rows in 8 blocks, the port's reader and a plain
    reader agree on every block; 176 unique ids, 94 tracker keys, no duplicate; classes debt
    131, defect 39, decision 6; one `check` finding, explained (a prose example).
  - `origin-archive-ledgers.mjs`: 18 ledgers, 410 records; 0 unresolved debt on both sides;
    under the port's rule, 21 deviations cited by no debt and no ruling and 11 recorded findings
    with no `resolve` would have held placements, as the port intends.
- Fixes found while closing: `mr` with a forge and no `--body` holds, `pending`, and names
  what it needs, as `merge-local` does without a flag; `check` runs the spec base check, a stale
  or missing entry refuses archive, and a change with no `specs-base.json` gets a warning naming
  the fallback to the merge base; the report names the capabilities `verify.md` lists as
  hand-edited and says the corpus lint is due; the finalize report says the merge request is
  ready to merge; a test feeds archive's git reads a failed call and a detached HEAD.
- Decisions changed while closing: `verify.md`'s "never delete the worktree without an explicit
  yes" — the removal is archive's last step, with no separate yes; `english-check.md`'s merge
  request description — the body is an ignored file outside the change, so no hook checks it,
  and the archive instruction states English.
- `claude plugin validate .`: not run here; run by the developer.
- Not run: `/adf:archive` end to end by an agent (iteration 14), forge on real systems
  (iteration 18).
- Open: the review's own retry counter is separate from `dispatch.mjs attempt` (closed in
  iteration 10a: the review stage counts its replies in the shared attempts log, keyed by the
  dispatch name, `docs/iterations/10a-structured-replies.md`); a spec base refreshed after a rebase takes the current main text, so it cannot see an edit
  made before the refresh; the stay-on-branch mode does not exist in the port, so `workspace
  remove`'s `in-place` state is only reported.
- Versions: adf 0.9.0, memory 0.1.0, english-check 0.4.0, gitlab 0.2.0 unchanged.
