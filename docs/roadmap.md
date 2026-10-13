# Roadmap

One capability per iteration. Every iteration leaves the repository with green tests and a
working `/adf:init`. A capability is ported when its lessons file (`docs/lessons/`) accounts for
every rule of the origin project: ported, or rejected with a reason.

The contract grows with the plugins. A new point is added in the iteration of the first plugin
that needs it, under the version rule in `plugins/adf/contract/README.md`.

| # | Iteration | Contents | Contract change |
|---|---|---|---|
| 01 | Skeleton | contract `1.0`, registry, `extensions.mjs`, `/adf:init`, `/adf:add`, `/adf:remove` | defines the format, no points |
| 02 | Gate and schema install | the Superpowers availability gate; `/adf:init` installs the openspec schema into the host (openspec reads a schema only from the project, the user data directory or its own package) | none |
| 03 | Propose | the propose command and its artifacts | none |
| 04 | Forge plugin: GitLab | the `forge` role (`check`, `open`, `finalize`); `glab` presence and authentication check; the default merge request template | adds `forge` |
| 05 | Worktree plugin | the `workspace` role: one branch and one worktree per change | adds `workspace` |
| 06 | Apply | task groups, subagent dispatch, capability levels, the execution ledger | none |
| 07 | Verify | the verification checks | adds `verify-check` if a plugin needs it |
| 08 | Review | the review stage; the CI review reuses it | none |
| 09 | Archive and wiki memory | spec merge, memory ingest, technical debt ledger, log | none |
| 10 | Metrics and retrospective | `adf-metrics`, `adf-retro` | none |
| 11 | Project stack plugin (origin project) | worktree provisioning, per-worktree database, test runner, package map | adds the hooks it needs |
| 12 | Tracker plugin: Jira | gather context at propose, start, hand off to QA after merge, `/opsx:land` | adds `context-source`, `on-start`, `post-merge`, `forge.state` |
| 13 | Switch the origin project | `/adf:init` and `/adf:add` in the origin project | none |

Inputs kept in the origin project (local, not in this repository): the decomposition analysis
and the drafts of the contract and the Jira integration.
