# Iteration 16 — Update: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project learns at session start that a newer package release exists, and its owner brings it up to date with `/adf:update` in one merge request.

**Architecture:** Pure functions in `plugins/adf/scripts/lib/update.mjs` (versions, the changed plugins, the changes in flight), `lib/migrate.mjs` (a plugin's `config` migrations) and `lib/host-merge.mjs` (the host files' three versions); one CLI, `scripts/update.mjs`, with `check`, `notice`, `pull`, `plan` and `apply`; a `SessionStart` hook in `plugins/adf/hooks/hooks.json`; the command `plugins/adf/commands/update.md`. The update runs the new release's own scripts from a temporary clone of the new tag.

**Tech Stack:** Node 20+, standard library only, `node:test`; `git` and the `claude` CLI through `execFileSync`, injectable for tests.

**Spec:** `docs/iterations/16-update.md`

## Global Constraints

- English only in every artifact; Conventional Commits; no `Co-Authored-By` or tool credit.
- Gate every commit on the tests: `npm test && git commit ...`; push after each commit; never force.
- The core's scripts use Node's standard library only.
- The package version is `metadata.version` in `.claude-plugin/marketplace.json`; the tag is `v<metadata.version>`.
- The registry is `.claude/adf-extensions.json`; the marketplace name is `agentic-dev-flow`.
- The update never moves the global marketplace record (`known_marketplaces.json`); only `pull` (a teammate's or a user-scope install) does.
- A script prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage error (the pattern of `scripts/init.mjs`).
- Every subagent dispatch: subagents never commit; the orchestrator commits.

## Review Focus

1. No network or no `git` at session start: the notice says nothing, exits 0, and the session starts (Task 6 test `notice is silent when ls-remote fails`).
2. A registry entry with no `version` and a plugin that is new in the new release (no old version at all): no migration runs for the new one, the old one takes the old tag's version (Task 5 test `unknown version reads from the old manifest; a new plugin migrates nothing`).
3. A `planning.md` whose managed sections hold real values, with the developer choosing *replace from the update*: the values survive (Task 8 test `replace keeps the managed sections`).
4. A `ref` that is not a `vX.Y.Z` tag (a branch name, a commit, missing): `check` reports `ref: unpinned` and no notice compares it (Task 4 test `an unpinned ref is reported, never compared`).
5. `/adf:update` started with uncommitted tracked files or an existing update branch: it refuses before the clone, naming what blocks it (Task 9 test `apply refuses a dirty main directory and an existing branch`).

---

### Task 1: Install records count from a worktree and from project trust (issue #12)

**Files:**
- Modify: `plugins/adf/scripts/lib/installed.mjs` (`installedPath`)
- Modify: `plugins/adf/scripts/lib/superpowers.mjs` (`countsHere`)
- Test: `plugins/adf/scripts/__tests__/installed.spec.mjs`

**Interfaces:**
- Produces: `countsHere(record, roots: string[]) -> boolean`; `installedPath(id, root, { home, exists }) -> string` unchanged in shape.

- [ ] **Step 1: Write the failing tests** in `installed.spec.mjs`:
  - `a project record for the current worktree counts`: a record with `projectPath` = the worktree, `installedPath(id, worktree)` returns its `installPath`.
  - `a plugin enabled in project settings and present in the cache counts with no record`: no record; the main directory's `.claude/settings.json` enables the id; `<home>/plugins/cache/agentic-dev-flow/<name>/<version>/` exists, where `<version>` is the plugin's version in `<home>/plugins/marketplaces/agentic-dev-flow/.claude-plugin/marketplace.json`; returns that directory.
  - `the refusal names the main directory`: with nothing found, the message contains `run it from <main directory>`.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/installed.spec.mjs`. Expected: the three tests FAIL.
- [ ] **Step 3: Implement.** `countsHere` takes the list `[main, worktree]`; `installedPath` falls back to the cache directory of the marketplace clone's version when the id is enabled in project settings; the refusal adds `run it from <main>`; user-facing text says "main directory", never "main checkout".
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures (the existing `superpowers.spec.mjs` callers pass a list).
- [ ] **Step 5: Commit** `fix(adf): count an install for the worktree and a trusted project's cached plugin (#12)`.

### Task 2: The resolved plugin root is reported (issue #14)

**Files:**
- Create: `plugins/adf/scripts/lib/plugin-root.mjs`
- Modify: `plugins/adf/scripts/extensions.mjs` (subcommand `where`), `plugins/adf/commands/init.md` (step 1 shows it)
- Test: `plugins/adf/scripts/__tests__/plugin-root.spec.mjs`

**Interfaces:**
- Produces: `pluginRoot({ home, scriptUrl }) -> { root: string, version: string, cached: boolean, warning: string|null }`: `cached` is true when `root` is under `<home>/plugins/cache/`; otherwise `warning` = `the adf scripts run from <root>, not from an installed release`.

- [ ] **Step 1: Write the failing tests** `a cached root has no warning` and `a root outside the cache warns and names it`.
- [ ] **Step 2: Run** them. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `pluginRoot`; `extensions.mjs where` prints it; `init.md` and later `update.md` show `warning` when not null.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): report the plugin root the scripts run from (#14)`.

### Task 3: The package version and its release check

**Files:**
- Modify: `.claude-plugin/marketplace.json` (`"metadata": { "version": "0.18.1" }`, the release task raises it)
- Create: `scripts/check-release.mjs`, `scripts/__tests__/check-release.spec.mjs`
- Modify: `package.json` (`test` runs `node scripts/check-release.mjs` after `check-lessons.mjs`)

**Interfaces:**
- Produces: `checkRelease({ marketplace, manifests: { [name]: version }, headTags: string[] }) -> string[]` (the errors).

- [ ] **Step 1: Write the failing tests**:
  - `metadata.version must be x.y.z`;
  - `each plugin entry's version equals its plugin.json` (error names the plugin and both versions);
  - `a v-tag on HEAD must equal v<metadata.version>` (`['v0.19.0']` against `0.18.1` fails; no tag passes).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `checkRelease` and the CLI (reads the files, `git tag --points-at HEAD`); exit 1 with the errors.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(release): the package version in marketplace.json, checked against the plugins and the tag`.

### Task 4: Versions, the project's ref and the latest tag

**Files:**
- Create: `plugins/adf/scripts/lib/update.mjs`
- Modify: `plugins/adf/scripts/lib/registry.mjs` (`addExtension` writes `version`; `validateRegistry` accepts an optional `x.y.z` `version`)
- Test: `plugins/adf/scripts/__tests__/update.spec.mjs`, `registry.spec.mjs`

**Interfaces:**
- Produces:
  - `compareVersions(a: string, b: string) -> -1|0|1` (`x.y.z`, numeric);
  - `latestTag(tags: string[]) -> string|null` (the highest `vX.Y.Z`, other tags ignored);
  - `projectRef(root) -> { ref: string|null, pinned: boolean }` (`extraKnownMarketplaces['agentic-dev-flow'].source.ref` in the main directory's `.claude/settings.json`; `pinned` when it matches `vX.Y.Z`);
  - `remoteTags(url, { git }) -> string[]` (`git ls-remote --tags <url>`, peeled `^{}` lines dropped);
  - `installedVersion(id, root, { home }) -> string|null` (the version of the record `installedPath` uses, or of a user-scope record outside a pinned project).

- [ ] **Step 1: Write the failing tests**: `compareVersions orders 0.9.0 < 0.10.0`; `latestTag ignores non-version tags`; `an unpinned ref is reported, never compared`; `addExtension writes the plugin's version from its plugin.json`; `a registry entry without version is valid`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the five functions and the registry change.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): read the project's ref, the latest tag and the plugin versions`.

### Task 5: The changed plugins and the config migrations

**Files:**
- Create: `plugins/adf/scripts/lib/migrate.mjs`
- Modify: `plugins/adf/scripts/lib/update.mjs`, `plugins/adf/scripts/lib/registry.mjs` (`validateDeclaration` accepts `migrations`), `plugins/adf/contract/README.md` (`## The declaration`: `migrations`), `plugins/adf/contract/contract.json` (`1.9`)
- Test: `plugins/adf/scripts/__tests__/migrate.spec.mjs`, `update.spec.mjs`

**Interfaces:**
- Consumes: `compareVersions` (Task 4).
- Produces:
  - `changedPlugins(registry, oldMarketplace, newMarketplace) -> [{ id, from: string|null, to: string, changed: boolean }]` for the registry's package entries (`@agentic-dev-flow`); `from` is the entry's `version`, else the old marketplace's;
  - declaration field `migrations: [{ version: "x.y.z", script: "<path in the plugin>" }]`; a script's default export is `(config: object) => object`;
  - `migrateConfig(entry, declaration, pluginDir, { from, to }) -> { config, ran: string[] }`: runs, in version order, the steps with `from < version <= to`.

- [ ] **Step 1: Write the failing tests**: `unknown version reads from the old manifest; a new plugin migrates nothing`; `steps run in order between from and to`; `a step outside the range does not run`; `a declaration with a malformed migrations entry is refused`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**; raise the contract to `1.9` (an optional field: a minor).
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): a plugin's config migrations, contract 1.9`.

