# Iteration 25 — The flow's directory `adf/`

## Goal

Everything the flow commits to a host project lives under `adf/`, not `openspec/`. The planning
guide's instructions live only in the plugin; the project keeps its values in a JSON file with a
schema the flow owns. `/adf:update` moves an existing project, its changes in flight included.
Closes #26 and #23.

## Intent

`openspec/` is the name of a tool the flow no longer runs (#26). The directory mixes the flow's
artifacts with its settings, and `openspec/planning.md` mixes ADF's instruction text with the
project's values, so `/adf:update` runs a three-way merge on the guide at every release that
touches the template. #23 is one failure of that merge, and it is a class, not a single case:
`MANAGED` (`lib/host-merge.mjs:12`) holds 5 of the guide's value sections, so the `replace`
choice drops the values of the other 7 (`How to run the checks`, `Failed-tests command`,
`Fresh-run proof`, `Test-first shares`, `Packages`, and the two prose sections).

The project rule in `CLAUDE.md` decides the format: every value a script reads is a structured
record a script writes and checks, never free text a script parses.

## Settled by the developer (2026-11-20, #26)

1. The values go in a JSON file with a schema the flow owns (`adf/settings.json`). The headings and
   instructions live only in the plugin. `/adf:update` has nothing to merge for the guide.
2. The review prompt is a project file. `/adf:init` writes it once; `/adf:update` never touches it.
3. The review of OpenSpec 2.x (#57) comes after this iteration.
4. The prose sections `Where to look` and `Checks that need the developer` go to `adf/guide.md`,
   a project file written once by `/adf:init`.
5. Changes in flight are handled as at the switch (iteration 15): development stops, every change
   in flight is archived or dropped, the migration runs, and development continues. The flow does
   not move change branches and does not read `openspec/` as a fallback.

## What exists (checked 2026-11-20 at `51d5111`)

- `openspec` appears in 61 non-test files of `adf` (194 occurrences: 27 `join(root, 'openspec', …)`,
  about 67 template literals, 5 pathspecs and globs, 8 commit scopes `docs(openspec)`, 29 places in
  instruction text, the rest comments) and in `adf-english-check/scripts/lib/english.mjs` (16).
  No other plugin names it outside tests; `adf-postgres` names the guide's `## Worktree copies` in
  a refusal (`postgres.mjs:284`).
- Constants: `CHANGES_DIR`, `ARCHIVE`, `ORIGIN_META_FILE` (`lib/changes.mjs:17-21`), a private
  `SPECS_DIR` (`lib/specs.mjs:1000`), `PLANNING_FILE` (`lib/guide.mjs:5`), `PLANNING_GUIDE` and
  `REVIEW_PROMPT` (`lib/host-files.mjs:12-13`), private duplicates in `prepare.mjs:29` and
  `provision.mjs:33`.
- The guide has 12 sections. Ten are values read by scripts through `lib/guide.mjs` or their own
  regexes: `Packages` (list of paths), `How to run the checks` (list of commands), `Whole-suite
  command`, `Affected tests command` (`{files}`), `Failed-tests command` (`{tests}`), `Fresh-run
  proof` (one output line), `Test-first shares` (list of paths; absent and empty differ),
  `Worktree copies` (list of paths), `Worktree preparation` (list of `{command, inputs}`),
  `Format command` (`{files}`). Two are prose for the agent: `Where to look` and `Checks that need
  the developer`. The whole guide text also goes to the plan and verify agents (`schema.json`
  `guides`).
- The init and quick skills tell the agent to edit the guide by hand (`skills/init/SKILL.md:125-141`,
  `skills/quick/SKILL.md:218`), against the project rule.
- The review prompt: `host/review-prompt.md`, copied by `createReviewPrompt`
  (`lib/host-files.mjs:60-71`), pointed to by the registry key `review.prompt`, and merged as a host
  file by `/adf:update` (`lib/host-merge.mjs:30`).
- `/adf:update` `apply` (`lib/update.mjs:474-563`) computes every write first, then writes on
  `chore/adf-update-<v>`; `commitFiles` stages with `git add -- <written>`, so a rename or a
  deletion is not staged. Config migrations of a plugin (`migrations` in `adf-extension.json`,
  `lib/migrate.mjs`) exist; no plugin declares one yet.

## Calls made by the designer, not the developer

- **One layout module.** `lib/layout.mjs` holds the root (`adf`), every derived path (changes,
  archive, specs, settings, review prompt) and `LEGACY_ROOT = 'openspec'`. Every join, literal and
  pathspec in the scripts uses it. `adf-english-check` cannot import the core and keeps its own
  copy, as it does for the registry path.
- **The settings file.** `adf/settings.json`, checked against `schema/settings.schema.json`, one key
  per value section, each with the real type above (`testFirstShares` may be `null`, which keeps
  the difference between absent and empty). `lib/settings.mjs` reads, validates, gets and sets;
  every section parser goes. The instruction text of each key moves from `host/planning.md` into
  the schema's `description`, which `/adf:init` and the skills show when they ask for a value.
- **Prose stays prose, in its own file** (decision 4). The plan and verify agents get `adf/guide.md`
  and a rendering of `settings.json`.
- **Scripts write the values.** `settings.mjs set --key <k> --value <json>` replaces every hand edit
  of the guide in the init and quick skills.
- **A freeze, checked by script** (decision 5). The migration plan lists the changes in flight
  (`update.mjs plan` `inFlight`); `apply` refuses the migration while that list is not empty and
  names each change. Live code reads only `adf/`.
- **History readers know both roots.** Readers of past commits (the retro window, the specs at an
  old base, `proposedAtOf`, the path filters over a commit range) use an `isFlowPath` helper that
  knows both prefixes, so a range that spans the migration and the migration commit itself never
  count as code.
- **Archived changes are history.** They move with the directory and keep their text; the
  `openspec/…` paths inside them stay. The migration report counts them.
- **The commit scope** of the flow's own record commits becomes `docs(adf)` / `chore(adf)`.
- **The migration is a core step of `/adf:update`.** When `openspec/` exists at the base commit,
  `apply` plans `git mv openspec adf`, converts the guide into `settings.json` and `guide.md`
  (the old parsers survive only in `lib/flow-migrate.mjs`), moves the review prompt and rewrites
  `review.prompt` when it holds the old default, stages with `git add -A`, and reports every
  tracked file outside `adf/` that still names `openspec/` (CLAUDE.md, memory pages, `.gitignore`,
  CI) for the developer to fix. The plan shows the migration and the changes in flight before the
  developer's yes.
- **`adf-english-check`** gets new defaults and its first `migrations` script, which rewrites the
  `openspec/` prefixes of a host's `include` and `exclude`.

## Non-goals

- Compatibility with the OpenSpec CLI (#26: not a requirement).
- Rewriting the text of archived changes.
- The review of OpenSpec 2.x (#57).

## Depends on

- Iteration 16: `/adf:update`, the registry `migrations`.
- Iteration 22: `## Failed-tests command`, `## How to run the checks` as values.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/layout.mjs` with the root still `openspec`; every join, literal and pathspec uses it; the duplicate constants go | no `openspec` left in `scripts/` outside comments and `layout.mjs`; full suite |
| 2 | History readers: `isFlowPath`, both roots in the window and its `EXCLUDED`, fallback reads of old specs and `proposedAtOf` | a fixture repository with archives under `openspec/` and a rename commit gives the same window as before the rename |
| 3 | `schema/settings.schema.json`, `lib/settings.mjs`; every section parser replaced | each consumer's tests on JSON fixtures; no `sectionBounds` caller outside the converter |
| 4 | `settings.mjs set`; the init and quick skills name no file edit | set and read-back tests |
| 5 | The root becomes `adf`; init writes `adf/settings.json`, `adf/guide.md`, `adf/review-prompt.md`; the commit scope `docs(adf)`; `hostFiles` drops the core files, which retires `MANAGED` (#23) | full suite; `update plan` lists no core host file |
| 6 | `lib/flow-migrate.mjs`: the old guide converted to `settings.json` and `guide.md`; the mentions report | the shipped template and an xnms-like guide convert with no value lost; the result validates |
| 7 | The migration in `/adf:update` `apply` and `plan`, staging with `-A`; the update skill | an end-to-end test on a fixture host with archives |
| 8 | The freeze: `apply` refuses the migration while a change is in flight; the update guide page describes the freeze | a fixture host with a change in flight is refused, with each change named |
| 9 | `adf-english-check` defaults and its first `migrations` script; the `adf-postgres` message | plugin tests; `migrateConfig` on an old config |
| 10 | Instruction text, templates, contract, guide pages | `grep -rn openspec plugins` leaves only the legacy and migration code and tests; `check-guide.mjs` |
| 11 | `/adf:update` on a copy of the origin project: 78 specs and 90 archived changes, after the freeze | the run's notes in `## Result` (also part of the live check, iteration 27) |

## Result

Steps 1 to 10 were implemented by an agent on 2026-11-20, one commit each, with the developer
not available; the calls it made are listed below. Behaviour changes were written test first.

- **Step 1** (`c709ea9`). `lib/layout.mjs` holds the root, the derived paths (changes, archive,
  specs, context, rules, the review prompt), `LEGACY_ROOT`, `ORIGIN_META_FILE` and the commit
  scope. Every join, literal and pathspec of the scripts uses it; the duplicate constants of
  `changes.mjs`, `specs.mjs`, `guide.mjs`, `host-files.mjs`, `prepare.mjs` and `provision.mjs`
  are gone. `layout.spec.mjs` checks the derivation.
- **Step 2** (`ab80739`). `FLOW_ROOTS`, `flowRelative` and `isFlowPath`. The window's
  `archivedEntries` finds an archived change by its directory name under either root, so the
  move adds no change, and reads each one where the ref holds it now; `EXCLUDED`, the metrics
  capability filter, `proposedAtOf` and the main spec at an old base read both roots. The test
  on a real repository with a rename commit landed with step 5, since a test of two roots needs
  the root to differ from the legacy one.
- **Step 3** (`8b08ef2`). `schema/settings.schema.json` (one key per value section, the
  template's instructions in each `description`), `lib/settings.mjs` (read, validate, get, set,
  render). Every section parser and `lib/guide.mjs` are gone. The prose template is
  `host/guide.md`; init writes `settings.json` (every key, `testFirstShares: []`) and
  `guide.md`. The plan, verify and apply agents get the guide and the rendered settings
  (`schema.json` `guides`).
- **Step 4** (`9577af9`). `settings.mjs show | get | set --value <json> [--commit]`. The init and
  quick skills record the format and affected tests commands through it; no skill edits a file
  by hand.
- **Step 5** (`b4202e5`). The root is `adf`, the commit scope `adf`. `hostFiles` lists only the
  plugins' `hostFiles`: the planning guide (in step 3) and the review prompt (here) are no host
  files, so `MANAGED` is gone (#23). The window test on a repository whose archives moved from
  `openspec/` to `adf/`. The parity replay moves the origin's `openspec/` at the host setup and
  compares the trees with the origin's names.
- **Step 6** (`8f939d7`). `lib/flow-migrate.mjs`: `convertGuide`, `reviewPromptPath`,
  `legacyMentions`; the only module that reads the old sections. The shipped template (`b03ff31`)
  and a filled guide in the origin's shape convert with no value lost and validate.
- **Step 7** (`25acc5c`). `plan` reports `migration` (`migrationAt`); `apply` makes the move in
  the update worktree, converts the guide, moves `review.prompt`, stages `adf/` with `-A`, and
  reports `notes` and `mentions`; `commit` stages the same way. End-to-end tests on a fixture host
  with an archive, specs, the guide, the review prompt and a `CLAUDE.md` that names `openspec/`.
- **Step 8** (`a1e00f0`). The freeze: `apply` refuses the move while `migration.inFlight` names
  a change (a directory of `openspec/changes/` or a worktree), naming each, before it writes
  anything. The update skill and `docs/guide/update.md` describe it.
- **Step 9** (`9a4e476`). `adf-english-check` keeps its own `FLOW_ROOT`; its defaults and the
  core scripts' paths name `adf/`; its first config migration `0.8.2` rewrites `openspec/` globs
  (`migrations.spec.mjs`, through the core's `migrateConfig`). `adf-postgres` names
  `worktreeCopies` in `adf/settings.json`.
- **Step 10** (`d16e3b9`). Instructions, prompts, templates, skills, contract, guide pages and
  the README.

Calls made by the agent:

- The planning guide left `hostFiles` in step 3, with its template; the design placed it in
  step 5. The review prompt left in step 5.
- `INITIAL` settings (what init writes) set `testFirstShares: []`, as the template's empty
  section did; the converter gives `null` when the old guide had no such section.
- The converter keeps a value the schema refuses (two lines, a path outside the project, a step
  with no input) in `guide.md` under `<heading> (not converted)`, with a note in `apply`'s
  `migration.notes`; the `failedTestsCommand` keeps its line even without `{tests}`.
- `reviewPromptPath` moves any `review.prompt` under `openspec/`, not only the default: the file
  moves with `git mv` either way.
- `legacyMentions` reads the update worktree's files (`git grep` over tracked files), so the
  rewritten registry is not reported.
- The review filter leaves `adf/settings.json` out (`DEFAULT_EXCLUDE`), as it did the old
  guide by `**/*.md`; verify's out-of-plan check exempts a `settings.mjs set --commit` commit
  as it does `suite.mjs set --commit`.
- The spec-merge parity fixture compares error messages with the port's directory named
  `openspec/changes/`, the one text difference from the OpenSpec CLI.
- The `adf-english-check` migration is numbered `0.8.2`, so it runs for any release of the plugin
  past 0.8.1; the release that bumps the plugin must give it at least 0.8.2.
- The mid-flight parity replay moves the origin's in-flight change to `adf/changes/` on its
  branch, as an injected step: the freeze makes this a test-harness scenario only.
- The switching guide tells a project on the old OpenSpec flow to `git mv openspec adf` before
  `/adf:init`; the developer should review that page.

Open:

- The first update into this release runs `plan` from the installed (older) release, which has
  no `migration` field: the developer sees the move only in `apply`'s result. `apply` runs the new
  release's code, so the freeze is enforced either way.
- Step 11 (a run of `/adf:update` on a copy of the origin project, 78 specs and 90 archived
  changes, after the freeze) is left for the developer, with the live check of iteration 27.

Residue of `grep -rn openspec plugins --exclude-dir=__tests__`: `LEGACY_ROOT` and
`ORIGIN_META_FILE` in `lib/layout.mjs` (the legacy root, and the metadata file of a change the
earlier flow created); `lib/flow-migrate.mjs`, `lib/update.mjs` and the update skill (the
migration); `lib/init.mjs` and the init skill (the scan for a previous flow's commands); the
`adf-english-check` legacy root and its migration; and the comments and the archive instruction
that name the OpenSpec CLI the spec engine was ported from.

Checks: `npm test` green at every commit; at the last one 1896 tests, 1891 passed, 0 failed,
5 skipped (1882, 1877 and 5 at the start); `check-lessons.mjs`, `check-release.mjs` and
`check-guide.mjs` with no error. `scripts/guide-review.mjs` belongs to the release step and was
not run.
