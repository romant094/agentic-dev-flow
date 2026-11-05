# Iteration 20 — Quick task: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/adf:quick` fixes a small defect that changes no behaviour, from a key, a phrase or the project's open bugs to a merge request and `/adf:land`, with one `quick.md`, the affected tests, one short review, the ingest when a knowledge plugin is enabled, and a metrics record.

**Architecture:** A change names its cycle in `meta.schema`: the core's schema is renamed `full` (`adf` read as `full`), and a second schema `quick` lives in `plugins/adf/schema/quick/` with one artifact, `quick.md`. One new script, `plugins/adf/scripts/quick.mjs`, holds the quick task's own deterministic steps (the large-item filter, the estimate's input and reply check, the affected tests); everything else is reused: `scope.mjs` (gather, select, start), `propose.mjs create`, `forge.mjs`, `review.mjs`, `archive.mjs`, `metrics`. The tracker gets one operation, `bugs` (contract 1.11).

**Tech Stack:** Node 20+, standard library only, `node:test`; `git` and the affected-tests command through `spawnSync`, injectable for tests.

**Spec:** `docs/iterations/20-quick.md`

## Global Constraints

- English only in every artifact; Conventional Commits; no `Co-Authored-By` or tool credit in a commit or the PR.
- Gate every commit on the tests: `npm test && git commit ...`; push after each commit; never force, never amend, no `git stash`.
- Branch `feat/20-quick` stacked on `feat/19-merge-request-links` (the developer's decision, 2026-11-05); one PR into it. Contract version `1.11` (19 took `1.10`).
- The cycles are named `full` and `quick`; `adf` in a change's metadata means `full`; nothing in flight or archived is migrated.
- A quick change never writes `openspec/specs/`, `proposal.md`, `tasks.md`, `plan.md` or `verify.md`.
- The plan in `quick.md` has 1 to 3 steps; more is refused by the `quick-plan` gate.
- The large-item filter (exact): a tracker item of kind `epic` or `story`; a debt item whose `class` is not `defect`; a debt item with more than 3 distinct files in its `anchors`.
- The quick phases in the ledger (exact names): `gather`, `estimate`, `code`, `tests`, `review`, `end`.
- `metrics.json` gets the optional top-level key `cycle`: `full` or `quick`; a record without it reads as `full`.
- A flow change updates its guide pages in the same commit (`docs/roadmap.md`, `## Checks after every iteration`): each task's commit also updates every page of `docs/guide/` whose `sources:` match a file the task changes; `check-guide.mjs` in `npm test` gates it. No task writes `CHANGELOG.md`; the release writes the section of its version from the flow and plugin changes, and a documentation change gets no entry (the documentation is `docs/`, `README.md`, `CHANGELOG.md` and a plugin's own `README.md`; a skill, a command, an instruction or a template is the flow).
- Subagents never commit; the controller commits and checks each commit for a forbidden trailer.

## Ruling against the design

The design records the archive's `placements` step as skipped for a quick change. That step also resolves the debt entries the change took (`resolveTakenDebt`, `lib/archive.mjs:458`), which a quick task needs. Ruling: `placements` runs as in the full cycle; only `merge` (the spec merge) is skipped with the reason `quick task`. The design's line is corrected in Task 5's commit.

## Review Focus

1. A change written before this iteration, whose `.adf.json` says `"schema": "adf"`: every command reads it as `full`, and `changes.mjs status` gives the same artifacts as before (Task 1 test `a change of schema adf reads as full`).
2. `/adf:apply` or `/adf:verify` run on a quick change: preflight refuses with `<name> is a quick change; it has no apply or verify` and nothing is written (Task 1 test `preflight refuses apply on a quick change`).
3. An estimate reply that names a key not in the candidates, leaves one out, or marks a taken tracker item `quick` with no verdict: `quick.mjs estimate-check` refuses and records nothing (Task 2 tests).
4. A tracker plugin declared for contract `1.7` and `gather --bugs`: the result says the tracker has no `bugs` and the item list holds only the debt, not a crash (Task 2a test `a 1.7 tracker has no bugs`).
5. The affected-tests command with no changed test-relevant files (only a markdown file changed): the command still runs with the changed paths, and an empty `## Affected tests command` section holds the step with `waiting` instead of passing silently (Task 3 tests).

---

### Task 1: Schemas by cycle

**Files:**
- Modify: `plugins/adf/schema/schema.json` (`name` `full`)
- Create: `plugins/adf/schema/quick/schema.json`, `plugins/adf/schema/quick/templates/quick.md`, `plugins/adf/schema/quick/instructions/quick.md`
- Modify: `plugins/adf/scripts/lib/schema.mjs` (`loadSchema`, `GATES`, a new `schemaOf`), `plugins/adf/scripts/lib/changes.mjs` (`newChange`), `plugins/adf/scripts/changes.mjs` (`new --schema`), `plugins/adf/scripts/propose.mjs` and `lib/propose.mjs` (`create --schema`), `plugins/adf/scripts/lib/preflight.mjs:222`, every caller in the list below
- Test: `plugins/adf/scripts/__tests__/schema.spec.mjs`, `changes.spec.mjs`, `preflight.spec.mjs`, `propose.spec.mjs`

**Interfaces:**
- `loadSchema(name = 'full') -> schema` — `full` and `adf` load `SCHEMA_DIR`; `quick` loads `join(SCHEMA_DIR, 'quick')`; another name throws `unknown schema "<name>"; known: full, quick`. The returned schema keeps `dir`. Callers that passed a directory (`changes.mjs run({ schemaDir })`, tests) pass it as `loadSchemaDir(dir)`, the old body renamed.
- `schemaOf(root, change) -> schema` — `loadSchema(readChangeMeta(root, findChangeDir(root, change))?.schema ?? 'full')`.
- Callers that act on a named change take `schemaOf`: `changes.mjs` `status`, `instructions`, `next`, `done`, `skip`; `propose.mjs commit`; `lib/archive.mjs:382`; `apply-status.mjs:79,84`; `plan.mjs:118`; `verify.mjs:135`; `tasks.mjs:57`. Callers that only infer a name (`inferChange`) keep `loadSchema()`.
- `newChange(root, name, schema, ...)` writes `schema: schema.name` as now; `changes.mjs new <name> --schema quick` and `propose.mjs create ... --schema quick` pass `loadSchema('quick')`; the default stays `full`.
- The quick schema: `{ name: 'quick', version: 1, artifacts: [{ id: 'quick', generates: 'quick.md', template: 'quick.md', instruction: 'quick.md', gates: ['quick-plan'], requires: [] }] }`, no `apply`.
- `quick.md` template sections (exact): `## Goal`, `## Scope`, `## Plan` (numbered steps, each with **Files:**, the action and the check), `## Summary` (filled at the end: what was wrong, what changed, the tests run, the review's result).
- `GATES` adds `quick-plan` (1–3 numbered steps under `## Plan`, each naming at least one file) and `quick-summary` (`## Summary` not empty); `quick-summary` is not in the schema's `gates` — the end runs it (Task 5).
- Preflight with `phase` `apply` or `verify` on a change whose schema is `quick` refuses with the text in Review Focus 2.

- [ ] **Step 1: Write the failing tests:** `loadSchema('full')` and `loadSchema('adf')` give `name` `full`; `loadSchema('quick')` validates and has one artifact `quick`; `loadSchema('other')` throws the exact text; `a change of schema adf reads as full` (a fixture `.adf.json` with `"schema": "adf"`, `changes.mjs status` lists the full artifacts); `changes.mjs new x --schema quick` writes `"schema": "quick"` and `status` lists `quick`; `the quick-plan gate refuses four steps and a step with no file`; `preflight refuses apply on a quick change`.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/schema.spec.mjs plugins/adf/scripts/__tests__/changes.spec.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces; update every test that asserts the name `adf` to `full`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): schemas by cycle, full and quick`.

### Task 2: `quick.mjs` — the filter and the estimate

**Files:**
- Create: `plugins/adf/scripts/quick.mjs`, `plugins/adf/scripts/lib/quick.mjs`, `plugins/adf/schema/quick-estimate.schema.json`, `plugins/adf/schema/prompts/quick-estimate.md`
- Modify: `plugins/adf/scripts/lib/dispatch.mjs` (register the role `quick-estimate` beside `scope-check` at `:74`, level `integration`)
- Test: `plugins/adf/scripts/__tests__/quick.spec.mjs`

**Interfaces:**
- Consumes: the scope `scope.mjs gather` wrote (`readScope(main, change)`), `answer` of `lib/scope.mjs` for the verdicts.
- `largeItems(scope) -> Array<{ key, reason }>` — the Global Constraints' filter, reasons `kind epic`, `kind story`, `class debt`, `<n> files`.
- CLI, one JSON object, exit 1 on a refusal:
  - `quick.mjs filter --change <name>` — excludes each large candidate through `select --exclude "<key>: too large for a quick task (<reason>)"`; prints `{ ok, excluded, candidates }`. A key the developer named (`scope.from.keys`) is never excluded; it is flagged instead.
  - `quick.mjs estimate-input --change <name>` — writes `.superpowers/sdd/<change>/quick/estimate-input.md`: the prompt, each candidate with its tracker `file` or debt `files`, the reply schema; prints `{ ok, file, name: 'quick-estimate', candidates }`.
  - `quick.mjs estimate-check --change <name> --file <reply json>` — validates against `quick-estimate.schema.json`: `{ items: [{ key, fit: 'quick'|'propose', reason, files: [path], behaviourChange: boolean, verdict?: 'current'|'corrected'|'obsolete', corrections?: [string] }] }`; every candidate exactly once, no other key; a tracker item marked `quick` has `verdict`; `behaviourChange: true` forces `fit: 'propose'`. On success records each verdict with `answer` and stores the reply as `.../quick/estimate.json`; prints `{ ok, items }`.
- The estimate is read-only and gives no code.

- [ ] **Step 1: Write the failing tests** on a scope fixture (an epic, a story, a bug, a debt entry of class `debt`, a defect with 4 anchor files, a defect with 1): `largeItems` gives the four with the exact reasons; `filter keeps a named key and flags it`; `estimate-check refuses a missing candidate`, `... an unknown key`, `... a quick tracker item with no verdict`; `estimate-check turns a behaviour change into propose`; `estimate-check records the verdicts that scope.mjs start requires` (then `start` without `--yes` does not refuse on verdicts).
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/quick.spec.mjs` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** as in Interfaces; the prompt asks, per candidate, what to fix, where, roughly how many files, whether behaviour changes, and for a tracker issue whether its text is current.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): quick.mjs, the large-item filter and the estimate`.

### Task 2a: The tracker operation `bugs`

**Files:**
- Modify: `plugins/adf/contract/contract.json` (`version` `1.11`; `tracker.operations` adds `bugs`, `operationSince: { "bugs": "1.11" }`), `plugins/adf/contract/README.md` (version line; the tracker table row)
- Modify: `plugins/adf/scripts/lib/scope.mjs` (`gather` with `bugs`), `plugins/adf/scripts/scope.mjs` (`--bugs`)
- Modify: `plugins/adf-jira/scripts/lib/tracker.mjs`, `plugins/adf-jira/scripts/tracker.mjs` (USAGE), `plugins/adf-jira/adf-extension.json` (`contract` `1.11`, `bugs` in operations)
- Test: `plugins/adf/scripts/__tests__/scope.spec.mjs`, `roles.spec.mjs` (version), `plugins/adf-jira/scripts/__tests__/tracker.spec.mjs`

**Interfaces:**
- Contract row: `bugs` (since 1.11) | `quick`, in the main checkout, before the branch | `change`, `stateDir` | `items` in the shape of `gather`'s, every item `kind` `bug`, open, not `excluded`; `notes`.
- `scope.mjs gather --change <name> --bugs` — `--bugs` excludes `--keys` and `--text`; calls `bugs` in place of `gather` and merges the items as `gather`'s are merged; the debt store adds every open entry of class `defect` as an item with `matched: 'bugs'` (`debtItems`, `lib/scope.mjs:231`, gains this match), so the open defects of both sources are shown together. A provider without `bugs` (`reason: 'not-provided'`) gives `tracker.state` `none` with the report `the tracker plugin has no bugs operation (contract <v>); name a key or a phrase`.
- `adf-jira` `bugs`: the bug issue types are the profile's discovered issue types whose `kindOf` is `bug`; JQL `project in (<allowed>) AND issuetype in (<bug types>) AND statusCategory != Done ORDER BY key ASC`, limit `TEXT_SEARCH_LIMIT`; then the same reading as `gather` for the found keys. No bug type in the profile: `done`, `items: []`, note `the profile has no bug issue type`.

- [ ] **Step 1: Write the failing tests:** adf-jira `bugs builds the JQL from the profile's bug types` (fake Jira records the JQL), `bugs returns only open bug items`, `no bug type gives no items and a note`; core `gather --bugs merges the tracker's bugs and the debt's open defects`, `a 1.7 tracker has no bugs`, `--bugs with --keys is a usage error`.
- [ ] **Step 2: Run** the two spec files — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(contract): 1.11, the tracker operation bugs`.

### Task 3: The affected tests

**Files:**
- Modify: `plugins/adf/host/planning.md` (a section `## Affected tests command` after `## Whole-suite command`), `plugins/adf/scripts/lib/host-merge.mjs:12` (`MANAGED` adds it), `plugins/adf/skills/init/SKILL.md` (a step after the format command, the same shape as step 7)
- Modify: `plugins/adf/scripts/lib/quick.mjs`, `plugins/adf/scripts/quick.mjs` (`tests`)
- Test: `plugins/adf/scripts/__tests__/quick.spec.mjs`, `host-merge.spec.mjs`

