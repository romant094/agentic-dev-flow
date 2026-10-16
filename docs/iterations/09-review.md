# Iteration 09 — Review

## Goal

`/adf:review` runs the project's tuned review over a verified change, fixes its blocking findings
in bounded rounds, and commits a record archive can trust. The reviewer and the fixer reply in
JSON, checked by script. Every deterministic step is a script: the range, the filter, the
reviewer's input, the reply check, the verdict, the fix plan, the dispositions, the markers and
the record. The LLM keeps the review itself, the fixes, the false-positive reasoning, the talk
with the developer and the reason a recorded finding was left. The port builds no CI runner: the
developer rebuilds the CI review from the plugin's scripts. The rules and their reasons are in
`docs/lessons/review.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/review.mjs`, pure: the default exclusion list (`.md` excluded) and the registry's `review.exclude` and `review.include`; the input builder (the host prompt from `review.prompt`, the core's JSON-schema block and marker grammar, `Here is the MR diff:` and the diff); the reply check against `plugins/adf/schema/review-findings.schema.json`; the verdict from the findings and the registry's `review.blockOn` (default CRITICAL and HIGH) | `review.spec.mjs` |
| 2 | `lib/marker.mjs`: the comment table moved out of `lib/dup.mjs`; the grammar `ADF IGNORE <key> -- <reason>`, the pair `ADF IGNORE-START` / `ADF IGNORE-END`, beside `ADF DUP` | `marker.spec.mjs`; `dup-sweep.spec.mjs` unchanged on the shared table |
| 3 | `review.mjs start`: the range from the change's base (`origin/<base>` merge base to HEAD), or `--range` with a ledger ruling; the filtered and the excluded file lists; empty; size against `review.maxBytes` and, over it, slices by directory with a byte-coverage proof; a warning when the plan's `**Files:**` paths are untouched by the range. `review.mjs input --round <k> [--slice <n>]`: the reviewer's input file; for k ≥ 2 the fix range from the round's recorded base sha, the findings the fixes target and each fix's failure mode | `review.spec.mjs` against real git repositories |
| 4 | Dispatch: the roles `ai-review r<k>` (level `architecture`) and `ai-fix F<n> r<k>` (level `integration`, one level up from round 2); the skeletons `ai-review.md` (read the one input file, no other tool, the JSON reply, distrust the previous round from round 2) and `ai-fix.md` (one finding, one file, a fix or a false-positive claim, the failure mode); the fixer's reply shape in `lib/reply.mjs`; an invalid reply gets one retry, a second stops the stage | `dispatch.spec.mjs`, `reply.spec.mjs` |
| 5 | `review.mjs response` (an invalid reply is refused; a second invalid reply stops the stage, no record), `fixplan` (waves by file), `disposition` (`fixed` with a sha in range touching the file; `dismissed` with a developer ruling and a marker, or a line absent from the head; `accepted` with a ruling; `recorded` for a non-blocking finding with a body file), `mark` (the marker in the file's own comment syntax), `markers` (lists and validates every marker, refuses a keyless one), `round` (cap three; a ruling allows one more) | `review.spec.mjs` |
| 6 | The suite after the last fix: `suite.mjs run` with the base check when any fix landed; the result goes into the record and a new failure blocks the verdict | `suite.spec.mjs` |
| 7 | `review.mjs assemble [--not-reviewed] [--commit]`: renders `review.md` from the JSON round files, the dispositions and the ledger rulings; reads HEAD itself; refuses a dirty tree outside `review.md`, a recorded or accepted finding without a body, an open disposition; computes `PASS` or `BLOCKED`; commits the record alone; returns the report. `review.mjs check <file>`: parses a record (verdict token, sha, counts, rounds, dispositions), for archive (iteration 10) and the parity tool | `review.spec.mjs` |
| 8 | Standalone use: `review.mjs input`, `response` and `render` run on `--range` with no change directory and no Claude Code dependency; `render` writes the human-readable text from the JSON | `review.spec.mjs` in a bare git repository with no change directory |
| 9 | `preflight.mjs --phase review`: the Superpowers gate, the worktree, a protected branch refused, the change exists, the verify record's `Verdict:` line not `FAIL`, no commit outside the change directory after the verify record, the session recorded | `preflight.spec.mjs` |
| 10 | Schema and surfaces: the review artifact's instruction and template; `instructions/review.md`; `commands/review.md` (effort medium, step 1 the preflight); the default prompt, criteria only, that `/adf:init` installs at the registry's `review.prompt` when the host has none; the registry's `review` keys validated in `lib/registry.mjs` | `schema.spec.mjs`, `changes.spec.mjs`, `registry.spec.mjs`, `flow-regression.spec.mjs` |
| 11 | The English check: `review.mjs` in the core's list of scripts that commit (`assemble --commit`, `mark --commit`) | `hook.spec.mjs`, `flow-regression.spec.mjs` |
| 12 | Parity tools: `origin-review-records.mjs` (the 52 archived records: the origin's archive extraction and metrics read against `review.mjs check`) and `origin-review-filter.mjs` (the merged merge requests: the origin's local and CI file lists against the port's default filter) | `npm run parity -- <origin>` |
| 13 | Close the rows pending on iteration 09 in `review.md`, `apply.md`, `forge-gitlab.md`, `verify.md`, `superpowers-gate.md` | `check-lessons.mjs` |

## Decisions

- Agent-to-agent information is JSON, checked by script. The reviewer replies under a schema the
  core owns (`review-findings.schema.json`): a summary and the findings, with no verdict field.
  The fixer replies with the finding, the outcome (`fixed` or `false-positive`), the failure mode
  and an optional sha and argument. An invalid reply gets one retry; a second stops the stage.
- The script computes the verdict: BLOCKED while a finding whose severity is in `review.blockOn`
  is open, else PASS. The origin's "Overall cell disagrees with the counts" no longer exists.
- Scripts render the human-readable text (`review.md`, a future merge request comment) from the
  JSON.
- The host prompt holds the criteria only. The core appends the JSON-schema block and the marker
  grammar. `/adf:init` installs a default prompt when the host has none. Nothing names a model.
- Markers: `ADF IGNORE <key> -- <reason>` and the pair `ADF IGNORE-START` / `ADF IGNORE-END`,
  beside `ADF DUP`, in one shared `lib/marker.mjs`. A keyless marker is refused. A script
  migrates the origin's markers at the switch (iteration 15).
- One exclusion list, `.md` excluded by default; the registry's `review.exclude` and
  `review.include` adjust it; the record states how many files were excluded.
- Over `review.maxBytes`, `start` proposes slices by directory with a byte-coverage proof; the
  developer approves them by a ledger ruling; one reviewer per slice; the findings are merged.
- The scripts take `--range` without a change; the command path for that is iteration 17.
- Dispatch roles `ai-review r<k>` and `ai-fix F<n> r<k>`: the reviewer at `architecture`, the
  fixer at `integration`, one level up from round 2.
- After the last fix commit, `suite.mjs run` with the base check; the result is in `review.md`,
  and a new failure blocks the verdict.
- One verdict route, PASS or BLOCKED. A ruling with a reason accepts a blocking finding. The cap
  is three rounds; a ruling allows one more, and the record names it. Review calls no forge
  operation.
- Preflight for review: the verify record's `Verdict:` is not FAIL, and no commit outside the
  change directory follows the verify record.
- No CI runner and no CI template in the port. The developer rebuilds the CI review from the
  plugin's scripts and prompts, so `input`, `response` and `render` run standalone on `--range`.
  The lessons rows about the CI job are rejected for the port.
- `review.mjs` joins the core's list of scripts that commit, for the English check.
- Roadmap: 09, then 10, then 10a (every other agent role replies in JSON), then 11.
- The origin's CI fetches every diff page (`review.sh:40-66`): no pagination defect. The silent
  drop of collapsed files (`review.sh:73`) is a real origin defect.