### Task 6: `update.mjs check` and the session-start notice

**Files:**
- Create: `plugins/adf/scripts/update.mjs`, `plugins/adf/hooks/hooks.json`
- Modify: `plugins/adf/scripts/lib/update.mjs`
- Test: `plugins/adf/scripts/__tests__/update-cli.spec.mjs`

**Interfaces:**
- Consumes: Task 4's functions.
- Produces:
  - `update.mjs check [--root <dir>]` → `{ scope: "project"|"user"|"none", ref, pinned, installed, latest, behind: boolean, pull: boolean, inFlight: [{ change, worktree: string|null }] }`; `pull` is true when `installed` is older than a pinned `ref`;
  - `inFlight(root) -> [{ change, worktree }]`: the directories of `openspec/changes/` other than `archive/`, and the worktrees under `.claude/worktrees/`;
  - `update.mjs notice` (the hook): at most one `ls-remote` a day, cached in `<claudeHome>/adf/update-check.json` as `{ checkedAt, latest }`; prints `{ "systemMessage": "..." }` when `behind` or `pull`, nothing otherwise; always exit 0.

- [ ] **Step 1: Check the hook's output field.** Read the Claude Code hooks reference for `SessionStart`: the field that shows a message to the user. Expected: `systemMessage`; if another, use it and note it in the iteration's `## Decisions`.
- [ ] **Step 2: Write the failing tests**: `check reports behind when ref < latest`; `check sets pull when installed < ref`; `notice is silent when ls-remote fails`; `notice reads the cache within a day`; `user scope is checked only outside a pinned project`.
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement**. Messages: `ADF v<latest> is available; this project is on v<ref>. Run /adf:update.` and `This project pins ADF v<ref>; v<installed> is installed. Run /adf:update to install it.`
- [ ] **Step 5: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 6: Commit** `feat(adf): the session-start notice of a newer or a pinned release`.

