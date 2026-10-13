# Iteration 01 — Skeleton

## Goal

A core plugin that installs into a project and enables or disables other plugins through a
versioned contract. No flow capability yet.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Branch `feat/plugin-core` from `main` | `git branch --show-current` |
| 2 | Remove the monolithic flow from the branch; keep `LICENSE` and `.gitignore` | `git ls-files` |
| 3 | The marketplace and the core plugin manifest | `.claude-plugin/marketplace.json`, `plugins/adf/.claude-plugin/plugin.json` |
| 4 | The contract `1.0`: format, version rule, no points | `plugins/adf/contract/` |
| 5 | `extensions.mjs`: `init`, `add`, `remove`, `check` | unit tests in `plugins/adf/scripts/__tests__/registry.spec.mjs` |
| 6 | `/adf:init`, `/adf:add`, `/adf:remove` | end-to-end test on `test/fixtures/` in `extensions.spec.mjs` |
| 7 | Roadmap, lessons template, this plan | `docs/` |

## Decisions

- A registry entry stores a plugin `path`. Resolving a plugin installed from a marketplace,
  whose cache path changes with its version, is decided when the first real plugin is
  installed that way (iteration 04).
- The core's scripts use Node's standard library only, so a host project needs no dependency.
- Plain `node:test`; Node 20 or later.

## Result

`npm test`: 17 tests, 0 failures.
