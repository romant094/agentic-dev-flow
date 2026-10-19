# Iteration 11 — Metrics and retrospective

## Goal

Archive writes one checked JSON metrics record per change, by script, from the JSON the flow
keeps (attempts events, test-run records, review and verify state, the ledger), from git and from
the harness's session transcripts for tokens and time. The record is committed in the change's
archive directory. A manual retrospective reads the records of a window of changes: a script
computes every number, the delta and the candidates; one agent reasons over them and replies in
JSON; a script checks the reply, renders the report into `.adf/retro/`, commits it on its own
branch and opens its merge request with no CI run. The retrospective assesses how the flow
works and nothing else: it writes no debt. When a provider of the new `upstream` role is
installed (the maintainer plugin, iteration 10b), it files the retrospective's flow findings
upstream. The rules and their reasons are in `docs/lessons/metrics.md` and
`docs/lessons/retro.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/transcripts.mjs`, the one runtime-specific module (`runtime: "claude-code"`): project keys (three encodings of the repository path and the git common dir, plus worktree keys), sessions from the ledger's `session` ids first, then `gitBranch` slices, one parse per file, response rows deduplicated by `message.id` with the final record preferred and placeholders flagged, subagent transcripts and `.meta.json`; no transcripts is `null` with the reason | `transcripts.spec.mjs` on synthetic JSONL: streaming duplicates, a worktree key, a sidechain, a missing subagent file, a session on another branch |
| 2 | `lib/metrics-facts.mjs`, pure: tokens by actor, phase, model and level; cache TTL (cold resume gap over 300 s); outliers near the turn ceiling with `maxTurns` from `agents/*.md`; autonomy; timing with gaps capped at 300 s; peak context and compactions; phases from the ledger's `session --phase` records, then `/adf:<x>` tags; a record whose active time is all `other` gets a coverage warning | `metrics-facts.spec.mjs` |
| 3 | `classify(description)` on `parseName`: every fixed dispatch form, the Superpowers nouns `implementer`, `reviewer`, `re-reviewer`, `fixer`, `investigate <topic>`; anything else `exact: false` | `metrics-facts.spec.mjs` |
| 4 | `lib/metrics-records.mjs`: readers over the SDD directory (attempts events and results, test runs, review state, verify run, ledger), each absent source `null` with a reason; wave-1 fan-out "performed" from the group dispatch names in `attempts.jsonl`; the severity map `critical` → `CRITICAL`, `important` → `HIGH`, `minor` → `MEDIUM`, native and mapped counts both kept | `metrics-records.spec.mjs` from fixtures written by the real writers (`recordReply`, `suite.mjs`, `review-state`, `verify`) |
| 5 | `schema/metrics.schema.json` `schemaVersion: 2`, `buildRecord`, `fromV1` for the origin's 28 records, `contract/metrics-format.md`; tokens only, no prices in a record; git figures from the change's range, never the working tree | `metrics.spec.mjs`: a record validates; fixtures of every origin record shape convert |
| 6 | `lib/prices.mjs`: the dated price table, one file per entry `.adf/prices/<date>.json` (`{ from, source, models }`); `fetch` from the registry's `metrics.pricesUrl` (its default in `lib/transcripts.mjs`), parsed as the origin's table parser does; an entry written only when the prices changed; `costOf` takes, for each response, the entry in force at its time; a failed fetch keeps the last entry and the result says so; no entry at all leaves cost unpriced | `prices.spec.mjs`: a change of prices, an unchanged page, a failed fetch, two branches adding the same entry, a response before the first entry |
| 7 | `scripts/metrics.mjs`: `extract --change [--out]`, `render --file`, `candidates`, `cost --file`, `prices fetch`; one JSON object; exit 1 refused, 2 usage | `metrics-cli.spec.mjs` |
| 8 | Archive steps `metrics` and `commit-metrics` after `commit-memory`: the record and a copy of `attempts.jsonl` in the archive directory, a new price entry when fetched, committed through `commit.mjs --only` as `chore(metrics): record <name>`; the ingest dispatch is in the record; no transcripts is `degraded`; an invalid record is `failed`; resumable | `archive.spec.mjs`: the record in its own commit, a failure injected at each new step, a re-run idempotent |
| 9 | Archive report: changes since the last window retro (the integration ref and its fetch age), the corpus lint due at 3 or more, removal candidates, the "hurt" signals the record shows (a stopped dispatch, the review round cap, a compaction) with a suggested retro of that change | `archive.spec.mjs` |
| 10 | Contract `1.4`: the forge operations `open`, `push` and `finalize` take an optional `ci` (default `true`); `ci: false` pushes with no CI run, and a provider that cannot do that refuses with nothing sent. The `gitlab` plugin pushes with `-o ci.skip`. `/adf:archive --no-ci` passes it to `mr`, kept in the archive state. New role `upstream` (`check`, `file`), default with no provider: the retro's findings stay in its sidecar | `roles.spec.mjs`, `archive.spec.mjs`, `plugins/gitlab` specs |
| 11 | `lib/window.mjs`: modes window (default, from the last window sidecar in `.adf/retro/` in the integration ref's tree, read after a fetch), `--change <name>` and `--from <date> --to <date>`; only a window retro anchors the next window; first-parent membership with one log parse; git figures (diff lines with exclusions, fix commits after merge once per merge, exposure per change-week); in-memory re-measure, never written, never zero; aggregates per change, task and kLOC; delta by a fixed direction per metric; waiting items from `schema/retro-waiting.json` | `window.spec.mjs` in real git repositories: a merge carrying two changes, an unmerged retro, a change retro that does not move the window, a backfilled record |
| 12 | Role `retro` at level `architecture`, `prompts/retro.md`, `schema/retro.schema.json` (`nothingFound`, `findings` with class, changes, evidence keys, cost key, where it could have been caught, plugin, body; `decisions` on the waiting items; `removalCandidate`; `improvements`); `lib/retro.mjs` input, check and compute: every evidence, basis, cost and saving key exists; every waiting item answered once; the removal candidate computed or listed, or `none` with a reason; a finding's plugin enabled or installed, its version filled by script; `nothingFound` with findings refused; one retry, a second invalid reply stops | `retro.spec.mjs`: a valid reply; an unknown key, an unanswered item, a made-up candidate each refused; two invalid replies stop |
| 13 | `scripts/retro.mjs`: `start` (branch `chore/retro/<date>` and its worktree from the integration branch, resumable state), `window`, `reply`, `render` (`.adf/retro/<date>-<mode>.md` and `.json`), `record` (`commit.mjs --only` the two files, `docs(retro): <mode> retrospective <date>`), `publish` (`forge.open` with `draft: false` and `ci: false`; no forge: a local merge on the developer's yes; never merges with a forge), `file` (the `upstream` role, after the developer's yes), `since`, `state` | `retro-cli.spec.mjs`, with a forge, without one, with an `upstream` provider and without one |
| 14 | Registry `metrics.pricesUrl` (default, not asked by `/adf:init`); `.adf/` documented as the core's committed host directory | `registry.spec.mjs` |
| 15 | Surfaces: `commands/retro.md`, `schema/instructions/retro.md`, `commands/archive.md` and `instructions/archive.md` (the steps, `--no-ci`, the report) | `schema.spec.mjs`, `flow-regression.spec.mjs` |
| 16 | Parity tools: `origin-metrics-records.mjs` (the 28 records through `fromV1`, recomputed from committed data), `origin-metrics-transcripts.mjs` (the origin's extractor against the port's on surviving transcripts; skipped without them), `origin-window.mjs` (the origin's `--window --no-prices` against `retro.mjs window`), `origin-since.mjs`, and the findings per layer from the reply corpus against the records (the 10a open item) | `npm run parity -- <origin>` |
| 17 | Lessons `docs/lessons/metrics.md` and `retro.md`; close the 13 rows pending on iteration 11; roadmap rows 10b and 11; versions adf 0.11.0, gitlab 0.3.0 | `check-lessons.mjs`; `npm test` |

## Decisions

Settled by the developer on 2026-10-19.

- Metrics and the retrospective are the core's: `/adf:retro`, the record written by archive,
  its format published as `contract/metrics-format.md`. The maintainer plugin (10b) has no
  "retro" command of its own; it provides the role `upstream`.
- Retrospectives are committed in `.adf/retro/`, never in a gitignored place. The next window
  starts at the last window retrospective. The modes are the window, one change and a period;
  only the window moves the start. The session-ID mode is dropped: a session belongs to a change
  through the ledger.
- The retrospective assesses the flow only and writes no debt: product debt is the ingest's,
  flow debt records are archive's.
- The retrospective has its own branch `chore/retro/<date>`, its own worktree and a non-draft
  merge request pushed with no CI run.
- Prices change over time, so a record keeps tokens only and cost uses the dated price table
  in force at each response's time. Archive fetches the table and adds an entry only when the
  prices changed.
- The record is written after the ingest is committed, in its own commit, so the ingest is
  measured. The merge request's prose is not measured: its cost is negligible.
- `attempts.jsonl` goes into the archive with the record.
- Normative Surface Size is not ported: the port measures cost from transcripts directly, and
  the metric nets a relocation to zero and reads the working tree.
- Skipping CI is a forge option, `ci: false`, never a marker in a title or a commit message.
- Port fixes of origin defects: wave-1 "performed" from the dispatch log, not from `git worktree
  list` after the group worktrees are gone; phases from the ledger, not only from command tags;
  one extraction, so no ledger refresh that forgets to recompute `rulings`.
