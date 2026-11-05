# Iteration 19 — Merge request links: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every merge request the flow opens for a change starts with one line per tracker issue and per debt entry of the change's scope, written by the flow from `scope.json`.

**Architecture:** One core module, `plugins/adf/scripts/lib/mr-links.mjs`, builds the `links` list from a change's `scope.json` and git, and decides how it reaches the forge: as the input `links` for a provider of contract 1.10 or later, or rendered at the top of `body` at `finalize` for an older one. `forge.mjs open|finalize --change` and the archive's `mr` step call it. `adf-gitlab` renders `links` at the top of the change's marker block and makes a permanent file URL for a debt entry.

**Tech Stack:** Node 20+, standard library only, `node:test`; `git` through an injectable runner.

**Spec:** `docs/iterations/19-merge-request-links.md`

## Global Constraints

- English only in every artifact; Conventional Commits; no `Co-Authored-By` or tool credit in a commit or the PR.
- Gate every commit on the tests: `npm test && git commit ...`; push after each commit; never force, never amend, no `git stash`.
- Work on branch `feat/19-merge-request-links` and one PR, as iterations 17 and 18.
- Contract version `1.10`. `links` is an optional input field of the existing `forge` operations `open` and `finalize`; no operation is added.
- The agent never writes `links`; only scripts build it.
- A version comparison of contract versions is numeric per part (`1.10` is above `1.9`), never a string comparison.
- The rendered lines, the same in the core's fallback and in `adf-gitlab` (exact copy):
  - tracker with URL: `- Issue [<key>](<url>): <title>`
  - debt with URL: `- Debt [<key>](<url>): <title>`
  - no URL: `- Issue <key>: <title>` or `- Debt <key>: <title>`
  - the list is preceded by the line `Scope:` and followed by one blank line.
- A flow change updates its guide pages in the same commit (`docs/roadmap.md`, `## Checks after every iteration`): each task's commit also updates every page of `docs/guide/` whose `sources:` match a file the task changes; `check-guide.mjs` in `npm test` gates it. No task writes `CHANGELOG.md`; the release writes the section of its version from the flow and plugin changes, and a documentation change gets no entry (the documentation is `docs/`, `README.md`, `CHANGELOG.md` and a plugin's own `README.md`; a skill, a command, an instruction or a template is the flow).
- Subagents never commit; the controller commits and checks each commit for a forbidden trailer.

## Review Focus

1. A forge declaration of contract `1.9` or `1.7` against a core of `1.10`: the comparison is numeric, so the core takes the fallback into `body` (Task 2 test `a provider of contract 1.9 gets the links in body`).
2. A debt entry added in the working tree and not yet committed on the base: `git cat-file -e` fails, the link has `commit: null`, and the line is `- Debt <id>: <title>` (Task 1 test `a debt entry absent at the merge base has no commit`).
3. A repository with no `origin` remote or no `origin/<base>`: `merge-base` fails, every debt link has `commit: null`, and nothing is refused (Task 1 test `no origin gives debt links without a commit`).
4. A title holding Markdown characters (`]`, `|`, a newline): the provider renders it on one line with `]` escaped and newlines replaced by a space (Task 3 test `a title with Markdown characters stays on one line`).
5. A `finalize` on a description whose block was written by `open` with links: the links appear once, at the top of the block, not twice (Task 3 test `finalize replaces the links open wrote`).

---

### Task 1: Contract 1.10 and the links builder

**Files:**
- Modify: `plugins/adf/contract/contract.json` (`version` `1.10`), `plugins/adf/contract/README.md` (the version list line after `1.9`, the `forge` heading `links since 1.10`, the `links` paragraph under the forge table)
- Modify: `plugins/adf/scripts/lib/registry.mjs` (export `atOrBelow`)
- Create: `plugins/adf/scripts/lib/mr-links.mjs`
- Test: `plugins/adf/scripts/__tests__/mr-links.spec.mjs`; update the `1.9` assertions in `roles.spec.mjs:117-118` and `extensions.spec.mjs:42` to `1.10`

