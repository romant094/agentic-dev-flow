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
| 2 | Three-way check: for every MODIFIED, REMOVED and RENAMED requirement, the main text now against the main text at the change's merge base; a requirement edited since is a `conflict` with the three texts; `--resolutions <file>` applies replies for the conflicts only | `specs-merge.spec.mjs` against real git repositories |
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