**Interfaces:**
- `AFFECTED_HEADING = '## Affected tests command'`; read with `sectionLine` as `formatCommandIn` reads the format command (`lib/commit.mjs:79`); `{files}` replaced by the quoted changed paths.
- `quick.mjs tests --change <name> [--root <worktree>]` — the changed files `git diff --name-only <merge-base with origin/<base>>..HEAD` plus the uncommitted ones; empty section: `{ ok: true, waiting: 'the affected tests command: propose one from the project's test runner, and write it under ## Affected tests command in openspec/planning.md on the developer's yes' }`, exit 0, nothing run; else runs it, writes `.superpowers/sdd/<change>/quick/tests.json` `{ command, commit: HEAD, status, output (last 4000 chars) }` and prints `{ ok: status === 0, command, commit, status }`, exit 1 on a failure.

- [ ] **Step 1: Write the failing tests:** `tests replaces {files} with the changed paths` (fake runner records the command), `an empty section waits and runs nothing`, `a failing command is exit 1 and recorded`, `the record names HEAD`; host-merge `the affected tests section is managed`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): the affected tests command of a quick task`.

### Task 4: The review of a quick change

**Files:**
- Modify: `plugins/adf/scripts/lib/review-state.mjs` (`assemble` at `:618`), `plugins/adf/scripts/lib/review.mjs` (`planTouch` at `:261`)
- Test: `plugins/adf/scripts/__tests__/review-state.spec.mjs`

**Interfaces:**
- `review.mjs start --change <name>` with no `--range` already reviews the branch from its merge base (`resolveRange`, `lib/review.mjs:111`); no `review-range` ruling is needed. For a quick change `planTouch` reads the `**Files:**` paths of `quick.md`'s `## Plan` instead of `plan.md`.
- `assemble` for a change whose schema is `quick`:
  - a fix recorded with `review.mjs fix` (the session writes the reply `{ finding, outcome: 'fixed', sha }` itself) is settled without a second round: `unreviewedFixes` does not make it outstanding, and the record lists it as `fixed in <sha>, not re-reviewed (quick task)`;
  - the suite condition reads `.superpowers/sdd/<change>/quick/tests.json` in place of `state.suite`: a fix needs a passing record whose `commit` is HEAD;
  - `review.mjs round` past round 1 is refused for a quick change: `a quick task has one review round; take the rest to /adf:propose`.

