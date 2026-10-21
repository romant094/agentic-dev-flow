# Roadmap

One capability per iteration. Every iteration leaves the repository with green tests and a
working `/adf:init`. A capability is ported when its lessons file (`docs/lessons/`) accounts for
every rule of the origin project: ported, or rejected with a reason.

Every deterministic step is a script: a script does its work the same way every time, and an LLM
varies with its context. The LLM keeps the work that needs reasoning: writing the artifacts and
the code, planning and grouping, review, the judgement checks and the talk with the developer.
Every iteration's plan lists the steps an LLM would do, and moves each one a script can do.

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
| 04 | Propose | the propose command and its artifacts; one branch and one worktree per change, from the integration branch or the current one; the branch policy (integration and protected branches) and the planning guide set up by `/adf:init`; the plan symbol check; the execution ledger | none |
| 05 | Forge plugin: GitLab; English check plugin | first, the plan symbol check falls back to the repository root for a bare filename that is not beside the first path (lessons G3). A registry entry names an installed plugin by id, resolved from Claude Code's install records for the main checkout; a plugin may declare host files `/adf:add` copies. The `forge` role (`check`, `open`, `finalize`) and the GitLab plugin: `glab` presence and authentication, the Draft at propose, the default merge request template. The English check plugin: a Claude Code `PreToolUse` hook on `git commit` by any agent, its scope set in the registry | contract 1.1: adds the `forge` role |
| 06 | (folded into 04 and 10) | the worktree is part of the core: made at propose (04), merged and removed at archive (10) | none |
| 07 | Apply | task groups, subagent dispatch, capability levels, the execution ledger | none |
| 08 | Verify | the verification checks | adds `verify-check` if a plugin needs it |
| 08a | Scripts first | every deterministic step of propose, apply and verify moves from the instruction text to a script; the LLM keeps the reasoning work (artifacts, code, grouping, review, judgement, the talk with the developer) | none |
| 09 | Review | the review stage: the reviewer and the fixer reply in JSON under a schema the core owns, checked by script; the verdict computed by script from the findings; the fix plan, the dispositions, the markers and the record by script; `review.mjs input`, `response` and `render` run standalone on a `--range`. No CI runner: the developer rebuilds the CI review from the plugin's scripts, outside the port | none |
| 10 | Archive and wiki memory | spec merge, memory ingest, technical debt ledger, log; the worktree removed; with no forge plugin, archive offers to merge the change into its base branch and merges only on the developer's yes; on a no the developer merges it; ADF debt kept as a local debt record; archive resumes from a failed step | 1.3: adds the `knowledge` role, provided by the new `adf-memory` plugin |
| 10b | Maintainer plugin | `adf-maintainer`, installed by the maintainer only, provides the `upstream` role (contract 1.5): the retrospective's `file` step, before render, sends it a retrospective's flow findings and the ADF debt not yet filed, and it files them as issues in the plugin's GitHub repository through `gh api`, after a check of push permission and the developer's yes to the core's hold; it stores no token, a marker in each issue body makes `file` safe to rerun, and every other host has no provider and skips the step; it has no command of its own named retro, since `/adf:retro` is the core's | 1.5: the `upstream` operations take content; registry entries record their points |
| 10a | Structured replies | every other agent role replies in JSON, checked by script: the implementer, the task reviewer and the verify dispatches; the metrics then read JSON | none |
| 11 | Metrics and retrospective | in the core: archive writes one checked metrics record per change (`contract/metrics-format.md`) from the SDD records, git and the session transcripts, tokens only, after the ingest is committed and in its own commit; a dated price table in `.adf/prices/`; `/adf:retro` over a window, one change or a period: every number, the delta and the candidates by script, one agent's JSON reply checked by script, the report committed in `.adf/retro/` on `chore/retro/<id>` with a non-draft merge request and no CI run; the retrospective writes no debt | 1.4: the forge operations `open`, `push` and `finalize` take `ci`; adds the `upstream` role |
| 12 | Project stack plugin (origin project) | worktree provisioning, per-worktree database, test runner, package map | adds the hooks it needs |
| 13 | Tracker plugin: Jira | gather context at propose and at a quick task, start, hand off to QA after merge, `/opsx:land` | adds `context-source`, `on-start`, `post-merge`, `forge.state` |
| 14 | Behaviour check | replay several archived changes of the origin, of different sizes, through the whole ported cycle in a sandbox copy of the origin at each change's base commit; compare the artifacts' structure, the branch, the ledger and the merge request with what the origin produced; strong differences are fixed before the switch | none |
| 15 | Switch the origin project | `/adf:init` and `/adf:add` in the origin project; its changes move to the new schema | none |
| 16 | Update | `/adf:update`: after a new version of the core or a plugin is published from its own repository, bring a host up to date: update the installed plugins, migrate the registry and the host files `/adf:init` wrote, and report what changed | none |
| 17 | Quick task | `/adf:quick`: a small fix or feature without the full artifact set, after the model of `/gsd:quick` in `open-gsd/gsd-core` (studied first). Its own branch and worktree from the base; a short plan and a summary as the change's only artifacts; atomic commits; optional steps by flag (discuss, research, verify); the merge request through the forge plugin or the local merge into the base; the same gates as propose; its own behaviour check, since iteration 14 runs before it | none |
| 18 | Live check | after the switch and the quick task, on real systems: the whole cycle from `/adf:propose` in the switched origin project; the English check hook in a scratch repository (a blocked and a clean commit, from the main agent and a subagent); the GitLab plugin against a test GitLab project (Draft at propose, push at apply, `finalize` at archive, the degraded paths with `glab` missing and logged out); on macOS, Linux and Windows | none |

Inputs kept in the origin project (local, not in this repository): the decomposition analysis
and the drafts of the contract and the Jira integration.
