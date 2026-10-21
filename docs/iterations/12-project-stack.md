# Iteration 12 — Project stack plugins

## Goal

Every worktree the core makes is provisioned for the host's stack. The core calls hooks; three
published plugins carry the stack knowledge; the host carries its own values in the registry
`config` and the planning guide. A worktree then builds, tests and migrates against its own
branch, never against the main checkout's dependencies, generated client or database.

Today the core makes four kinds of worktree (change, group, base-check, proof) and provisions
none. All four live under `<main>/.claude/worktrees/`, so Node resolves modules upward into the
main checkout's `node_modules`: the tests run, but against the main checkout's Prisma client and
build output. Outside the main checkout the same tree cannot run its tests at all (measured on
2026-10-21: a clone of the origin with no `node_modules` and no `node_modules/.bin` on `PATH`,
`npm test` exits 127, `turbo: command not found`).

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Hook caller: `callHook(point, input)` in `lib/roles.mjs` calls every provider of a hook point in registry order, each with its own `config`; a provider absent or disabled is skipped and named, as for roles; `refused` from one provider stops the remaining ones and the step | `roles.spec.mjs` with fixture plugins |
| 2 | Contract 1.6: hooks `provision`, `teardown`, `verify-check` (inputs and outputs below); the contract README says that a registry `path` entry carries no Claude Code hooks | `contract.spec.mjs`, `manifest.spec.mjs` |
| 3 | `workspace.mjs provision --worktree <path> [--need <word>]`: copy the files the guide's `## Worktree copies` names from the main checkout, never through a link, then call `provision`; before and after, compare `git status --porcelain` of the worktree and of the main checkout, and refuse on any difference; print each provider's `notes`; re-runnable | `workspace.spec.mjs`: a provider that writes a tracked path is refused; a second run changes nothing |
| 4 | Provision all four kinds: the change worktree at apply after preflight; `group-add`; `base-check-add`; the proof tree after `worktree add` and again after the checkout to the commit. `needs` is passed to change and group worktrees only | `groups.spec.mjs`, `tdd-proof.spec.mjs`, `apply.spec.mjs` |
| 5 | `teardown` before every `git worktree remove` the core runs (archive, `group-remove`, `base-check-remove`, the proof cleanup), with `branch` in the input; a `refused` teardown stops the removal and is reported | `workspace.spec.mjs`, `groups.spec.mjs` |
| 6 | Plan line `**Needs:** <words>` at plan level, parsed by `lib/plan.mjs`, passed as `needs`; plan lint warns on an unknown word only when no provider is installed | `plan.spec.mjs` |
| 7 | Guide section `## Fresh-run proof`: a line the whole-suite output must contain; `suite.mjs` fails a run whose output lacks it, with the reason "the run may be cached" | `suite.mjs` specs |
| 8 | `verify.mjs run` calls `verify-check` and renders one section per returned check, id `ext:<plugin>:<id>`, rulable like the core's checks except `tree` and `worktrees` | `verify.spec.mjs` |
| 9 | Commits stay hook-neutral: the core runs a plain `git commit`, sets no hook variable and passes no `--no-verify`; it reports the committed files from the commit itself; a hook that refuses stops the step with the hook's output | `commit.spec.mjs` with a fixture `pre-commit` that rewrites a staged file, and one that exits 1 |
| 10 | Plugin `plugins/adf-npm-workspaces/`: `provision` gives the worktree a real `node_modules` whose third-party entries link into the main checkout's; every workspace self-link (a link resolving inside the repository and outside every `node_modules`) is recreated as the same relative link inside the worktree, and a directory holding one is made real; the `.bin` directory is present; caches in `config.unshared` (default `.vite`, `.vite-temp`) are left out; it never writes through a link; then it runs `config.build`. A Claude Code `PreToolUse` hook blocks `npm install`, `i`, `ci`, `add`, `update` and `uninstall` in a linked worktree of the host. README states the install rule once | specs on a fixture monorepo with a scoped self-link: the main checkout byte-identical after provisioning; the guard on a linked worktree and on the main checkout |
| 11 | Plugin `plugins/adf-postgres/`: `provision` creates `<config.prefix>_<branch slug>` (the origin's slug, hash and 63-byte rule) when `needs` names `database`, and rewrites `config.url.key` in the worktree's copy of `config.url.file`; `teardown` drops it; `config.exec` is `{ "docker": <container> }` or `"local"`; the password never in argv; Docker unavailable is `degraded`; an existing database still gets its URL; a drop on a stopped server is `done` with a note | specs with a fake `run`; name parity with the origin's `worktree-db.mjs` |
| 12 | Plugin `plugins/adf-prisma/`: `provision` replaces the shared `.prisma` and `@prisma/client` links with copies when `files` touch `config.ownClientWhen` (default the schema directory, `package.json`, the lockfile) and runs `generate`; when the worktree has a database (the URL the `adf-postgres` plugin wrote), runs `migrate deploy` and `db seed`; the CLI version is derived from the host's `@prisma/client`, `config.cli` overrides. `verify-check` `migration-order`: a branch migration that sorts before one the base gained fails; a missing base ref fails; it never fetches and never rewrites | specs; verdict parity with the origin's `check-migration-order.mjs` |
| 13 | Lessons rows pending on 12 resolved; the xnms host values written as iteration 15 inputs (registry `config`, `## Worktree copies`, `## Fresh-run proof`, `**Needs:**` guidance, `npm test -- --force`); product debt recorded for the `file:` dependencies and the relative `envFilePath` | `check-lessons.mjs` |
| 14 | Versions adf 0.13.0, contract 1.6, adf-npm-workspaces 0.1.0, adf-postgres 0.1.0, adf-prisma 0.1.0; marketplace; roadmap; READMEs | `npm test`, `npm run parity -- <origin>`, `claude plugin validate .` |

## Contract 1.6

| Point | Kind | Input | Output (`done`) |
|---|---|---|---|
| `provision` | hook | `{ worktree, main, kind: "change" \| "group" \| "base-check" \| "proof", change, branch \| null, base: { ref, commit }, files, needs }` | `{ actions: [{ op, path }], notes: [text] }`; `degraded` with `hint` when its tool is missing; `refused` stops the step |
| `teardown` | hook | `{ worktree, main, kind, change, branch }` | `{ actions, notes }`; nothing to do is `done` |
| `verify-check` | hook | `{ change, base: { ref, commit }, head, files }` | `{ checks: [{ id, title, verdict: "pass" \| "warn" \| "fail" \| "not-run", summary, text }] }` |

Registry order for xnms: `adf-npm-workspaces`, `adf-postgres`, `adf-prisma`. The client must exist before
`generate`, and the database before `migrate deploy`.

## Decisions

Settled by the developer on 2026-10-21. Analysis: the boundary analysis of 2026-10-20 (core,
ADF plugins, project).

- D1 Three published plugins: `adf-npm-workspaces`, `adf-postgres`, `adf-prisma`. Each is reused alone, and
  every project fact is in its `config`.
- D2 The package map stays in the guide's `## Packages`.
- D3 No scoped test runs: the whole suite and the base check.
- D4 The turbo `file:` edge is moot under D3; replacing the `file:` dependencies is product debt.
- D5 A database is made when the plan says `**Needs:** database`; `provision --need database`
  makes it on demand.
- D6 All four kinds get dependencies; change and group worktrees get a database.
- D7 Each group worktree has its own database, named from its group branch.
- D8 Serving a worktree for a hardware pass is a project script the guide names.
- D9 No `LEFTHOOK=0`. The core knows no hook tool (lefthook, husky, lint-staged, Biome,
  ESLint): it commits plainly and reads the result from the commit. A hook finds its programs
  through the worktree's own `node_modules/.bin`, which `adf-npm-workspaces` provides.
- D10 The migration order is checked by `adf-prisma` through `verify-check`.
- D11 The install ban: `adf-npm-workspaces` README, `notes` and the `PreToolUse` guard. "A
  dependency update is its own change" stays in the core.
- D12 The env file copy: the guide's `## Worktree copies`, done by the core; `adf-postgres`
  rewrites its URL.
- D13 The Prisma CLI version is derived from `@prisma/client`.
- D14 One general rule, "never write through a link", replaces the origin's list of retired
  links.
- D15 Fresh-run proof: a guide section the suite output must contain.
- D16 One verify section per `verify-check` check.
- D17 No project-local extension in this iteration.
- D18 Every published plugin but the core carries the prefix `adf-`. Claude Code namespaces a
  plugin's commands and skills by its name alone, without the marketplace, so a bare `gitlab`
  or `prisma` could collide with another marketplace's plugin. `gitlab`, `memory` and
  `english-check` were renamed before this iteration, while no host registry named them.

Measured while deciding:

- `npm test` in xnms needs no `.env`: no spec opens Prisma or Redis, and jest and vitest map
  `@barox-nms/shared` to its sources, not to `dist`. A stale shared build breaks the dev server
  and the build, not the tests. A stale Prisma client breaks the tests.
- The origin's group worktrees ran tests unprovisioned because they live inside the main
  checkout.
- The origin's lefthook launcher finds `lefthook` on the developer's `PATH`, so the hook ran
  Biome in unprovisioned worktrees; the origin's "silently does nothing" holds only without it.

## Result

- `npm test`: 1051 tests, 1049 pass, 0 failures, 2 skipped (the live openspec parity with
  `OPENSPEC_DIST` not set, and the live origin name parity of `adf-postgres` with
  `ADF_ORIGIN` not set); `check-lessons.mjs`: ok, 770 rows, 24 pending, none on 12.
- `npm run parity -- <origin>`: 21 of 21 PASS, after two fixes the origin's new data exposed
  (its `develop` gained seven commits since the analysis). `plannedPaths` dropped a Files path
  with no slash and no known extension (`Dockerfile`, `./.env.example`), so verify would have
  reported it out of plan; fixed in the core. `origin-verify-history` reads the origin's newer
  task count forms, and `origin-log` explains two entries a merge interleaved.
- `claude plugin validate .`: passed.
- A test provisions a fixture npm-workspaces host through the core and the three real plugins:
  the change and base-check worktrees, a re-run, teardown and the migration-order check. No
  test runs npm install, Docker, psql or npx.
- Measured on 2026-10-21: in xnms the unit suite needs no `.env` and builds `@barox-nms/shared`
  from its sources; a stale Prisma client is what an unprovisioned worktree breaks.
- Not run: a live provision against xnms (iteration 15 writes its registry and guide values),
  a real database create and drop, a real `prisma generate`.
- Closed with no new code: "re-run the suite after a fix that touches a `## Packages`
  directory" (analysis 4h). The script's covering record, the whole suite at apply's end, the
  stale-record check at verify and the review re-run already hold it (`docs/lessons/apply.md`,
  open findings); a run after each such fix was rejected by the developer on 2026-10-21 as a
  whole-suite run per fix for an earlier signal only.
- Versions: adf 0.13.0, contract 1.6; adf-npm-workspaces, adf-postgres and adf-prisma 0.1.0;
  renamed before the iteration: adf-gitlab 0.4.0, adf-memory 0.2.0, adf-english-check 0.6.0;
  adf-maintainer 0.1.0 unchanged.