- [ ] **Step 1: Write the failing tests:** `a quick change passes with a fixed finding and no second round`, `a quick change needs the affected tests at HEAD after a fix`, `a quick change refuses round 2`, `a full change still needs the re-review` (unchanged behaviour).
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/review-state.spec.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): one review round for a quick change`.

### Task 5: The end of a quick change

**Files:**
- Modify: `plugins/adf/scripts/lib/archive.mjs` (`checkStep`, `mergeStep`, `mrInput`), `docs/iterations/20-quick.md` (the ruling's correction)
- Test: `plugins/adf/scripts/__tests__/archive.spec.mjs`

**Interfaces:**
- `checkStep` for a quick change: the review record gate as for full; no specs base check; the warnings read `quick.md`'s artifact status; the `quick-summary` gate must pass, else refused `quick.md has no summary; write ## Summary, then run check again`.
- `mergeStep` for a quick change: `{ state: 'skipped', detail: { reason: 'quick task' } }`, nothing written.
- `placements`, `move`, `commit-specs`, `ingest`, `commit-memory`, `metrics`, `commit-metrics`, `mr`, `merge-local`, `remove`: unchanged.
- `mrInput` for a quick change: `{ ok, change, changeDir, cycle: 'quick', goal, summary, plan, links, bodyFile }` from `quick.md` (`links` from iteration 19); the full change's fields stay as they are.

