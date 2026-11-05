# Iteration 18 — Documentation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger on GitHub learns from `README.md` what ADF is, why to use it, what it does and how to install it in Claude Code or Codex; `docs/guide/` documents every command, extension point, plugin and agent; `CHANGELOG.md` covers `v0.18.1` on; two checks keep the guide current.

**Architecture:** One shared module, `scripts/lib/guide.mjs`, reads the guide's pages and their `sources:` and matches globs; `scripts/check-guide.mjs` (in `npm test`) checks coverage and links from it, and `scripts/guide-review.mjs` builds the review packages from it and checks the agent's JSON reply, on the pattern of `review.mjs` (`input`, `check`). `scripts/check-release.mjs` gains the changelog and pinned-tag rules. The pages are written section by section against the code.

**Tech Stack:** Node 20+, standard library only, `node:test`; `git` through `execFileSync`, injectable for tests; the reply schema validated by `plugins/adf/scripts/lib/json-schema.mjs` (`validateJson`).

**Spec:** `docs/iterations/18-documentation.md`

## Global Constraints

- English only in every artifact; Conventional Commits; no `Co-Authored-By` or tool credit in a commit or the PR.
- Gate every commit on the tests: `npm test && git commit ...`; push after each commit; never force, never amend, no `git stash`.
- Every page of `docs/guide/`, `README.md` and `CHANGELOG.md` is ASD-STE100: one idea per sentence; at most 20 words in a procedure sentence, 25 in a description; active voice; imperative for a step, one action per step; one term per concept. Identifiers stay as they are.
- Every claim about a command, a file, a flag or an agent comes from the code or the iteration records, read in this task; never from memory. A claim not checked says so on the page.
- No cost figures and no comparison with other tools on any page.
- No release: `metadata.version` stays `0.20.0`; no tag.
- `land` is not in the main cycle; it is documented in `docs/guide/extension-points/contract/tracker.md`.
- A command is named in the Claude Code form (`/adf:propose`); each page that names one links once to `getting-started/codex.md` for the Codex form.
- A page's sources are an HTML comment on its first lines, not YAML front matter (GitHub renders front matter as a table to the reader):
  ```
  <!-- sources:
  - plugins/adf/skills/propose/**
  - plugins/adf/scripts/lib/propose.mjs
  -->
  ```
- A script prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage error.
- Subagents never commit; the controller commits and checks each commit for a forbidden trailer.

## Review Focus

1. A source glob that matches no file (a typo, or a file renamed later): `check-guide` names the page and the glob, it does not pass silently (Task 1 test `a glob that matches nothing is an error`).
2. A link with an anchor or a query (`../cycle/propose.md#resume`), a link to a directory, and an external link: the anchor is stripped, a directory resolves when it exists, `http(s):` and `mailto:` are skipped (Task 1 test `links: anchors, directories and external links`).
3. A guide-review reply that names a page outside its package, a source line past the end of the file, or extra fields: `check` refuses it with the reason (Task 9 test `a reply outside the package is refused`).
4. A diff from a tag that does not exist (`--from v9.9.9`): `input` refuses with exit 1 and names the tag, it does not review nothing (Task 9 test `an unknown tag is refused`).
5. A pinned tag inside a prose sentence ("Codex support starts at v0.20.0") is not a pin; only `--ref v…`, `"ref": "v…"` and `#v…` count (Task 8 test `prose mentions of a version are not pins`).

---

### Task 1: The guide module and `check-guide.mjs`

**Files:**
- Create: `scripts/lib/guide.mjs`, `scripts/check-guide.mjs`
- Test: `plugins/adf/scripts/__tests__/check-guide.spec.mjs`