### Task 7: `update.mjs pull`

**Files:**
- Modify: `plugins/adf/scripts/update.mjs`, `plugins/adf/scripts/lib/update.mjs`
- Test: `update-cli.spec.mjs`

**Interfaces:**
- Produces: `pull({ root, scope, claude }) -> { ran: string[][], restored: boolean }`: `claude plugin marketplace update agentic-dev-flow`, then `claude plugin install <id> --scope <scope>` for every enabled package plugin, run in the main directory; for project scope, the main directory's `.claude/settings.json` is restored with `git checkout --` when the install changed it and it was clean before.

- [ ] **Step 1: Check by hand** in a scratch project with a clean `CLAUDE_CONFIG_DIR`: after a pull that moves the `ref`, does a new session install the pinned release with no command? Record the answer in the iteration's `## Decisions`.
- [ ] **Step 2: Write the failing tests** with a fake `claude`: `pull runs the marketplace update, then one install per enabled plugin`; `pull restores a settings file it changed`; `pull refuses when settings.json had uncommitted changes`.
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 6: Commit** `feat(adf): pull the pinned release for a teammate or a user-scope install`.

### Task 8: The host files' three versions

**Files:**
- Create: `plugins/adf/scripts/lib/host-merge.mjs`
- Test: `plugins/adf/scripts/__tests__/host-merge.spec.mjs`

**Interfaces:**
- Produces:
  - `MANAGED = ['## Whole-suite command', '## Worktree copies', '## Worktree preparation', '## Format command']` (for `openspec/planning.md` only);
  - `hostFiles(oldClone, newClone, registry) -> [{ path, base: string|null, theirs: string|null }]`: the core's `planning.md` and `review-prompt.md` and each enabled plugin's `hostFiles`, read from the two clones;
  - `classify({ base, ours, theirs }) -> "same"|"replace"|"edited"|"new"|"absent"`: `same` when `ours === theirs`, `replace` when `ours === base`, `new` when the host lacks the file;
  - `replaceFromUpdate(path, ours, theirs) -> string`: `theirs`, with `MANAGED` sections' bodies taken from `ours` for `planning.md`;
  - `mergeKeep(base, ours, theirs) -> { text, conflicts: boolean }`: `git merge-file -p` over three temporary files; on conflicts, the command's agent resolves the markers.

