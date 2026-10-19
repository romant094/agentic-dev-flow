# Metrics record format

The core writes one metrics record per change: `metrics.json` in the change's directory,
committed with the change's archive. `scripts/metrics.mjs extract` builds it by script from the
change's SDD records, its session transcripts and git; `schema/metrics.schema.json` checks it, and
a record that fails the schema is not written. `scripts/lib/metrics.mjs` is the reader:
`fromV1` converts the origin's records, `cost` prices a record and `renderRecord` shows it to a
person. A plugin reads records; it never writes one.

## Rules

- **Tokens, never prices.** A record holds token counts only. Cost is computed when a record is
  read, with the dated price table `.adf/prices/<YYYY-MM-DD>.json`: each model's tokens of each
  UTC day at the entry in force on that day (`metrics.mjs cost`).
- **Absent is null, never 0.** Every group is an object (an array for `dispatches`, `outliers`
  and `compliance`) or `null`. `sources.coverage` names every group: `"record"` when it is
  present, `{ "none": "<reason>" }` when its source is absent. A `null` field inside a present
  group is unknown; the group of its source names why.
- **Git figures from the range.** `range` is `git merge-base <base> HEAD` .. `HEAD` of the change
  branch; nothing is read from the working tree.
- **No machine paths.** A reason names the checkout as `.`, the home directory as `~`.

## Top level

| Key | Holds |
|---|---|
| `schemaVersion` | `2` |
| `change`, `branch`, `base` | the change's name, its branch, the branch it merges into |
| `range` | `{ base, head }`: the commits the git figures come from |
| `generatedAt` | when the record was built (ISO 8601, UTC) |
| `generator` | `{ plugin: "adf", version, plugins: { <name>: <version> } }`: the core's version and every enabled plugin's, from their manifests |
| `sources` | see below |
| the groups | see below |

`sources`:

- `transcripts`: `{ runtime, sessions, unresolved }`. `runtime` is the harness whose transcripts
  were read (`claude-code`). Each session: `id`, `source` (`ledger`, `branch` or `both`: named
  by the ledger, found on the change branch, or both), `resolved`, `scope` (`branch` when only
  its records on the change branch count, `session` when all do), `first`, `last`,
  `phaseSource` (`ledger`, `commands` or `none`). `unresolved`: ledger sessions with no transcript.
- `disagreements`: `{ sessionId, issue }` where the ledger and the transcripts disagree on the
  change's sessions.
- `coverage`: one entry per group, and `transcripts`, `range` and `generator`.
- `warnings`: what the reader of the record must know, such as all active time falling in phase
  `other`.
- `convertedFrom` (only on a converted record): the schema version it came from.

## Groups

| Group | Source | Holds |
|---|---|---|
| `dispatches` | transcripts | one entry per dispatched agent: `name` and what it classifies to (`role`, `task`, `group`, `round`, `exact`: false for a guessed name), `actor` (`controller` or `worker`), `agentType`, `level`, `model`, `effort`, `phase`, `turns`, `tokens`, `startedAt`, `endedAt`, `coldResumes`, `activeMinutes`; a dispatch whose transcript is gone is `missing` with a `reason` and null figures |
| `tokens` | transcripts | `total` and `byActor`, `byPhase`, `byModel`, `byLevel`, each a bucket `{ input, output, thinking, cacheRead, cacheWrite5m, cacheWrite1h, turns, placeholderTurns }`; `byModelDay`: `{ <model>: { <YYYY-MM-DD>: { input, output, thinking, cacheRead, cacheWrite5m, cacheWrite1h } } }`, by the UTC day of each response (`undated` when it has no time); `dayBasis`: `response` |
| `context` | transcripts | `peakBySession` (the largest context of a response, per session), `compactions` |
| `cacheTtl` | transcripts | `coldResumes` (gaps over 300 s up to an hour), `beyondOneHour`, `rewrittenTokens` (5-minute writes after a cold resume), `write5m`, `byModel` |
| `outliers` | transcripts | dispatches with `reasons` `near-ceiling` (half the level's `maxTurns` or more) or `above-role-median` |
| `timing` | git, transcripts | `proposedAt` (the first commit adding the change directory), `extractedAt`, `elapsedMinutes` between them, `first` and `last` transcript times, `activeMinutes` `{ total, byPhase }` with gaps capped at 300 s, `tasks` (the checkboxes of `tasks.md`), `minutesPerTask` |
| `autonomy` | transcripts, ledger | `developerMessages`, `askUserQuestion`, `clears`, `sessions`, `rulings` |
| `replies` | `attempts.jsonl` | per role: `dispatches`, `valid`, `invalid`, `retries`, `stops` |
| `impl` | `attempts.jsonl` | the accepted impl replies per status: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT` |
| `tests` | `tests/*.json` | `runs`, `failed`, `uncounted` (no count line), `unreadable` |
| `findings` | `attempts.jsonl`, `review/` | per layer `review`, `re-review`, `final-review`, `merge-review`, `sweep`, `ai-review`: `dispatches`, `findings`, `native` (per the layer's own severity), `mapped` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`; null for the sweep, which has no severity), `uncounted` (accepted replies with no computed result); a layer that did not run has no entry |
| `review` | `review/` | `verdict`, `rounds`, `dispositions` per kind, `stopped` |
| `verify` | `verify/` | `verdict`, `checks` (`{ <id>: pass, warn, fail, not-run or ruled }`), `warnings` `{ check, summary }`, `filesOutsidePlan` |
| `ledger` | `ledger.jsonl` | `counts` per kind, `unresolvedDebt`, `deviations`, `handoffs`, `rulings`, `sessions` |
| `isolation` | verify, transcripts, git | `filesOutsidePlan` (verify's out-of-plan files), `foreignBranchRecords` (records on another branch inside the change's sessions), `strayWorktrees` (`{ path, branch }` worktrees on the change branch or one of its group branches still present, other than the one the record was built in) |
| `compliance` | `plan.md`, `attempts.jsonl` | `{ rule, required, performed }`: for `wave-1 fan-out`, the wave-1 group letters the plan requires and those a group dispatch ran for |
| `maintainability` | git | `insertions`, `deletions`, `perFile` `{ file, insertions, deletions }` (null counts for a binary file), `capabilities` (lines changed under each delta spec capability) |

The apply reviews' severities map onto the review stage's scale: `critical` to `CRITICAL`,
`important` to `HIGH`, `minor` to `MEDIUM`.

## Records of schema version 1

The origin wrote `schemaVersion: 1`. `fromV1` converts one; every reader of records takes both
(`metrics.mjs render`, `cost`, `candidates`). What the origin did not keep, or kept in a form
with no version 2 form, is `null`, its coverage reason starting `v1:`: `generator`, `context`,
`replies`, `impl`, `tests`, `review`, `verify`, `compliance` (kept as booleans), a ledger of the
markdown progress log, per-file and per-capability churn. Its layer `opsx-review` is `ai-review`;
its findings have no severity split (`native` and `mapped` null). Its tokens have no per-day
split: `byModelDay` puts a model's tokens on the record's own UTC day, the day the origin priced
them, and `dayBasis` is `generatedAt`. Its prices, cost, velocity and normative-bytes figures are
not carried.
