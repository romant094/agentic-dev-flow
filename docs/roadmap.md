# Roadmap

One capability per iteration. Every iteration leaves the repository with green tests and a
working `/adf:init`. A capability is ported when its lessons file (`docs/lessons/`) accounts for
every rule of the origin project: ported, or rejected with a reason.

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
| 14 | Switch the origin project | `/adf:init` and `/adf:add` in the origin project; its changes move to the new schema | none |

Inputs kept in the origin project (local, not in this repository): the decomposition analysis
and the drafts of the contract and the Jira integration.
