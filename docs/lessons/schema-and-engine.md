# Schema and Change Engine

Sources read: at origin commit `045c5f4a` — `openspec/config.yaml`,
`openspec/schemas/sdd-plus-superpowers/` (`schema.yaml`, `README.md`, `templates/`),
`.claude/scripts/check-opsx-commands.mjs`, `.claude/scripts/__tests__/check-opsx-commands.spec.mjs`,
`.claude/settings.json` (deny rules), `.claude/CLAUDE.md` §5,
`openspec/specs/change-workflow-schema/spec.md` (requirements "Vendored workflow schema",
"English-only artifact templates", "No references to unavailable skills", "Single command
entry point", "The generated command surface is guarded against regeneration", "Every adapted
command file is covered by the integrity check", "No parallel command surface bypasses the
gate", "In-flight changes use the new schema", "The schema states phase procedure and the
commands point at it"), `.claude/scripts/adf-regression/` (`README.md`,
`normative-duplication.mjs`), `.claude/memory/adf/{opsx-workflow,flow,adf-deferred-findings}.md`,
and `openspec/changes/archive/2026-08-04-integrate-superpowers-workflow/` (`brainstorm.md`,
`design.md` D1, D10, Risks, deferred findings; commit `5ab014f3`). The openspec CLI was read at
`@fission-ai/openspec` 1.5.0 (installed globally); file:line references below are into its
`dist/`. Its behaviour with symlinks and a minimal schema was tested in throwaway projects under
a scratch directory, with `XDG_DATA_HOME` pointed there.

Decisions approved by the developer on 2026-10-13: the flow drops the openspec CLI (option A).
The schema ships in the plugin and is read from there; the scripts in `plugins/adf/scripts/`
replace every CLI command the flow used (`new change`, `list`, `status`, `instructions`,
`validate`). Nothing is copied into the host and nothing is linked. Usage counts in the origin's
flow at the time: `status` 19, `list` 10, `instructions` 8, `store` 7, `validate` 6, `update` 3
(prohibitions only), `new change` 2; the spec merge at archive is a skill, not the CLI.

The facts below were read from openspec 1.5.0 to decide this and to reproduce its behaviour;
they matter now only as the behaviour the engine keeps.

## What openspec 1.5.0 does

- **Lookup order** (`core/artifact-graph/resolver.js:57-79`): `<project>/openspec/schemas/<name>/schema.yaml`,
  then `<data dir>/schemas/<name>/schema.yaml` where the data dir is `$XDG_DATA_HOME/openspec`,
  else `%LOCALAPPDATA%\openspec` on Windows, else `~/.local/share/openspec`
  (`core/global-config.js:44-64`), then the package's own `schemas/<name>/`. Only `spec-driven`
  ships in the package. First hit wins.
- **Selection** (`utils/change-metadata.js:117-140`): explicit `--schema`, then the change's
  `openspec/changes/<name>/.openspec.yaml` `schema:`, then `openspec/config.yaml` `schema:`, then
  `spec-driven`. A new change takes `--schema`, else the config, else `spec-driven`
  (`utils/change-utils.js:87-105`), and its `.openspec.yaml` records the name — by name only, no
  version or hash.
- **Name validation goes through a listing that skips symlinks.** `listSchemas`
  (`resolver.js:131-172`) keeps only `Dirent.isDirectory()` entries, which is false for a symlink;
  `validateSchemaName` (`change-metadata.js:29-35`) and `readChangeMetadata`
  (`change-metadata.js:97-101`) check against that list. `getSchemaDir` uses `existsSync`, which
  follows symlinks.
- **Minimal valid schema** (`core/artifact-graph/types.js:3-28`, `schema.js:20-36`): `name`,
  `version` (positive integer), `artifacts` (at least one, each with `id`, `generates`,
  `description`, `template`; optional `instruction`, `requires`), optional `description` and
  `apply` (`requires` at least one id, `tracks`, `instruction`). Duplicate ids, unknown
  `requires` and cycles are rejected. Unknown top-level keys are dropped silently by the Zod
  object, so the origin's top-level `resolve`, `propose` and `archive` blocks are invisible to
  `openspec instructions`.