- [ ] **Step 1: Write the failing tests:** `archive check refuses a quick change with no summary`, `merge is skipped for a quick change`, `placements resolves the debt a quick change took`, `mr-input reads quick.md`, and `the archive runs a quick change from check to remove` on a fixture worktree with a fake forge and no knowledge plugin.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/archive.spec.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement**; edit the design's "The end." call to the ruling of this plan.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): archive a quick change`.

### Task 5a: Metrics and the retrospective

**Files:**
- Modify: `plugins/adf/schema/metrics.schema.json` (optional `cycle`), `plugins/adf/contract/metrics-format.md`, `plugins/adf/scripts/lib/propose.mjs` (`createChange` session records), `plugins/adf/scripts/lib/quick.mjs` (`marks.json`), `plugins/adf/scripts/lib/metrics.mjs` (`buildRecord`; `timing.tasks` at `:241`), `plugins/adf/scripts/lib/retro.mjs` (`input` at `:185`), `plugins/adf/scripts/lib/retro-render.mjs`
- Test: `plugins/adf/scripts/__tests__/metrics.spec.mjs`, `retro.spec.mjs`, `retro-cli.spec.mjs`

**Interfaces:**
- `buildRecord` writes `cycle: 'quick'` for a quick change, `'full'` otherwise; `timing.tasks` counts the numbered steps of `quick.md`'s `## Plan` for a quick change; the verify group and the implementer dispatches are `null` with the coverage reason `quick task: no <group>`.
- The phases come from the ledger's `session` records (`phaseMarks`, `lib/metrics-facts.mjs:104`; the first record covers the session from its start). The ledger is in the worktree (`ledgerPath`, `lib/ledger.mjs:63`), which does not exist during gather and estimate, so: `quick.mjs estimate-input` writes the time it ran to `.superpowers/sdd/<change>/quick/marks.json` (`{ "estimate": "<ISO time>" }`) in the main checkout; `propose.mjs create --schema quick` writes the session record `gather` in place of `propose`, then `estimate` with `now` set to that time when the file has it. The skill writes `code`, `tests`, `review` and `end` with `ledger.mjs session --change <name> --phase <p>`. Tests: `create --schema quick records gather and estimate`, `a quick change's byPhase holds the six phases` (on a transcript fixture).
- Retro `input` groups the records by `cycle ?? 'full'`; the rendered document has, per cycle, the active minutes, turns, tokens and cost per change, under the headings `### Full cycle` and `### Quick cycle` (the second only when a quick record exists).