- [ ] **Step 1: Write the failing tests**: `an unedited file is replace`; `replace keeps the managed sections`; `mergeKeep carries a template change and keeps a project edit`; `mergeKeep reports conflicts on the same line`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): classify and merge the host files against the old and the new templates`.

### Task 9: `update.mjs plan` and `apply`, and the command

**Files:**
- Modify: `plugins/adf/scripts/update.mjs`, `plugins/adf/scripts/lib/update.mjs`
- Create: `plugins/adf/commands/update.md`
- Test: `update-cli.spec.mjs`, `plugins/adf/scripts/__tests__/triggers.spec.mjs` (the new command's description)

**Interfaces:**
- Consumes: Tasks 4–8; `workspace.create(root, { change, branch, base: 'integration' })`; `forge.mjs open --change <name> --title <t> --draft false`.
- Produces:
  - `update.mjs plan --to <tag> [--root]`: clones the old and the new tag into a temporary directory (`git clone --depth 1 --branch <tag> <url>`), prints `{ from, to, plugins: changedPlugins, log: { [plugin]: string[] }, hostFiles: [{ path, class }], inFlight, clones: { old, new } }`; `log` holds the Conventional Commits subjects of `git log v<from>..v<to> -- plugins/<name>`, from a clone deep enough to hold both tags;
  - `update.mjs apply --to <tag> --clones <json> --choices <json> [--root]`, run from the new clone: makes the change `adf-update-<to>` (branch `chore/adf-update-<to>`) through `workspace.create`, sets the `ref`, runs `migrateConfig` and writes each entry's `version`, raises the registry's `contract`, writes each host file by its choice (`replace`, `keep`, `manual`: left for the developer, listed), and commits; prints `{ worktree, branch, written, manual, ran }`.
- `update.md`: run `extensions.mjs where`; `check`; with `pull`, run `pull` and stop; with no newer tag, say so and stop; `plan`; show the versions, the log per plugin and the changes in flight; on the developer's yes, for each `edited` host file show the three versions and ask "How to merge?" (automatic: then *keep everything* or *replace from the update*; manual); run `apply` from the new clone; resolve `mergeKeep` conflicts; `forge.mjs open` with the description listing the versions and the log; tell the developer to restart the session.

- [ ] **Step 1: Write the failing tests** on a fixture marketplace repository with tags `v0.1.0` and `v0.2.0`: `plan lists the changed plugins and their log`; `apply writes the ref, the migrated config and the versions, and commits on its own branch`; `apply refuses a dirty main directory and an existing branch`; `apply raises a major contract change as a refusal naming both versions`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the two subcommands and write `update.md`.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): /adf:update, one merge request to the latest release`.

### Task 10: Release and the scratch run

**Files:**
- Modify: the plugins' `plugin.json` and `marketplace.json` versions (adf `0.19.0`, `metadata.version` `0.19.0`), `README.md` status, `docs/iterations/16-update.md` (`## Result`), `docs/roadmap.md`

- [ ] **Step 1:** Raise the versions; run `npm test && npm run parity -- /Users/antonromankov/Projects/promwad/dessau/xnms`. Expected: 0 failures, every parity tool PASS, the origin's tree clean.
- [ ] **Step 2:** Commit `chore(adf): release 0.19.0, iteration 16`; tag `v0.19.0`; push the commit and the tag.
- [ ] **Step 3:** The scratch run, nothing published: a local bare clone of this repository at `v0.19.0` with one more local commit tagged `v0.19.1`; a scratch project whose `ref` is moved by hand from `v0.18.1` to `v0.19.0` (the one manual update) and whose marketplace `url` points at the bare clone. Check: a new session shows the notice for `v0.19.1`; `/adf:update` opens the update branch with the new `ref`, a migrated `config` and one edited host file merged each way. Record the run in `## Result`.
- [ ] **Step 4:** Commit `docs(iterations): iteration 16 result`.
