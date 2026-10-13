# Iteration 02 — Superpowers Gate

## Goal

Superpowers arrives with the core and its absence stops the flow, never degrades it. The
rules and their reasons are in `docs/lessons/superpowers-gate.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Check plugin dependencies, settings precedence and plugin variables against the Claude Code documentation | facts recorded in the lessons file |
| 2 | Declare Superpowers in the core's `dependencies`; allow `claude-plugins-official` in the marketplace | `claude plugin validate .` passes |
| 3 | The gate `superpowers.mjs`: JSON output; settings user, project, local; a project-scope record counts only for its own project; `CLAUDE_CONFIG_DIR` | `superpowers.spec.mjs` |
| 4 | `/adf:init` declares ADF and its marketplace in the host's `.claude/settings.json` and runs the gate | `host-settings.spec.mjs`, `extensions.spec.mjs` |
| 5 | Every lessons row has a decision | `docs/lessons/superpowers-gate.md` |

## Decisions

- The host declares ADF, not Superpowers. Installing ADF installs and enables Superpowers as
  its dependency.
- No version range on the dependency: the gate checks presence only.
- `/adf:init` reports a missing Superpowers and continues; the commands that invoke a skill
  stop on it. Each gets the gate as step 1 when it is ported.

## Result

`npm test`: 30 tests, 0 failures. `claude plugin validate .`: passed.

Parity, added after the iteration closed: `scripts/parity/origin-superpowers.mjs` compares the
gate with the origin's on 243 generated cases and on this machine's real state for the origin
and each of its worktrees. Every difference disappears when one of the two deliberate changes
is undone (the local settings layer; a record of another project), and none is unexplained.
