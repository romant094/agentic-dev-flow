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
- **Prose stays prose, in its own file.** `Where to look` and `Checks that need the developer` are
  text for the agent, not values for a script. They go to `adf/guide.md`, a project file written
  once by `/adf:init` like the review prompt. The plan and verify agents get `adf/guide.md` and a
  rendering of `settings.json`. (Open question 1 below.)
- **Scripts write the values.** `settings.mjs set --key <k> --value <json>` replaces every hand edit
  of the guide in the init and quick skills.
- **Changes in flight move on their own branch.** A script commits the same `git mv` on each change
  branch (`update.mjs move-change --change <name>`), so the later merge of the integration branch
  is clean. A command that finds `openspec/changes/<name>` in a worktree refuses and names that
  command. Live code reads only `adf/`. (Open question 2 below.)
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

## Open questions for the developer

1. **The prose sections.** (a) `adf/guide.md`, a project file like the review prompt
   (recommended: prose is not a value, and the agent reads it as text); (b) string fields in
   `settings.json`.
2. **Changes in flight.** (a) a script moves each change branch once, and commands refuse until it
   ran (recommended: one code path, deterministic); (b) the live code also reads `openspec/` as a
   fallback, with a warning, until the change is archived.

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
| 7 | The migration in `/adf:update` `apply` and `plan`, staging with `-A`; the update skill | an end-to-end test on a fixture host with archives and a change in flight |
| 8 | Changes in flight: `update.mjs move-change`, and the refusal in a worktree that still has `openspec/` | a moved branch merges the migrated integration branch with no conflict |
| 9 | `adf-english-check` defaults and its first `migrations` script; the `adf-postgres` message | plugin tests; `migrateConfig` on an old config |
| 10 | Instruction text, templates, contract, guide pages | `grep -rn openspec plugins` leaves only the legacy and migration code and tests; `check-guide.mjs` |
| 11 | `/adf:update` on a copy of the origin project: 78 specs, 7 changes in flight, 90 archived changes | the run's notes in `## Result` (also part of the live check, iteration 27) |
