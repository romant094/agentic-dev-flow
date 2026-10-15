# Iteration 08a — Scripts First

## Goal

Every deterministic step of propose, apply and verify is done by a script. A script does its
work the same way every time; an LLM varies with its context. The LLM keeps the work that needs
reasoning: writing the artifacts and the code, choosing the groups, review, the judgement checks
and the talk with the developer. The audit of every step an LLM did is
`docs/iterations/08a-scripts-first-audit.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Audit iterations 01-08 for LLM steps a script can do: each with its place, the script that replaces it and what stays with the LLM | `08a-scripts-first-audit.md` |
| 2 | Shared scripts: `commit.mjs` (a commit of named paths only), `preflight.mjs` (a phase's preconditions in one call), `dispatch.mjs` (a dispatch's name, level, worktree, reply file and prompt; rounds and the breaker), `suite.mjs` (the whole suite, the base check, the test record), `plan.mjs` (lint, graph, schedule, unplanned, added) | `commit`, `preflight`, `dispatch`, `suite`, `plan` specs |
| 3 | Propose: artifact gates declared in `schema.json` and run by `changes.mjs next` and `done`; `propose.mjs create` and `commit`; capability and delta checks at propose; risk ids a plan cites; `forge.mjs` reads the branch and base itself and returns its report | `propose`, `changes`, `specs`, `plan`, `roles` specs |
| 4 | Apply: the Superpowers brief and package, `tdd-proof.mjs`, group merge and finish, `apply-status.mjs` and the handoff, the sweep's inputs and dispositions, `dup.mjs`, ticking with its commit | `sdd-skill`, `tdd-proof`, `group-finish`, `apply-status`, `dup-sweep`, `tasks` specs |
| 5 | Verify: `verify.mjs run --suite`, `prompts`, `skill-edit --diff-file`, `developer`, `verdict --report`, `assemble --commit`; the `verify c6` and `verify assemble` dispatches are gone | `verify`, `suite` specs |
| 6 | The commands and instructions call the scripts; the prompt skeletons are the one full statement of what an agent is told | `schema.spec`, `dispatch.spec`, `flow-regression.spec` |
| 7 | The English check sees every core script that commits, and the lines a skill-edit diff adds; a test fails when a committing script is missing from its list | `hook.spec`, `flow-regression.spec` |

## Decisions

- The principle is part of the roadmap: every iteration's plan lists the steps an LLM would do
  and moves each one a script can do.
- A committing script commits by path through one library and refuses the main checkout, a
  protected or detached branch, and anything else already staged.
- Blocking a group is the orchestrator's call; its reason goes into the handoff record, not into a
  ruling, which is the developer's.
- A branch name with no type prefix makes the merge request title explicit (`--title`).
- The telemetry database is deferred; nothing in this iteration writes outside the repository.

## Result

- `npm test`: 510 tests, 0 failures; `check-lessons.mjs`: ok.
- `npm run parity -- <origin>`: all ten tools PASS.
- Defects found and fixed on the way: a prompt sent an orchestrator rule to agents; the test-first
  skeleton told reviewers to overwrite files in the shared worktree; group fix rounds shared one
  name, so the metrics could not tell them apart; the dirty-file list lost its first character; a
  suite timeout left grandchild processes running; verify read the record's commit from any
  quoted text; commits made through the core's scripts passed the English check unchecked.
- Not run: the cycle end to end by an agent (iteration 14) and on real systems (iteration 18).