- **Templates** are read only from `<schemaDir>/templates/<template>`
  (`instruction-loader.js:33-41`), while `openspec schema validate` also accepts the schema root
  (`commands/schema.js:132-147`).
- **Validate command**: `openspec schema validate <name> [--json] [--verbose]` (`commands/schema.js:315`)
  checks the YAML and that every template exists. Without a name it validates every project
  schema directory but skips symlinked ones (`commands/schema.js:341-343`). `openspec schema
  which <name>` reports the resolved path and source. The `schema` command group is marked
  experimental.
- **`openspec update` and `openspec init` never touch `openspec/schemas/`**: neither
  `core/update.js` nor `core/init.js` references it. Update writes
  `.claude/skills/openspec-*/SKILL.md` and `.claude/commands/opsx/<workflow>.md` for the profile's
  workflows (`update.js:128-160`) and deletes the files of workflows outside the profile, by
  workflow name only (`update.js:291-385`, `ALL_WORKFLOWS` at `profiles.js:15-27`, the default
  `core` profile at `profiles.js:11`). Init creates `openspec/config.yaml` with
  `schema: spec-driven` only when no config exists (`init.js:459-467`).
- **Symlink test results**: a symlink at `openspec/schemas/<name>` resolves (`schema which`,
  `schema validate <name>` pass) but `openspec new change` fails with
  `Unknown schema 'sdd-plus-superpowers'. Available: spec-driven`, and `status` errors. A symlink
  at `openspec/schemas` itself works end to end (`new change`, `status`, `instructions` with
  templates). A real copy works. A copy in the user data directory works (`Source: user`).