**Interfaces:**
- Produces, in `scripts/lib/guide.mjs`:
  - `parseSources(text) -> string[]` — the list in the leading `<!-- sources: … -->` comment; `[]` when there is none.
  - `matchGlob(pattern, path) -> boolean` — `*` is one path segment's characters, `**` any number of segments; no other syntax.
  - `readPages(root) -> Array<{ path, text, sources }>` — every `*.md` under `docs/guide/`, paths relative to `root`, POSIX separators.
  - `listFiles(root, dirs) -> string[]` — every file under the given repository-relative dirs, relative to `root`.
- Produces, in `scripts/check-guide.mjs`:
  - `checkGuide({ pages, extraLinkPages, skills, plugins, points, registryKeys, coveredFiles, files, exists }) -> string[]` — the errors; pure.
  - `REGISTRY_KEYS = ['contract', 'branches', 'extensions', 'metrics', 'plugin', 'path', 'points', 'config', 'version']` (the top level and the entry fields, `plugins/adf/contract/README.md` `## The registry`).
  - CLI: gathers the inputs from the repository and prints `{ "ok": true }` or `{ "ok": false, "errors": [...] }`, exit 1 on errors.
- The inputs the CLI gathers:
  - `skills`: `<plugin>:<name>` for every `plugins/<plugin>/skills/<name>/SKILL.md`; a page names it as `` `/<plugin>:<name>` ``.
  - `plugins`: every `name` in `.claude-plugin/marketplace.json`; a page names it as `` `<name>` ``.
  - `points`: every `` ### `<name>` `` heading in `plugins/adf/contract/README.md`; named as `` `<name>` ``.
  - `registryKeys`: `REGISTRY_KEYS`; named as `` `<key>` ``.
  - `coveredFiles`: every file under `plugins/*/skills/`, `plugins/*/contract/`, `plugins/*/hooks/`; each must match some page's `sources:`.
  - `extraLinkPages`: `README.md` and `CHANGELOG.md`, checked for links only.

- [ ] **Step 1: Write the failing tests:** `parseSources reads the leading comment`; `a page with no sources comment has none`; `matchGlob: * stays in a segment, ** crosses them`; `a skill no page names is an error`; `a plugin, a point and a registry key no page names are errors`; `a covered file no sources entry matches is an error`; `a glob that matches nothing is an error` (names page and glob); `links: anchors, directories and external links` (`x.md#a` resolves to `x.md`, `http:`/`https:`/`mailto:`/`#a` skipped, a missing target names page and link); `README.md links are checked`; `a complete fixture passes` (`[]`).
- [ ] **Step 2: Run** `node --import ./test/env.mjs --test plugins/adf/scripts/__tests__/check-guide.spec.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `scripts/lib/guide.mjs` and `scripts/check-guide.mjs` (header comment as in `check-release.mjs`; `isMain` from `scripts/lib/main.mjs`). Links are `](target)` in the text outside fenced code blocks.
- [ ] **Step 4: Run** the spec. Expected: PASS. Do not add the script to `npm test` yet (the guide does not exist; Task 2 adds it).
- [ ] **Step 5: Commit** `feat(guide): check-guide finds a part of the flow with no page or a dead link`.

### Task 2: The guide skeleton, wired into `npm test`

**Files:**
- Create: every page of the tree in the spec's `### The user guide: docs/guide/`, each with its `<!-- sources: -->` comment, an `#` title, its section headings, and the names `check-guide` requires; body text one line per section saying what it will hold. The plugin pages are `docs/guide/plugins/<plugin>.md`.
- Move: `docs/switching.md` → `docs/guide/getting-started/switching.md` (`git mv`); fix its relative links.
- Modify: `package.json` `test` (append `&& node scripts/check-guide.mjs`); `README.md` and `docs/roadmap.md` links to `docs/switching.md`.

**Interfaces:**
- Consumes: `check-guide.mjs` (Task 1).
- Produces: the page paths every later task fills. Sources ownership: each skill dir to its `cycle/` page (`land` to `extension-points/contract/tracker.md`; `init`, `add`, `remove` to `getting-started/` and `plugins/README.md`; `update` to `update.md`; `adf-jira` skills to `plugins/adf-jira.md`); `plugins/adf/contract/**` to `extension-points/README.md` and the `contract/` pages; each `hooks/` dir to `extension-points/agent-hooks.md`.

