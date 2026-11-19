# Iteration 23 — Init, update and install fixes

## Goal

Fix the defects that the switch of the origin project (iteration 15) and its first weeks found in
`/adf:init`, the install lookup, the session-start notice and the archive's log write: GitHub
issues #13, #12, #18, #14, #19, #24 and #33.

## Intent

Each defect makes the flow say something false or do something the developer did not ask for:
init offers no worktree copy, a refusal names a remedy that does not work from where it is shown,
the contract promises a warning that does not exist, the notice hides a release for a day, and
an archive session changes the developer's git configuration. The developer is not available for
this iteration; the designer's calls are recorded below.

## What exists (checked 2026-11-19, at 5328c4f)

- **#13.** `copyCandidates(root)` (`plugins/adf/scripts/lib/init.mjs:99-106`) runs
  `git ls-files --others --ignored` in `root`. Its comment says "in the main checkout", but
  `root` is the directory init runs in; a fresh worktree has no `.env`, so init offers nothing.
  `mainCheckout(root)` is in `plugins/adf/scripts/lib/installed.mjs:18`.
- **#12.** Iteration 16 fixed most of it (commit 4bf359a, `fix(adf): count an install for the
  worktree and a trusted project's cached plugin (#12)`): `selectInstall`
  (`plugins/adf/scripts/lib/installed.mjs:43`) counts a project or local record whose
  `projectPath` is the main checkout or the current root, falls back to the cache directory of a
  plugin the project settings enable with no record, and its refusal ends `run it from <main>`.
  Two parts are still open:
  - the Superpowers gate of Claude Code (`checkSuperpowers` and `isAvailable`,
    `plugins/adf/scripts/lib/superpowers.mjs:44-82`) counts records of the given root only,
    reads the settings of that root, and has no cache fallback. The issue's comment (option A)
    asked for the same fallback in `isAvailable`. From a change worktree a project install made
    in the main checkout does not count for `extensions.mjs init`, which passes its root;
  - the registry check's warning for an absent plugin (`registry.mjs:403`) names the install
    command but not where to run it.
  The official marketplace lists no `version` for `superpowers` (its source is a git URL with a
  `sha`), so `cachedInstall` finds no cache directory for it.
- **#18.** `selectInstall` counts `[main, root]` (`installed.mjs:47`); the design input of
  iteration 18 (`docs/iterations/18-documentation.md:184`) says a worktree install does not count;
  its `## Result` already records the difference (`:287`). At equal scope the records keep the
  order of `installed_plugins.json`, so a record for a worktree can win over the main checkout's.
- **#14.** Iteration 16 added the report, not a fix (commit c2a0916): `pluginRoot`
  (`plugins/adf/scripts/lib/plugin-root.mjs`) and `extensions.mjs where`, whose `warning` init and
  update show when the scripts run from outside the plugin cache.
- **#19.** `plugins/adf/contract/README.md:279-280` says an entry with no `points` "is named for no
  point, and the registry check still warns about it". `checkRegistry`
  (`plugins/adf/scripts/lib/registry.mjs:381-411`) warns only for a `not-installed` or `disabled`
  plugin. `docs/guide/concepts/registry.md` does not repeat the claim.
- **#24.** `cachedLatest` (`plugins/adf/scripts/update.mjs:110-128`) returns a cached tag younger
  than a day and asks the remote nothing.
- **#33.** The log write is `log` of `adf-memory` (`plugins/adf-memory/scripts/lib/memory.mjs:122`):
  the author is `git config user.name`, and the refusal says "set it, then log again". Neither the
  archive instruction nor `plugins/adf/schema/prompts/frame.md` forbids `git config`.

## Calls made by the designer, not the developer

- **#13.** Init looks for copy candidates in the main checkout (`mainCheckout(root)`, as
  `installed.mjs` does). The paths `## Worktree copies` already names are still read from the
  root, where init writes them.
- **#12 and #18, one rule.** A project or local install record counts when its project path is
  the main directory or the worktree where the command runs. That is the code since iteration 16,
  so for #18 the design input of iteration 18 is corrected, not the code. Reasons: the refusal's
  remedy, `run it from <main>`, works from every worktree; an install made in the worktree where
  the refusal is shown also works there, which is what the developer did in #12. Added:
  - At equal scope the main directory's record wins over a worktree's. The update reinstalls in
    the main directory, so a stale record for a worktree (one removed and made again at the same
    path) never hides the current install.
  - The Superpowers gate of Claude Code uses the same lookup as every other plugin
    (`selectInstall`): the main directory and the current worktree, the main directory's
    settings, the cache fallback for a plugin the project enables with no record. `isAvailable`
    goes.
  - The cache fallback takes the only version directory in the cache when the marketplace lists
    no version (as the Codex lookup already does), so it works for `superpowers`. With several
    versions and no listed one it finds none, and the refusal stands.
  - The registry check's warning names where to run the install, as the refusal does.
  - The guide (several projects, troubleshooting, switching) says to run the install from the
    main directory, also when the switch is made in a worktree, and that it rewrites the main
    directory's `.claude/settings.json`. User-facing text says "main directory", never the bare
    "main checkout".
- **#14.** Investigate only. The cause is fixed here only when it is in this repository's code.
- **#19.** The promise goes from `contract/README.md`; no warning is added. The guide does not
  repeat it.
- **#24.** When the cached latest tag equals the project's pinned `ref`, the notice asks the
  remote again; otherwise the daily cache stands, so an offline machine still asks once a day.
  A user-scope install keeps the daily cache.
- **#33.** The log write takes the author from `git var GIT_AUTHOR_IDENT` (which honours
  `user.name` and `GIT_AUTHOR_NAME`), else from the name of the last commit, and refuses only when
  neither gives one. The refusal names the fix for the developer. The archive instruction and
  `frame.md` say the flow never runs `git config` to set a value.

## Non-goals

- `/adf:add adf-postgres` checking at add time that its `url.file` is in `## Worktree copies`
  (the optional part of #13).
- Choosing among several cached Superpowers versions with no listed version.
- A warning for a registry entry with no `points`.
- A shorter notice cache for a user-scope install.
- Any change to Claude Code's own state on this machine; the tests use fixtures.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | #13: copy candidates from the main checkout | `init.spec.mjs`: a worktree gets the main checkout's ignored `.env` |
| 2 | #12, #18: the main directory's record wins at equal scope; the Superpowers gate through `selectInstall`; the only cached version; the registry warning names the main directory; the guide and the iteration 18 input corrected | `installed.spec.mjs`, `superpowers.spec.mjs`, `registry.spec.mjs` |
| 3 | #14: look for the cause in this repository's code; record what was checked | the record's `## Result` |
| 4 | #19: the contract README's claim removed | `check-guide.mjs` |
| 5 | #24: the notice asks again when the cached tag equals the pinned ref | `update-cli.spec.mjs` |
| 6 | #33: the log author from `git var GIT_AUTHOR_IDENT` or the last commit; the `git config` rule in the archive instruction and `frame.md` | `adf-memory` `memory.spec.mjs` |
| 7 | `## Result` with the checks run | `npm test` |
