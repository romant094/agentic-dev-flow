# Iteration 10a — Structured replies

## Goal

Every agent role of apply and verify replies in JSON under a schema the core owns, as `ai-review`,
`ai-fix`, `spec-merge` and `ingest` already do. A script checks each reply and computes every
verdict from it: the implementer's status, the test result and its counts, each review's verdict,
the sweep's verdict and the verify sections' verdicts. A script renders the text a person reads.
One retry mechanism serves every role. Iteration 11 then reads JSON, never prose.

The apply roles already reply in JSON (the origin's `check-reply.mjs` table, ported whole in
iteration 07). What changes: the shapes become JSON Schema files under `schema/`; the LLM no
longer states a verdict; the test evidence is a script record, not a free-text summary; the
verify c4 and c8 sections become checked replies.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/json-schema.mjs`: `validateJson`, `parseReply`, `readSchema`, `unknownKeywords` moved from `lib/review.mjs`, re-exported there; `review`, `spec-merge`, `ingest` import it | existing `review`, `spec-merge`, `ingest` specs unchanged and green |
| 2 | Schemas `impl`, `task-review`, `re-review`, `sweep`, `investigate`, `verify-c4`, `verify-c8` under `schema/`; every schema uses known keywords only | `replies.spec.mjs`: a valid and an invalid fixture per schema, `unknownKeywords` empty |
| 3 | `suite.mjs covering --change --name --command --worktree [--root]`: runs the covering tests through `runOnce` and writes `tests/<name>-<stamp>.txt` and `.json` `{ command, exit, counts, failing, outputFile }`; the implementer runs its tests only this way | `suite.spec.mjs`: pass, fail, timeout and a runner with no count line |
| 4 | `lib/reply.mjs` rewritten as the role table `{ schema, check, compute }`: impl status, commits from git, test result from the records, out-of-scope files, `next` and the package range; review ids, spec and quality verdicts, `clean/fix/rule`; re-review open set; sweep verdict and the disposition coverage; `spec-merge` v1 role removed | `reply.spec.mjs` in real git fixtures: a sha outside the range refused, a failing run refused for `done`, a file out of scope becomes DONE_WITH_CONCERNS |
| 5 | `lib/attempts.mjs` and `dispatch.mjs reply`: the events, `next` retry/stop from the invalid count, legacy lines read as `dispatch`; `roundOf` unchanged | `dispatch.spec.mjs`: two invalid replies give `stop`; a legacy `attempts.jsonl` gives the same rounds |
| 6 | `review-state.mjs` and `review.mjs` on the shared events: `attempts.json` removed, the key the dispatch name, `review.mjs fix --finding`; `specs.mjs resolution` and `archive.mjs ingest` record through it | `review-state.spec.mjs`: two fixers with invalid replies no longer share a key; `archive.spec.mjs` retry and stop |
| 7 | Loop state by script: the fix and re-review prompts render the open findings; `deferred.json` fed to `final-review`; the `tdd-proof` result attached to the review and its critical finding added (if open question 3 is yes) | `dispatch.spec.mjs`, `tdd-proof.spec.mjs` |
| 8 | `tasks.mjs tick --plan-task` refuses unless the task's computed state is `clean` or each open id has a `ruling --finding`; `apply-status` shows the open sweep findings and refuses `complete` while one is open | `tasks.spec.mjs`, `apply-status.spec.mjs`, `dup-sweep.spec.mjs` |
| 9 | Verify: the c4 and c8 sections become replies under their schemas; the verdict computed; `proseEdits` and the REMOVED/RENAMED list given by script and cross-checked; c8 patches checked with `git apply --check` and joined into `c8.diff`; `assemble` renders from JSON; `<id>-agent.txt` dropped | `verify.spec.mjs`: each kind's verdict, an unanswered candidate refused, a bad patch refused |
| 10 | `reconcileCounts` reads the test-run records instead of `tests.summary` | `verify.spec.mjs` |
| 11 | `reply.mjs render --file`: the markdown of any reply for the developer (escalation, sweep findings, c8 edits) | `reply.spec.mjs` |
| 12 | Surfaces: skeletons `reply.md` (the schema path in place of the `.mjs` header), `implementer.md`, `reviewer.md`, new `re-review.md`, `sweep.md`, `test-first.md`, `verify*.md`; `instructions/apply.md` (the reply section, a new ruling over the SP defaults, the tick), `verify.md`, `review.md` step 7 (the retry), `archive.md`; the verbatim blocks | `dispatch.spec.mjs` verbatim, `schema.spec.mjs`, `flow-regression.spec.mjs` |
| 13 | SP concept guard: a test reads the installed `SKILL.md` and asserts the statuses, the two verdicts and ADDRESSED that the computed result maps | `sdd-skill.spec.mjs` |
| 14 | Parity: `origin-reply.mjs` through the v1→v2 converter with difference classes; new `origin-reply-corpus.mjs` over the transcripts; `origin-sdd.mjs` unchanged | `npm run parity -- <origin>` |
| 15 | Lessons: change rows `apply.md:95`, `:97`, `:124`, `verify.md:98`, `:150`, `:151`, `review.md:116`; close the open item of `docs/iterations/10-archive.md:100`; record 10a in `docs/iterations/10a-structured-replies.md`; adf 0.10.0 | `check-lessons.mjs`; `npm test` |


## Decisions

Settled by the developer on 2026-10-19.

- The apply reviews keep Superpowers' severity scale `critical`, `important`, `minor`; iteration
  11 maps it to the review stage's scale for one chart.
- The implementer runs its covering tests only through `suite.mjs covering`; the reply names the
  records.
- The orchestrator's script runs `tdd-proof` after a `done` test-first task, before the review,
  with the share paths from the planning guide's `## Test-first shares` section; without that
  section the reviewer runs it as today.