- [ ] **Step 1: Run** `node scripts/check-guide.mjs` before any page exists. Expected: exit 1, the errors name every skill, plugin, point and key.
- [ ] **Step 2: Create** the pages and the move.
- [ ] **Step 3: Run** `npm test`. Expected: 0 failures, `check-guide` prints `{"ok":true}`.
- [ ] **Step 4: Commit** `docs(guide): the guide skeleton, checked by npm test`.

### Task 3: Getting started

**Files:** `docs/guide/README.md`, `docs/guide/getting-started/{claude-code,codex,switching,first-change}.md`.

- `claude-code.md`: prerequisites (Node 20+), the marketplace pinned by `ref` in the project's `.claude/settings.json` (`extraKnownMarketplaces.agentic-dev-flow.source.ref`, `plugins/adf/scripts/lib/update.mjs`), `claude plugin install <id> --scope project`, the restart, `/adf:init`, `/adf:add`; the facts of `docs/iterations/16-update.md` (`claude plugin install` is a no-op for an installed plugin).
- `codex.md`: the commands of `README.md` `### Codex` with `--ref v0.20.0`; user scope; invoke a skill by the name `/skills` lists; trust the hooks once in `/hooks`; `CODEX_HOME`; `runlog.mjs collect`. Mark as not checked: the `$adf:<name>` form and the `/hooks` trust screen (`docs/iterations/17-codex.md` `Not checked`).
- `first-change.md`: one small change from `/adf:propose` to `/adf:archive`, each step's command, what it asks and what it leaves on disk.
- `docs/guide/README.md`: what ADF is in three sentences, the section map, where to start for each agent.

- [ ] **Step 1: Write** the pages from the code and the records named above.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 3: Commit** `docs(guide): getting started in Claude Code and Codex`.

### Task 4: The cycle

**Files:** `docs/guide/cycle/{README,propose,apply,verify,review,archive,retro}.md`.

Each command page says, from its `SKILL.md` and its scripts: what the command takes, what it asks the developer, what it writes and where, what it commits, and how a rerun resumes after a stop. `README.md`: the diagram `propose → apply → verify → review → archive`, the artifacts and where they live (`openspec/changes/`, `openspec/specs/`), `retro` apart from the cycle, and a link to `extension-points/` for the full cycle with `land`.

- [ ] **Step 1: Write** the pages.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 3: Commit** `docs(guide): the change cycle, one page per command`.

### Task 5: Extension points

**Files:** `docs/guide/extension-points/README.md`, `extension-points/contract/{tracker,forge,knowledge,upstream,provision-teardown,verify-check}.md`, `extension-points/agent-hooks.md`.

- `README.md`: the full cycle with `land` marked *optional — needs a tracker plugin*, a table of every point (type, when it acts, the plugins that provide it, what the core does with none), the two parts (contract points, agent hooks). It names `plugins/adf/contract/README.md` as the normative contract for plugin authors.
- Each `contract/` page: what the point is, when it acts, its operations in one line each with a link to the contract README section, the core's default with no provider (from `roles.mjs` and the contract README), the plugins that provide it. `tracker.md` documents `/adf:land` in full from `plugins/adf/skills/land/SKILL.md`.
- `agent-hooks.md`: one section per `hooks/hooks.json` — `adf` `SessionStart` (the update notice), `adf-english-check` `PreToolUse` on Bash (blocks a commit of non-English lines), `adf-npm-workspaces` `PreToolUse` on Bash (the npm guard); in Codex a hook runs only after it is trusted in `/hooks`, and a plugin with hooks ships `.codex-plugin/plugin.json` (`docs/iterations/17-codex.md`).

