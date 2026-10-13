# Roadmap

One capability per iteration. Every iteration leaves the repository with green tests and a
working `/adf:init`. A capability is ported when its lessons file (`docs/lessons/`) accounts for
every rule of the origin project: ported, or rejected with a reason.

## Checks after every iteration

1. `npm test`: the unit tests and `scripts/check-lessons.mjs`, which proves every rule of the
   origin is ported with evidence, rejected, or pending on a named iteration.
2. `npm run parity -- <origin project root>`: every parity tool in `scripts/parity/` runs the
   ported script and the origin's script (or the openspec CLI) on a copy of the origin
   project's data and reports every difference. A ported script gets its parity tool in the
   iteration that ports it. A difference is a defect unless the lessons file records it as a
   deliberate change.

The iteration record's `## Result` cites both.

## Iterations

The contract grows with the plugins. A new point is added in the iteration of the first plugin
that needs it, under the version rule in `plugins/adf/contract/README.md`.

| # | Iteration | Contents | Contract change |
|---|---|---|---|
| 01 | Skeleton | contract `1.0`, registry, `extensions.mjs`, `/adf:init`, `/adf:add`, `/adf:remove` | defines the format, no points |
| 02 | Superpowers gate | Superpowers as the core's dependency; the availability gate; `/adf:init` declares ADF in the host | none |
| 03 | Schema and change engine | the flow's own schema (artifact graph, instructions, templates) and the scripts that replace the openspec CLI: new change, list, status, instructions, spec validation; parity with openspec 1.5.0 on the origin's specs | none |
| 04 | Propose | the propose command and its artifacts | none |
| 05 | Forge plugin: GitLab | the `forge` role (`check`, `open`, `finalize`); `glab` presence and authentication check; the default merge request template | adds `forge` |
| 06 | Worktree plugin | the `workspace` role: one branch and one worktree per change | adds `workspace` |
| 07 | Apply | task groups, subagent dispatch, capability levels, the execution ledger | none |
| 08 | Verify | the verification checks | adds `verify-check` if a plugin needs it |
| 09 | Review | the review stage; the CI review reuses it | none |
| 10 | Archive and wiki memory | spec merge, memory ingest, technical debt ledger, log | none |
| 11 | Metrics and retrospective | `adf-metrics`, `adf-retro` | none |
| 12 | Project stack plugin (origin project) | worktree provisioning, per-worktree database, test runner, package map | adds the hooks it needs |
| 13 | Tracker plugin: Jira | gather context at propose, start, hand off to QA after merge, `/opsx:land` | adds `context-source`, `on-start`, `post-merge`, `forge.state` |
| 14 | Behaviour check | replay several archived changes of the origin, of different sizes, through the whole ported cycle in a sandbox copy of the origin at each change's base commit; compare the artifacts' structure, the branch, the ledger and the merge request with what the origin produced; strong differences are fixed before the switch | none |
| 15 | Switch the origin project | `/adf:init` and `/adf:add` in the origin project; its changes move to the new schema | none |

Inputs kept in the origin project (local, not in this repository): the decomposition analysis
and the drafts of the contract and the Jira integration.