| Rule | Why it exists (the incident or the measurement) | Decision | Where it lives now | Evidence |
|---|---|---|---|---|
| The schema lives in the project at `openspec/schemas/sdd-plus-superpowers/`, and `openspec/config.yaml` names it with `schema:`. | openspec reads a schema only from the project, the user data directory or its own package (`resolver.js:57-79`). The project copy means no runtime dependency on the upstream fork (design D1). | changed — the schema lives in the plugin and only there; the engine reads it through `${CLAUDE_PLUGIN_ROOT}`. The host holds no copy, so there is no copy to drift, no install step and no stamp to compare. | `plugins/adf/schema/` | `plugins/adf/scripts/lib/schema.mjs`: `export const SCHEMA_DIR` |
| A per-schema-directory symlink into the plugin cache. | Not an origin rule; tested in this pass. `listSchemas` skips symlinks, so `openspec new change` fails with "Unknown schema" (`resolver.js:131-172`, `change-metadata.js:29-35`). | rejected — moot without the CLI. | not used | — |
| A symlink of the whole `openspec/schemas` directory into the plugin cache. | Not an origin rule; tested in this pass. It works with 1.5.0, but the target is an absolute path into a versioned cache directory that changes on every plugin update and is swept when unused; git stores it as a link to a path on one machine. | rejected — fragile across updates and machines. | not used | — |
| The user data directory as the install target. | Not an origin rule; tested in this pass, it resolves (`Source: user`). | rejected — moot without the CLI. | not used | — |
| The schema validates against the stock CLI (`openspec schema validate`). | Requirement "Vendored workflow schema". | changed — the engine validates the schema itself on every load (ids, required fields, unknown `requires`, cycles, missing template or instruction files, the `apply` block) and refuses to run on an invalid one; the test suite loads the shipped schema. | `plugins/adf/scripts/lib/schema.mjs`, `schema.spec.mjs` | `plugins/adf/scripts/lib/schema.mjs`: `the artifact graph has a cycle`; `plugins/adf/scripts/__tests__/schema.spec.mjs`: `the shipped schema loads` |
| The schema format is YAML with the prose inline (80 KB in the origin). | openspec's format. Unknown top-level keys are dropped silently by its parser (`types.js:21-28`), so `resolve`, `propose` and `archive` were invisible to `openspec instructions` and `adf-metrics` once reported `(no source)` for a block that existed. | changed — `schema.json` holds the graph; each prose block is its own markdown file under `instructions/` or `templates/`, named from the graph. The core needs no YAML parser (standard library only), each block is read and measured on its own, and an unknown key is an error, not a silent drop. | `plugins/adf/schema/` | `plugins/adf/schema/schema.json`: `"template": "brainstorm.md"` |
| A new change resolves to the schema and the full artifact graph (`openspec status --change <name> --json` reports `schemaName`). | Scenario "Schema resolves for a new change". | ported — `changes.mjs new` and `status`, with tests. Parity with the CLI is measured by `scripts/parity/openspec-status.mjs` over every change of the origin, archived ones included: 72 compared, 0 differences in status, missing dependencies, apply requirements, apply state, task progress and the change list (2026-10-13). One change pinned to the old `spec-driven` schema is skipped. | `plugins/adf/scripts/changes.mjs`, `changes.spec.mjs` | `plugins/adf/scripts/changes.mjs`: `case 'new':`; `scripts/parity/openspec-status.mjs`: `instructions apply` |
| The JSON of `status`, `instructions` and `list` is what the commands read. | The commands parse `applyRequires`, `artifacts[].status`, `artifactPaths`, `changeRoot`, `template`, `instruction`, `context`, `rules`, `dependencies`. | ported — same field names. Dropped: `planningHome`, `actionContext`, `nextSteps` and `root`, which serve openspec's stores and its own skills. | `lib/changes.mjs` | `plugins/adf/scripts/lib/changes.mjs`: `applyRequires:` |
| The schema is an upstream copy (`JiangWay/OpenSpec` at `f053e3fe`) with four adaptations: English only, no silent fallback, the `develop` branch model, no references to skills the project lacks. | Each was found by reading the upstream file (design D1). | changed — the plugin's schema is the upstream now. English only and no fallback carry over; the branch model and every origin-specific rule (`npm ci`, Prisma, `develop`) move to host configuration or a project plugin. Iteration 03 ships the graph and the five templates that name no later phase (brainstorm, proposal, design, spec, tasks); each instruction, and the plan, verify and review templates, arrive with the iteration of the phase that uses them. | `plugins/adf/schema/` | `plugins/adf/schema/templates/brainstorm.md`: `Per the brainstorm instruction` |
| The vendored schema is frozen; upstream fixes arrive only on a deliberate re-copy. | Accepted: it is what bought the absence of a runtime dependency (design Risks). | changed — the schema changes with the plugin version. A change records `schemaVersion` in `.adf.json` at creation; `status` reports `pinnedSchemaVersion` when the plugin's version differs, so a schema change under an in-flight change is visible. | `lib/changes.mjs` | `plugins/adf/scripts/lib/changes.mjs`: `pinnedSchemaVersion` |
| Changes in flight pin their schema in `.openspec.yaml`; the switch repointed four in-flight changes by hand. | Switching only the config left the four largest pending changes on the old flow, since the pin wins (design D10; `change-metadata.js:124-126`). | changed — one schema per plugin version, so the pin records a version, not a name; the engine never edits a change's metadata. Moving the origin's changes to the new metadata file is part of switching the origin project. | `lib/changes.mjs`; iteration 15 | `plugins/adf/scripts/lib/changes.mjs`: `schemaVersion: schema.version`; pending: iteration 15 |
| `/adf:init` never rewrites `openspec/config.yaml` beyond `schema:`. | The origin's config carries project `context:` and `rules:` keyed by artifact id. | changed — no config file and no `schema:` key. The project's guidance is `openspec/context.md` (given to every artifact) and `openspec/rules/<artifact>.md` (one rule per `- ` line); both optional, both plain markdown the host owns. | `lib/changes.mjs` | `plugins/adf/scripts/lib/changes.mjs`: `openspec/rules/${artifactId}.md` |
| English-only templates and instructions. | Template text is copied verbatim into generated artifacts; the upstream shipped partly in Traditional Chinese (requirement "English-only artifact templates"; design D1 item 1). | ported. | `plugins/adf/schema/` | pending: iteration 04 |
| The schema names only skills that resolve; `openspec-continue-change`, `workflow-retrospective` and `flow-retro` must not appear. | A name nothing objects to comes back (requirement "No references to unavailable skills"). A schema without an `apply` block made `openspec instructions apply` tell the agent to "Use the openspec-continue-change skill". | ported — and the engine's own messages name no skill: a blocked apply says which artifact or file is missing. | `lib/changes.mjs` | `plugins/adf/scripts/lib/changes.mjs`: `Create them first.` |
| `openspec update` is prohibited: four deny rules in `.claude/settings.json` and the rule in `openspec/config.yaml` and `.claude/CLAUDE.md`. | It regenerated `.claude/commands/opsx/` and `.claude/skills/openspec-*/`, measured at 140 deleted lines: the gate, the branch model, the worktree lifecycle, the provisioning decision, and `/opsx:explore` restored. | rejected — the flow needs no openspec CLI, so a host that uses ADF need not install it; the core's commands live in the plugin, which `update` cannot reach. A host that still has the CLI and stock files keeps them as its own business; detecting them is left to switching the origin project. | not needed; iteration 15 | pending: iteration 15 |
| The CLI is a prerequisite and must not be removed; it is a global install, not a project dependency. | Every subcommand the flow used ships in the same binary; one `npx` call among bare calls was deferred until the CLI pin was decided. | rejected — Node 20 is the only prerequisite besides Claude Code and Superpowers. | not needed | — |
| Command-integrity check: per-file adaptation markers, each present in the adapted file and provably absent from the stock template, run at step 1 of every command. | A marker the regenerated file also contains reports the adaptation present after it is gone. Run at every step because a regeneration after the last apply would otherwise surface only when archive skipped the spec merge. | rejected — there are no adapted host command files to guard. The lesson kept for any future marker check: a marker must be absent from what replaces it. | not needed | — |
| Every adapted command file has markers, including one with no stock template (`review.md`), because `update` "removes" it. | In 1.5.0's code `update` deletes only files named after its own workflows (`update.js:364-385`, `profiles.js:15-27`), so `review.md` would survive; with the default `core` profile it is `verify.md` that gets deleted (`profiles.js:11`). Static reading only. | rejected with the marker check. | not needed | — |
| The integrity check must not live only inside the commands it protects; the schema's `apply` instruction runs it too. | A regenerated command no longer contains the pre-flight that would detect the loss. | rejected — nothing regenerates the core's commands or its schema. | not needed | — |
| Recovery is the developer's: "Do not restore the files yourself"; the workflow stops. | A workflow that repairs its own surface mid-flow hides the regeneration. | ported as a principle — when the engine refuses (an invalid schema, a missing change), the command stops and shows the error; it does not patch files to continue. | each core command | pending: iteration 04 |
| No parallel command surface: the CLI-generated skill twins (`openspec-propose`, `openspec-apply-change`, `openspec-archive-change`, `openspec-verify-change`) are removed; `/opsx:explore` must not exist; `openspec-sync-specs` is kept but narrowed. | An agent selecting a twin by description authors change artifacts on `develop` with no preflight; `openspec-verify-change` reports a change verified while `verify.md` stays absent. | ported — the core ships no twin and no explore command. Stock `openspec-*` skills left in a host are found when the origin project switches. The spec merge `openspec-sync-specs` did becomes part of archive. | iteration 10, iteration 15 | pending: iteration 10; pending: iteration 15 |
| The schema states each phase's procedure in full; the command files carry the imperative and a pointer. | The command files were the surface `openspec update` regenerated, so procedure held only there was the most easily lost (deferred decision D-b measured commands -4844, schema +13161 bytes). | changed — the single-source rule stays (it is the normative-surface rule), but its regeneration reason is gone; where a rule lives is decided per iteration by which file the agent reads at that point. | iteration 04 onward | pending: iteration 04 |
| Top-level blocks `resolve`, `propose`, `archive` are read from `schema.yaml` directly, since `openspec instructions` returns only the artifacts and `apply`. | `adf-metrics.mjs` reported `(no source)` for a 3254-byte block that existed. | changed — a named block is a file in `instructions/` listed under `blocks` in `schema.json`, validated on load; a missing file is an error, not a silent gap. | `lib/schema.mjs` | `plugins/adf/scripts/lib/schema.mjs`: `schema?.blocks` |
| Scripts and skills hard-code `openspec/schemas/sdd-plus-superpowers/` (`check-workflow-shape.mjs`, `normative-duplication.mjs`, `adf-metrics`, five skills). | Grown one at a time; no incident. | changed — one constant, `SCHEMA_DIR` in `lib/schema.mjs`, and every script takes the schema from `loadSchema()`. | `plugins/adf/scripts/lib/schema.mjs` | `plugins/adf/scripts/lib/schema.mjs`: `export const SCHEMA_DIR` |
| `openspec schema` prints an experimental warning on every call. | Accepted (design Risks). | rejected — moot without the CLI. | not needed | — |
| `openspec validate --all --json` checks every spec and delta before tasks are written. | An invalid delta reaches archive and fails the spec merge there, after the work is done. | ported — `specs.mjs validate`, a port of 1.5.0's validator with the same rules, levels and messages; parity measured over the origin's specs and every archived delta (see the iteration record). | `plugins/adf/scripts/specs.mjs` | `plugins/adf/scripts/lib/specs.mjs`: `Requirement must contain SHALL or MUST keyword`; `scripts/parity/openspec-validate.mjs`: `CLI_TIP` |
| Task progress is the count of `- [ ]` and `- [x]` lines in `tasks.md`. | openspec counts with two different patterns: `list` needs a space after the dash, `instructions apply` does not (`utils/task-progress.js`, `instructions.js:190`). | changed — one parser for both, with the stricter pattern (a space after the dash); no change in the origin's corpus counts differently. | `lib/changes.mjs` `parseTasks` | `plugins/adf/scripts/lib/changes.mjs`: `export function parseTasks` |