- [ ] **Step 1: Write** the pages.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 3: Commit** `docs(guide): extension points and agent hooks`.

### Task 6: Plugins

**Files:** `docs/guide/plugins/README.md`, `docs/guide/plugins/<plugin>.md` for the eight plugins; Modify: `plugins/<plugin>/README.md` for each.

Each plugin page holds what its README holds today, rewritten in STE: what it does, the points or hooks it provides (linked), install and `/adf:add` in both agents, every `config` key with its meaning, its own skills. Each plugin README shrinks to: one paragraph of what it provides, and a link to its guide page. `plugins/README.md`: a table, plugin → what it adds → what is skipped without it.

- [ ] **Step 1: Write** the pages, then shrink the READMEs.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures (the plugin tests read no README text; if one does, keep the text it reads).
- [ ] **Step 3: Commit** `docs(guide): one page per plugin; plugin READMEs link to it`.

### Task 7: Concepts, projects, update, troubleshooting, contributing

**Files:** `docs/guide/concepts/{registry,worktrees,capability-levels,memory-and-debt,metrics,host-files}.md`, `docs/guide/projects/{several-projects,team}.md`, `docs/guide/{update,troubleshooting,contributing}.md`.

- `registry.md` explains every key of `REGISTRY_KEYS` and links to the contract README for the normative text.
- `host-files.md` takes `README.md` `## Host files`; `contributing.md` takes `## Layout` and `## Tests`, and says issues and pull requests are welcome.
- `several-projects.md` takes the spec's `## Inputs`, one section per agent, and says what is not checked.
- `team.md`: after the merge request that installs or updates the flow, each teammate runs `/adf:update` once and restarts.
- `troubleshooting.md`: the refusals a developer meets, each with its message as printed and what to do; collect them from the scripts' refusal strings for `init`, `add`, `propose`, `apply`, `update`.

- [ ] **Step 1: Write** the pages.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 3: Commit** `docs(guide): concepts, projects, update, troubleshooting, contributing`.

### Task 8: `README.md`, `CHANGELOG.md` and the release rules