**Interfaces:**
- Produces, in `lib/mr-links.mjs`:
  - `buildLinks(root, scope, base, { git }) -> Array<Link>` — `Link` is `{ kind: 'tracker', key, title, url }` (`url` a string or `null`) or `{ kind: 'debt', key, title, path, commit }` (`path` = the item's `files[0]`; `commit` the merge-base hash or `null`). Items whose `state` is in `IN_SCOPE` (`lib/scope.mjs`), in the scope's order, tracker items first. `scope` null or with none taken gives `[]`. `git(args) -> { status, stdout }` runs in `root`; default `spawnSync('git', args, { cwd: root })`.
  - `renderLinks(links) -> string` — the exact copy of the Global Constraints; `''` for `[]`. A debt link renders without a URL in the core (the core makes no file URL).
  - `linksInput(operation, input, links, providerContract) -> object` — `providerContract` at or above `1.10`: `{ ...input, links }`; below and `operation === 'finalize'`: `{ ...input, body: renderLinks(links) + input.body }`; below and `open`: `input` unchanged. `links` `[]`: `input` unchanged.
  - `LINKS_SINCE = '1.10'`.
- The merge base: `git merge-base HEAD origin/<base>`, once per call; each debt path checked with `git cat-file -e <commit>:<path>`.

- [ ] **Step 1: Write the failing tests** in `mr-links.spec.mjs`, on a scope fixture with two tracker items (one taken with `url`, one `excluded`), one partial tracker item with `url: null`, and two debt items, and a fake `git`:
  - `buildLinks keeps taken and partial items, tracker first` — kinds and keys in order; the excluded item absent.
  - `a debt entry present at the merge base carries the commit` — `commit` equals the fake merge-base hash.
  - `a debt entry absent at the merge base has no commit` — fake `cat-file` exits 1 → `commit: null`.
  - `no origin gives debt links without a commit` — fake `merge-base` exits 128 → every debt `commit: null`, no throw.
  - `no scope or nothing taken gives no links` — `buildLinks(root, null, 'main')` and a scope of only `excluded` items give `[]`.
  - `renderLinks writes the exact lines` — asserts the full string for one tracker with URL, one without, one debt: `Scope:\n- Issue [PROJ-1](https://t/PROJ-1): One\n- Issue PROJ-2: Two\n- Debt D-0001: Three\n\n`.
  - `linksInput passes links to a 1.10 provider and into body for 1.9` — for `'1.10'` and `'1.12'` the input has `links`; for `'1.9'` and `'1.7'` `finalize` has `body` starting with `Scope:` and no `links`; `open` for `'1.9'` is unchanged.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/mr-links.spec.mjs` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `lib/mr-links.mjs`, export `atOrBelow` from `registry.mjs`, set `contract.json` to `1.10`, write the contract README lines: "`1.10` adds the optional `links` input of the `forge` operations `open` and `finalize`." and, under the forge table, the `links` shape as in Interfaces, that the provider renders it at the top of the change's block, that a reused `open` changes no description, and that the core puts the lines at the top of `body` at `finalize` for a provider written before 1.10.
- [ ] **Step 4: Run** `npm test` — Expected: all pass, the `1.10` assertions included.
- [ ] **Step 5: Commit** `feat(contract): 1.10, the forge input links built from the scope`.

### Task 2: The core passes the links

**Files:**
- Modify: `plugins/adf/scripts/forge.mjs` (`run`: `open` and `finalize` with `--change`)
- Modify: `plugins/adf/scripts/lib/archive.mjs` (`mrStep` at `:792`, `unnamedKeys` at `:834`, `mrInput` at `:771`, the deps at `:204`)
- Modify: `plugins/adf/skills/archive/SKILL.md:69-72`, `plugins/adf/skills/propose/SKILL.md` near `:166` (one sentence: the Draft shows the scope's links)
- Test: `plugins/adf/scripts/__tests__/archive.spec.mjs`; `plugins/adf/scripts/__tests__/propose.spec.mjs` beside `forge.mjs open --change sends what the core read` (`:427`)

**Interfaces:**
- Consumes: `buildLinks`, `linksInput`, from Task 1.
- `forge.mjs` with `--change` and operation `open` or `finalize`: reads the change's `scope.json` by `findChangeDir(root, name)` (`lib/ingest.mjs:66`) + `SCOPE_FILE`; the provider's contract from `provider(root, 'forge', CORE)?.declaration.contract`; an `input.links` the caller passed is refused (`input.links is built by the core; leave it out`). Without `--change`, nothing changes (update and retro pass none).
- Archive deps gain `forgeContract: () -> string | null`, default from `provider(...)`. `mrStep` builds the links with `baseOf(ctx)` and passes `linksInput('finalize', ...)`.
- `unnamedKeys(ctx, text, links)`: a key counts as named when the body names it or a link has it. Refusal text: `the merge request names no ${keys}: neither the body nor the links built from scope.json hold them`.
- `mrInput` returns a new field `links` (the built list) and the skill's `mr` text no longer asks the body to name the keys.

- [ ] **Step 1: Write the failing tests:**
  - archive: `mr passes the scope's links to a 1.10 forge` — fake forge records the `finalize` input; it has `links` with the scope's keys; the body has no key and the step is `done`.
  - archive: `a provider of contract 1.9 gets the links in body` — `forgeContract` returns `'1.9'`; the recorded `body` starts with `Scope:` and has no `links`.
  - archive: `the key check still refuses when no link holds the key` — `buildLinks` stubbed (or the scope altered after build) so one key is in neither; the step refuses with the new text.
  - archive: `mr-input lists the links` — `mrInput(...).links` deep-equals the built list.
  - propose.spec: `open --change passes links from scope.json` and `open --change refuses an input with links`; `open without --change passes no links`.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/archive.spec.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces; edit the archive skill's `mr` bullet so it says the links come from the scope and the body has the template's sections only.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf): the forge gets the scope's links at open and finalize`.

