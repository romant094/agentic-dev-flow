# Iteration 03 — Schema and Change Engine

## Goal

The flow runs without the openspec CLI. The schema ships in the plugin, and the core's scripts
do what the flow used the CLI for, with the same results on the origin project's corpus. The
rules and their reasons are in `docs/lessons/schema-and-engine.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | The schema `adf`: `schema.json` (the graph of eight artifacts and the `apply` block), validated on load | `schema.spec.mjs` |
| 2 | The five templates that name no later phase, made project-independent | no origin path, command or tool name left |
| 3 | `changes.mjs`: `new`, `list`, `status`, `instructions <artifact\|apply>`, `schema` | `changes.spec.mjs` |
| 4 | `specs.mjs validate`: a port of openspec 1.5.0's spec and delta validation | `specs.spec.mjs` |
| 5 | Parity with openspec 1.5.0 on the origin project | `scripts/parity/openspec-status.mjs`, `scripts/parity/openspec-validate.mjs` |
| 6 | Every lessons row has a decision | `docs/lessons/schema-and-engine.md` |

## Decisions

- The schema is JSON for the graph and markdown for the prose, one file per block: the core
  stays standard-library only and each block is read and measured on its own.
- The host keeps the `openspec/specs/` and `openspec/changes/` layout, so the origin project's
  specs and changes need no move. A change's metadata is `.adf.json`.
- The project's guidance is `openspec/context.md` and `openspec/rules/<artifact>.md`.
- Instructions and the plan, verify and review templates arrive with their phases. Until then
  `instructions` returns `instruction: null` for an artifact without one.
- The validator keeps the CLI's quirks (see the open findings in the lessons file), so the
  origin's specs validate the same before and after the switch. Fixing a quirk is a change of
  its own.

## Result

- `npm test`: 70 tests, 0 failures; `check-lessons.mjs`: 50 rules, every one with a decision
  and evidence or a pending iteration.
- `npm run parity`: both tools PASS.
- `openspec-status.mjs` on the origin project, every change including the archived ones: 72
  compared, 0 differences in `status`, `instructions apply` and `list`; one change on the old
  `spec-driven` schema skipped.
- `openspec-validate.mjs` on the origin project: 70 specs and 73 changes plus 4,139 generated
  mutations and 25 hand-made changes, 4,306 items, default and strict mode: 0 differences. The
  one deliberate difference: the no-deltas message drops its tip naming an openspec command.
- Not ported: `openspec change validate` (the proposal's Why and What Changes checks), which
  the flow never ran.