- [ ] **Step 1: Write the failing tests:** `a quick record has cycle quick and its steps as tasks`, `a record without cycle validates and reads as full`, `retro groups quick records apart`.
- [ ] **Step 2: Run** the three spec files — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): metrics and retro by cycle`.

### Task 6: The `/adf:quick` skill

**Files:**
- Create: `plugins/adf/skills/quick/SKILL.md` (front matter as `skills/propose/SKILL.md`: `name: quick`, a description with "Triggers may be phrased in any language.", `argument-hint: <key, phrase, list or a change name>`)
- Test: `plugins/adf/scripts/__tests__/skills.spec.mjs`, `triggers.spec.mjs` (they check every skill)

**The skill's sequence** (each step a script call; the skill states the call and what to show):
1. `list`: `changes.mjs list`, the quick changes only. A change name of a quick change in flight: resume at its first open step (`changes.mjs status`, `archive.mjs next`).
2. No key and no phrase: ask for one; none: `scope.mjs gather --bugs`. Ask whether to gather context; with keys or a phrase: `scope.mjs gather --keys/--text`, or with the decline only the keys.
3. Nothing to record yet: the ledger lives in the change worktree, which `propose.mjs create` makes in step 5 (see Task 5a for how `gather` and `estimate` are recorded).
4. `quick.mjs filter`, `quick.mjs estimate-input`, dispatch `quick-estimate` (read-only), `quick.mjs estimate-check`; show each candidate's fit; the developer selects (`scope.mjs select`). A `propose` fit is offered to `/adf:propose`, never taken.
5. `preflight.mjs --phase propose`, the branch name as propose derives it, `propose.mjs create --schema quick`, `scope.mjs start` (held, then `--yes` on the developer's yes), `forge.mjs open --change` (Draft, links of iteration 19); then `ledger.mjs session --phase code`.
6. Write `quick.md` Goal, Scope and Plan; `changes.mjs done quick` (the `quick-plan` gate); the session writes the code itself, commit per plan step through `commit.mjs`. The stop rule: a behaviour change or a fourth step stops, says why, offers `/adf:propose`.
7. Phase `tests`: `quick.mjs tests`. Phase `review`: `review.mjs start`, `round`, `input`, dispatch the reviewer, `response`; the session fixes the blocking findings, `review.mjs fix` per fix, `quick.mjs tests` again, `review.mjs assemble --commit`.
8. Phase `end`: write `## Summary`; `archive.mjs` steps in order (the body of `mr` from `mr-input`); then tell the developer to run `/adf:land` after the merge.
- Every step that calls a role or a hook says, when it is skipped, which plugin would provide it.