- One retry semantics: resume the same agent with the errors; a fresh dispatch only where the
  harness cannot resume.
- A new mechanism's path that nothing exercised (`exercisedBy: null` in c4) is a warning.
- Iteration 11 extracts replies and events before the archive move; 10a keeps everything under
  `.superpowers/sdd/<change>/`.
- A parity tool may read the machine's session transcripts and reports `skipped` without them.
- The raw verify output `<id>-agent.txt` is dropped; the record is rendered from the JSON.
- Fixed here: a fixer's retry key came from its reply's content, so two fixers with invalid
  replies shared a key and the second stopped the stage; the key is now the dispatch name.

## Result

- `npm test`: 753 tests, 752 pass, 0 failures, 1 skipped (the live openspec parity, with
  `OPENSPEC_DIST` not set); `check-lessons.mjs`: ok, 706 rows, 53 pending, none pending on 10a.
- `npm run parity -- <origin>`: all seventeen tools PASS. The two reply tools:
  - `origin-reply.mjs`: 1388 cases through the v1-to-v2 converter; the origin accepts 333 and
    refuses 1055, the port accepts 316. Explained classes: `role-removed` 115,
    `verdict-computed` 105, `tests-structured` 56, `text-nonempty` 21, `line-integer` 15,
    `commits-from-git` 8, `dispositions-checked` 6, `blocker-required` 4, `cli-form` 1.
    Computed differences on cases both accept: `DONE` to `DONE_WITH_CONCERNS` for no count line
    22 and for the agent's concerns 4, `DONE_WITH_CONCERNS` to `DONE` for the agent's concerns
    4, a computed verdict 12. 0 unexplained.
  - `origin-reply-corpus.mjs`: 1004 transcripts, 313 distinct replies (heredoc and write):
    `review` 91, `impl` 95, `fix` 62, `re-review` 28, `investigate` 8, `sweep` 8,
    `final-review` 8, `merge-review` 8, `spec-merge` 5 (`role-removed`). Explained:
    `commits-from-git` 8 (`impl` 6, `fix` 2), `role-removed` 5. 0 unexplained. 88 of the 146
    done `impl` and `fix` replies both accept (46 `impl`, 42 `fix`; 88 of the 91 the origin
    marked `DONE`) become `DONE_WITH_CONCERNS`, because the origin's summary carried no count
    line. In the port the count comes from the runner's output through `suite.mjs covering`,
    so this is a deliberate difference, not a regression.
- Fixes: a fixer's retry key came from its reply's content, so two fixers with invalid replies
  shared a key and the second stopped the stage; the key is now the dispatch name. The review
  stage's own retry counter is gone: it counts its replies in the shared attempts log
  (`lib/attempts.mjs`), as every other role does. Found while closing: `dispatch.mjs reply`
  for `sweep` also writes the dispositions as debt, so one call records a sweep reply
  (`sweep.mjs filter` stays for manual use); each apply role's prompt names its exact schema
  path through `{{schema}}` (`lib/dispatch.mjs` `APPLY_SCHEMAS`, which `lib/reply.mjs` checks
  under); the record marks a c4 path nothing exercised `not exercised (warning)` under
  `## Exercised and not exercised`.
- Decisions confirmed by the developer: c4 `decision-untraced` and
  `requirement-contradicts-decision` are warnings; a verify section needs a recorded reply; the
  c4 `case` is checked against the change's files; a c8 patch edits only its candidate's file.
- Template default: a `## Test-first shares` section in `host/planning.md` makes the flow run
  the test-first proof before the review; without it, the reviewer runs it.
- `claude plugin validate .`: not run here; run by the developer.
- Not run: an agent end to end (iteration 14).
- Open: a defect found while checking an unverifiable item (`U<n>`) cannot be ruled `fix`, as
  there is no path to add it as a finding; the corpus count drifts as transcripts grow; the
  `metrics.json` findings comparison is iteration 11's.
- Versions: adf 0.10.0, the root `package.json` 0.10.0; memory 0.1.0, english-check 0.4.0,
  gitlab 0.2.0 unchanged.
