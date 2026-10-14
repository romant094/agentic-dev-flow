# Iteration 05 — Forge Plugin (GitLab) and English Check Plugin

## Goal

A change's merge request is opened through a plugin the core never names, and an agent's
commit is stopped when it carries non-English prose, with neither the origin's `mr.mjs` nor
its pre-commit hook. The rules and their reasons are in `docs/lessons/forge-gitlab.md`,
`docs/lessons/english-check.md` and the merge request and English rows of
`docs/lessons/propose.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | The plan symbol check: a bare filename not beside the first path falls back to the repository root (lessons G3) | `plan-symbols.spec.mjs`; parity reason `bare-root-fallback` |
| 2 | Contract `1.1`: the `forge` role (`check`, `open`, `finalize`), the calling convention (one JSON object in, one out, `state` done, degraded or refused), `hostFiles` | `registry.spec.mjs`, `roles.spec.mjs`; `plugins/adf/contract/README.md` |
| 3 | A registry entry names an installed plugin by id, resolved from Claude Code's install records for the main checkout; a role has one provider; `/adf:add` copies the host files a plugin declares | `extensions.spec.mjs` |
| 4 | `forge.mjs`: the core's call of the role; with no provider the state is `none` | `roles.spec.mjs` |
| 5 | `/adf:propose` opens the Draft merge request through the role after the artifact commit | the propose instruction and command |
| 6 | The GitLab plugin: `check`, `open`, `finalize`, the merge request template copied to `.gitlab/merge_request_templates/adf.md` | `plugins/gitlab/scripts/__tests__/forge.spec.mjs`; `scripts/parity/origin-mr.mjs` |
| 7 | The English check plugin: a Claude Code `PreToolUse` hook on `git commit` by any agent, its scope from the registry | `plugins/english-check/scripts/__tests__/`; `scripts/parity/origin-english.mjs` |

## Decisions

- The English check is one mechanism: a Claude Code hook in its own plugin. It sees every
  agent's commit, subagents included, without a host git hook or CI. It checks only when the
  plugin is installed; without it nothing is checked and nothing is said. A commit made by hand
  outside Claude Code is not checked. No contract point is needed: the merge request description
  becomes a file committed in the change before `finalize` (iteration 10), so the hook checks it.
- The hook runs before the command, so for `git add … && git commit` it also checks the changed
  and untracked files in scope, not only the index.
- A registry entry names an installed plugin by id. Claude Code records a project install once
  per checkout, worktrees included, so the id is resolved for the main checkout.
- The merge request targets the change's base. Nothing names `develop`.
- `finalize` with no merge request (propose was degraded and none was made by hand) pushes, then
  opens a ready merge request: GitLab cannot open one for a branch the remote lacks, and a ready
  merge request runs its own pipeline.
- A degraded `finalize` saves its input outside the repository and returns the command that
  re-runs it, so the merge with other changes' blocks still happens once `glab` works. The
  origin's fallback overwrote the whole description.
- With no forge plugin the core pushes nothing; push at apply is a forge operation added in
  iteration 07. Commits stay atomic: one task, one commit; a push only sends them.
- The quick task moves to the end of the roadmap (iteration 17).

## Result

- `npm test`: 249 tests, 0 failures; `check-lessons.mjs`: 244 rules, every one with a decision
  and evidence or a pending iteration; no row pending on iteration 05.
- `npm run parity -- <origin>`: all seven tools PASS.
  - `origin-plan-symbols.mjs`: 145 cases; explained differences `phase-without-value` (1) and
    `bare-root-fallback` (2).
  - `origin-mr.mjs`: 34 scenarios, every difference one of the recorded changes
    (`target-from-base`, `host-from-remote`, `degraded-finalize-rerun`, `branch-from-input`,
    `placeholder-in-marker`, `finalize-opens-missing`, `marker-adf`).
  - `origin-english.mjs`: 1,420 files of the origin, on the tree as it is and with one
    non-English line added to every file; 838 findings on each side, no difference.
- `claude plugin validate`: the marketplace and both new plugins pass.
- Not run: a smoke run of the hook in a temporary repository from this session (not permitted
  here); the hook's tests run it against real temporary repositories. Not run: `glab` against a
  real GitLab; the plugin's tests inject every git and `glab` call. Both are part of the live
  check, iteration 18.
- Fixed after the result: every script's entry guard compared `argv[1]` with the module path
  as written, so a script started through a symbolic link (or in another letter case on
  Windows and macOS) did nothing. `isMain` compares the system-resolved paths; a test starts a
  CLI through a link.