- [ ] **Step 1:** Write the skill; the Codex form follows from the same file as for the other skills (iteration 17).
- [ ] **Step 2: Run** `npm test` — Expected: all pass, the skill checks included.
- [ ] **Step 3: Commit** `feat(adf): the /adf:quick skill`.

### Task 7: The guide

**Files:**
- Create: `docs/guide/cycle/quick.md` (sources: `plugins/adf/skills/quick/**`, `plugins/adf/scripts/quick.mjs`, `plugins/adf/scripts/lib/quick.mjs`, `plugins/adf/schema/quick/**`)
- Modify: `docs/guide/cycle/README.md` (the two cycles, `full` and `quick`, and when to take each), `docs/guide/extension-points/contract/tracker.md` (`bugs`), `docs/guide/plugins/adf-jira.md` (`bugs`), `docs/guide/concepts/metrics.md` (`cycle`)
- Test: `node scripts/check-guide.mjs`

- [ ] **Step 1:** Write the pages in ASD-STE100, each claim checked against Tasks 1–6.
- [ ] **Step 2: Run** `node scripts/check-guide.mjs` — Expected: `{ "ok": true }`.
- [ ] **Step 3: Commit** `npm test && git commit -m "docs(guide): the quick cycle"`.

### Task 8: A behaviour check

**Files:**
- Modify: `docs/iterations/20-quick.md` (a `## Result` section)

- [ ] **Step 1:** In a scratch host project with the branch's plugins (the iteration 16 method: a local bare repository, the marketplace renamed), run `/adf:quick` twice: (a) with a debt entry of class `defect` and no tracker, (b) with `adf-jira` against a test project the developer names (ask), from no key to the open bugs. Each run ends at the merge request; the developer merges; `/adf:land`.
- [ ] **Step 2:** Read each `metrics.json`: `cycle` `quick`, the six phases, the active minutes. The success measure: a one-file fix under 20 active minutes.
- [ ] **Step 3:** Write the notes, the figures and what was not checked in `## Result`; commit `docs(iterations): the result of iteration 20`.

### Task 9: Release v0.20.0, iterations 19 and 20

After the PR is merged by the developer, on `main`. Both PRs (iteration 19, then this one) are merged. One release carries both iterations (the developer's decision, 2026-11-05); iteration 18 changed documentation only and gets no changelog entry.

**Files:**
- Modify: `.claude-plugin/marketplace.json` (`metadata.version` `0.21.0`; the `version` of each plugin whose files changed since `v0.20.0`: `adf`, `adf-gitlab` and `adf-jira` at least), each such plugin's `.claude-plugin/plugin.json`; then `node scripts/manifests.mjs` writes the Codex manifests
- Modify: `CHANGELOG.md` (a new section `## [0.21.0] — <date>` above `## [0.20.0]`, written from `git log v0.20.0..HEAD`: the changes to the flow and the plugins only, under Added, Changed and Fixed; no `[Unreleased]` section), the pinned tags in `README.md` and `docs/guide/` (`v0.20.0` to `v0.21.0`)

- [ ] **Step 1:** `git diff --name-only v0.20.0..HEAD -- plugins/` lists the changed plugins; bump each plugin with a change outside its documentation: minor for a new feature, patch for a fix. A plugin whose only changes are documentation keeps its version.
- [ ] **Step 2: Run** `node scripts/guide-review.mjs input --from v0.20.0 --out .superpowers/guide-review/0.21.0`, dispatch one read-only agent per package, `guide-review.mjs check` each reply; fix every finding in the guide and run it again until none is open.
- [ ] **Step 3: Run** `npm test` (it includes `check-release.mjs`) — Expected: all pass.
- [ ] **Step 4: Commit** `npm test && git commit -m "chore(release): v0.21.0"`, push, then `git tag v0.21.0` on that commit and `git push origin v0.21.0`; `npm test` again on the tagged `HEAD` (the tag check) — Expected: all pass.
- [ ] **Step 5:** Add `Released as v0.21.0` to roadmap rows 19 and 20; commit `docs(roadmap): iterations 19 and 20 released as v0.21.0`.