### Task 3: `adf-gitlab` renders the links

**Files:**
- Modify: `plugins/adf-gitlab/scripts/lib/forge.mjs` (`validate`, `placeholder`, `open`, `finalize`, a new `renderLinks` and `fileUrl`)
- Modify: `plugins/adf-gitlab/adf-extension.json` (`contract` `1.10`)
- Test: `plugins/adf-gitlab/scripts/__tests__/forge.spec.mjs` (update `:607` to `1.10`)

**Interfaces:**
- `fileUrl({ run, root, config }, path, commit) -> string | null` — `https://<host>/<slug>/-/blob/<commit>/<path>`; host as `configuredHost` reads it, slug from `git remote get-url origin` (the same parse as the core's `slugOf`: strip scheme, user and host, and `.git`); `null` when either is missing or `commit` is null.
- `renderLinks(links, urlOf) -> string` — the Global Constraints' copy; a tracker link uses `url`; a debt link uses `urlOf(path, commit)`; a title is one line with `]` written `\]` and each newline a space.
- `validate`: `links`, when present, is an array of objects with `kind` `tracker` or `debt` and a non-empty `key`; otherwise refused with `input.links must be a list of { kind, key, title } items; nothing was pushed and no merge request was touched.`
- `open` creates with `mergeDescription('', change, renderLinks(...) + <placeholder sentence>)`; a reused merge request still gets no `glab mr update`.
- `finalize` writes the block `renderLinks(...) + body`; `parseBody` still validates `body` alone.

- [ ] **Step 1: Write the failing tests:**
  - `open writes the links above the placeholder` — the `glab mr create` `--description` holds `Scope:` then the lines, then the placeholder sentence, inside the marker.
  - `a reused open changes no description` — handler returns one open MR; no call starts with `glab mr update`.
  - `finalize replaces the links open wrote` — existing description from an `open` with links; the merged description holds `Scope:` once.
  - `a debt link gets the permanent file URL` — origin `git@gitlab.example.com:group/proj.git`, commit `abc123`, path `docs/debt/index.md` → `https://gitlab.example.com/group/proj/-/blob/abc123/docs/debt/index.md`.
  - `a debt link without a commit has no URL` — the line is `- Debt D-0001: Title`.
  - `a title with Markdown characters stays on one line`.
  - `malformed links are refused with nothing sent` — `links: [{ kind: 'pr', key: 'x' }]`; no call recorded.
  - `the declaration names contract 1.10`.
- [ ] **Step 2: Run** `node --test plugins/adf-gitlab/scripts/__tests__/forge.spec.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(adf-gitlab): render the scope's links at the top of the change's block`.

### Task 4: The guide

**Files:**
- Modify: `docs/guide/plugins/adf-gitlab.md` (rows `open` and `finalize` at `:17-19`; a section "Links to the scope"), `docs/guide/extension-points/contract/forge.md` (the `links` input), `docs/guide/cycle/propose.md`, `docs/guide/cycle/archive.md` (the Draft and the final description carry the links; the body no longer names the keys), `docs/guide/update.md` (a host that has a CI job adding the tracker link removes it in the update merge request; the job skips a key already present, so both can run during the change)
- Test: `node scripts/check-guide.mjs`

- [ ] **Step 1:** Write the pages in ASD-STE100, each claim checked against the code of Tasks 1–3; add `plugins/adf/scripts/lib/mr-links.mjs` to the `sources:` of `forge.md`, `propose.md` and `archive.md`.
- [ ] **Step 2: Run** `node scripts/check-guide.mjs` — Expected: `{ "ok": true }`.
- [ ] **Step 3: Commit** `npm test && git commit -m "docs(guide): the merge request links"`.

### Task 5: A real merge request

**Files:**
- Modify: `docs/iterations/19-merge-request-links.md` (a `## Result` section)

- [ ] **Step 1:** In a scratch GitLab project the developer names (ask; do not create one), with the PR branch's plugins installed in a scratch host: run `forge.mjs open --change` and `archive.mjs mr` for (a) a scope with one tracker item and one debt entry committed on the base, (b) debt only, no tracker plugin.
- [ ] **Step 2:** Check in the GitLab interface: the Draft shows the links at the top; the final description shows them once; the debt link opens the entry's file at the merge-base commit.
- [ ] **Step 3:** Write the run's notes, the merge request URLs and what was not checked in `## Result`; commit `docs(iterations): the result of iteration 19`.

### Task 6: Release v0.21.0

After the PR is merged by the developer, on `main`. Iteration 18 changed documentation only, so it is no release of its own and has no changelog entry; its pages ship with this tag.

**Files:**
- Modify: `.claude-plugin/marketplace.json` (`metadata.version` `0.21.0`; the `version` of each plugin whose files changed since `v0.20.0`: `adf` and `adf-gitlab` at least), each such plugin's `.claude-plugin/plugin.json`; then `node scripts/manifests.mjs` writes the Codex manifests
- Modify: `CHANGELOG.md` (a new section `## [0.21.0] — <date>` above `## [0.20.0]`, written from `git log v0.20.0..HEAD`: the changes to the flow and the plugins only, under Added, Changed and Fixed; no `[Unreleased]` section), the pinned tags in `README.md` and `docs/guide/` (`v0.20.0` to `v0.21.0`)

- [ ] **Step 1:** `git diff --name-only v0.20.0..HEAD -- plugins/` lists the changed plugins; bump each plugin with a change outside its documentation: minor for a new feature, patch for a fix. A plugin whose only changes are documentation keeps its version.
- [ ] **Step 2: Run** `node scripts/guide-review.mjs input --from v0.20.0 --out .superpowers/guide-review/0.21.0`, dispatch one read-only agent per package, `guide-review.mjs check` each reply; fix every finding in the guide and run it again until none is open.
- [ ] **Step 3: Run** `npm test` (it includes `check-release.mjs`) — Expected: all pass.
- [ ] **Step 4: Commit** `npm test && git commit -m "chore(release): v0.21.0"`, push, then `git tag v0.21.0` on that commit and `git push origin v0.21.0`; `npm test` again on the tagged `HEAD` (the tag check) — Expected: all pass.
- [ ] **Step 5:** Add `Released as v0.21.0` to roadmap row 19; commit `docs(roadmap): iteration 19 released as v0.21.0`.