## Open findings carried over

- **D-b — `schema.yaml` grows and the command files read less well standalone**
  (`adf-deferred-findings.md`, accepted decisions). Its regeneration argument no longer holds,
  so the trade-off is open again when iteration 04 places the propose rules. The schema's prose
  is now split per block, which removes the single large file.
- **The regeneration guard detects only what a regeneration removes, never what it adds**
  (design, round-five deferred findings). Moot: nothing regenerates the core's surface.
- **`/opsx:verify` calls the CLI through `npx` once; the CLI pin is undecided** (design,
  round-four deferred findings). Moot: no CLI.
- **A cold start with no `openspec/changes/` makes `openspec list --json` exit non-zero**
  (design, round-seven deferred findings). Fixed: `changes.mjs list` returns `{"changes": []}`.
- **The origin's claim that `openspec update` deletes `review.md`** is not supported by 1.5.0's
  code (found in this pass; static reading). The origin should re-measure before relying on it.
- **`openspec new change` announces `with schema 'spec-driven'` in its spinner even when the
  config names another schema** (`commands/workflow/new-change.js:59-61`, found in this pass).
  Moot.
- **The CLI's validator is inconsistent between main specs and deltas** (found by the port,
  kept for parity): a main spec accepts `SHALL` or `MUST` as a substring of the first line
  (`MUSTARD` passes), a delta needs a whole word; a main spec takes the header as the text of a
  requirement with no body, a delta reports it; a main spec counts any deeper header with
  content as a scenario, a delta counts `####` lines, inside code fences too; main specs are
  never checked for duplicate requirement names; a malformed `RENAMED` entry is dropped without
  an error; a repeated delta section keeps only the last one. Each is a candidate for a change
  of its own once the origin project runs on the core.
- **The origin's specs do not all validate today**: 7 changes and the main spec
  `firmware-upgrade` fail on the CLI itself (a requirement without `SHALL`/`MUST`, a change with
  no deltas). Found by the parity run; the port reports them the same way.