**Files:**
- Modify: `README.md` (rewritten as the product page, the spec's `### The first page`), `scripts/check-release.mjs`
- Create: `CHANGELOG.md`
- Test: `plugins/adf/scripts/__tests__/check-release.spec.mjs`

**Interfaces:**
- Produces, in `scripts/check-release.mjs`:
  - `changelogVersions(text) -> string[]` — the `x.y.z` of every `## [x.y.z]` heading.
  - `pinnedTags(text) -> string[]` — every tag in `--ref v<x.y.z>`, `"ref": "v<x.y.z>"` or `#v<x.y.z>`.
  - `checkRelease({ marketplace, manifests, headTags, differ, changelog, pinned })` — adds two errors: `CHANGELOG.md has no section for <version>`; `<file>: pinned tag <tag> must be v<version>`. `pinned` is `Array<{ file, tags }>` from `README.md` and `docs/guide/getting-started/*.md`.

- [ ] **Step 1: Write the failing tests:** `a version with no changelog section fails`; `the Unreleased section is not a version`; `a stale pinned tag fails and names the file`; `prose mentions of a version are not pins`.
- [ ] **Step 2: Run** the spec. Expected: FAIL.
- [ ] **Step 3: Implement** the two functions and the two rules.
- [ ] **Step 4: Write** `CHANGELOG.md`: *Keep a Changelog* header, `## [Unreleased]` (the guide, the two checks), then `## [0.20.0]`, `## [0.19.0]`, `## [0.18.1]` with dates from `git log -1 --format=%as <tag>` and entries from `git log <prev>..<tag>` and the iteration records, written for a user; no `v0.18.0` section.
- [ ] **Step 5: Write** `README.md`: title, tagline, cycle diagram without `land`; Commands table (`/adf:land` marked optional); Quick start, one `<details>` per agent, pinned to `v0.20.0`; Plugins table with links; How it works; Why ADF (full control from context, plans and decomposition to review, verification and delivery; flexibility; built on OpenSpec — the spec-driven model, ADF's own engine with no openspec CLI — and Superpowers — the agent's working skills — and what ADF adds); Documentation; Contributing; License. Remove the status table, `## Layout`, `## Tests`, `## Host files`.
- [ ] **Step 6: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 7: Commit** `docs: README as the product page, CHANGELOG from v0.18.1, release checks for both`.

### Task 9: `guide-review.mjs`

**Files:**
- Create: `scripts/guide-review.mjs`, `scripts/guide-review/prompt.md`, `scripts/guide-review/reply.schema.json`
- Test: `plugins/adf/scripts/__tests__/guide-review.spec.mjs`

**Interfaces:**
- Consumes: `readPages`, `matchGlob` (Task 1); `validateJson` from `plugins/adf/scripts/lib/json-schema.mjs`.
- Produces:
  - `selectPages({ pages, changed }) -> pages` — a page whose `sources:` match a changed file, or whose own path is changed.
  - `buildPackages({ pages, changed, from }) -> Array<{ section, from, pages: [{ path, sources: string[], touched: string[] }] }>` — one package per first path segment under `docs/guide/` (`README.md` at the top goes with `getting-started`).
  - `checkReply({ reply, pkg, exists, lineCount }) -> { ok, errors, findings }`.
  - CLI `input --from <tag> --out <dir>`: `git diff --name-only <tag>...HEAD`; writes `<dir>/<section>.json` and prints `{ "packages": [{ "section", "file", "pages" }] }`; exit 1 for an unknown tag.
  - CLI `check --package <file> --reply <file>`: prints `{ "ok", "errors", "findings" }`; exit 1 when the reply is invalid; a valid reply with findings exits 0 and lists them.
  - Reply schema: `{ "findings": [{ "page", "claim", "source": { "path", "line" }, "fix" }] }`, `additionalProperties: false` at every level.
- `prompt.md`: the read-only reviewer's task: read each page and its sources at `HEAD`, report each claim the sources contradict with the contradicting line, reply only the JSON; no STE or style findings.

- [ ] **Step 1: Write the failing tests:** `a page is selected by a touched source`; `a page is selected when it changes itself`; `packages are split by section`; `an unknown tag is refused`; `a valid empty reply passes`; `a reply outside the package is refused`; `a source line past the end is refused`; `extra fields are refused`.
- [ ] **Step 2: Run** the spec. Expected: FAIL.
- [ ] **Step 3: Implement** the script, the schema and the prompt.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(guide): guide-review builds the review packages and checks the replies`.

### Task 10: The upkeep rule, the first review run, the record

**Files:** Modify `docs/roadmap.md`, `docs/iterations/18-documentation.md`, and the pages the findings name.

- [ ] **Step 1: Add** to `docs/roadmap.md` `## Checks after every iteration`: 3. `check-guide.mjs` (in `npm test`); 4. `guide-review.mjs` with no open finding, in every release step; 5. a release adds its `CHANGELOG.md` section. And: a flow change updates its pages in the same commit. Update row 18 to the spec's wording (Claude Code and Codex, extension points, changelog).
- [ ] **Step 2: Run** `node scripts/guide-review.mjs input --from v0.20.0 --out <scratch>/guide-review`. Expected: one package per section, every page selected.
- [ ] **Step 3: Dispatch** one read-only agent per package with `scripts/guide-review/prompt.md`; save each reply; run `check` on each. Expected: every reply valid.
- [ ] **Step 4: Fix** each finding on its page; rerun the affected packages until no finding is open.
- [ ] **Step 5: Write** `## Result` in `docs/iterations/18-documentation.md`: the checks run with their output, the findings and their fixes, what was not checked.
- [ ] **Step 6: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 7: Commit** `docs(18): the upkeep rule and the result`; open the PR into `main` (no tool credit in its text).
