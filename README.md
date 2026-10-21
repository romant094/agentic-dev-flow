# Agentic Dev Flow

A spec-driven change workflow for agent-executed development, built as a **core** that
**plugins** extend. The core holds the flow's own paradigms; a plugin adds an integration with
an outside system (a forge, a tracker) or a project add-on (a project's stack). A project
enables only the plugins it needs.

This branch rebuilds the flow plugin-first. The previous, monolithic flow stays on `main` for
reference. Capabilities are ported one per iteration, and each port carries the rules the
origin project learned the hard way, with their reasons (`docs/lessons/`).

## Status

| Part | State |
|---|---|
| Extension contract, registry, `/adf:init`, `/adf:add`, `/adf:remove` | done (iteration 01) |
| Superpowers as a dependency, the availability gate | done (iteration 02) |
| The schema and the change engine (`new`, `list`, `status`, `instructions`, spec validation) in place of the openspec CLI | done (iteration 03) |
| Propose: one branch and worktree per change, the branch policy, the planning guide, the artifact instructions, the plan symbol check, the execution ledger | done (iteration 04) |
| Contract `1.1`: the `forge` role, plugins named by their installed id, host files a plugin declares; the GitLab forge plugin; the English check plugin | done (iteration 05) |
| Apply: one orchestrator, task groups in parallel worktrees, the capability-level agents, the dispatch guard, reply checks, push through the forge | done (iteration 07) |
| Verify: the mechanical checks and the verdict by script, read-only judgement dispatches, developer rulings, the base check as a workspace operation | done (iteration 08) |
| Scripts first: every deterministic step of propose, apply and verify is a script; the LLM keeps the reasoning work | done (iteration 08a) |
| Review: the reviewer and the fixer reply in JSON, the verdict, the rounds, the dispositions, the markers and the record by script; `input`, `response` and `render` run standalone for a CI job | done (iteration 09) |
| Archive: `/adf:archive`, resumable; the spec merge, the placements, the ingest, the merge request or a local merge and the worktree removal by script; the LLM keeps the conflicts, a new capability's Purpose, the ingest and the merge request's prose | done (iteration 10) |
| Structured replies: every apply and verify role replies in JSON under a schema the core owns; the statuses, the test result and every verdict computed by script; one retry mechanism for every role | done (iteration 10a) |
| Metrics and the retrospective: one checked metrics record per change, written by archive from the SDD records, git and the session transcripts, tokens only and priced by a dated price table; `/adf:retro` over a window, one change or a period, every number by script, one agent's JSON reply checked by script, committed in `.adf/retro/` on its own branch with a non-draft merge request and no CI run; contract `1.4`: the forge's `ci` and the `upstream` role | done (iteration 11) |
| Wiki memory and technical debt: the `adf-memory` plugin (the `knowledge` role, contract `1.3`) and the core's debt store | done (iteration 10) |
| Maintainer upstream: the `adf-maintainer` plugin (the `upstream` role, contract `1.5`) files a retrospective's flow findings and the ADF debt not yet filed as GitHub issues through `gh`; every extension is optional, and a registry entry whose plugin is not installed is skipped | done (iteration 10b) |
| Project stack: the core provisions every worktree it makes through the `provision` and `teardown` hooks and runs extension checks at verify (contract `1.6`); the plugins `adf-npm-workspaces`, `adf-postgres` and `adf-prisma` | done (iteration 12) |
| Tracker: the `tracker` role and the `forge` operation `state` (contract `1.7`); propose gathers the scope from a key or a phrase (the tracker and the debt store), checks each taken issue by a read-only agent and starts the taken ones; `/adf:land` hands them to the tester after the merge; the plugin `adf-jira` | done (iteration 13) |
| `/adf:quick`, a small fix or feature without the full artifact set | not started |
| `/adf:update` | not started |

The order is in `docs/roadmap.md`.

## Core and plugins

- **Core** (`plugins/adf/`): the change cycle and its gates, the review stage, the execution
  ledger, metrics and the retrospective, the wiki memory with its technical debt ledger, and
  the extension contract.
- **Plugins** (`plugins/<name>/`): each declares in `adf-extension.json` which contract points
  it provides. The contract, its points and its version rule are in
  `plugins/adf/contract/README.md`.
- **Triggers**, in every plugin: each trigger phrase of a skill or a command is written in
  English, and its frontmatter `description` carries the note "Triggers may be phrased in any
  language." (`plugins/adf/scripts/__tests__/triggers.spec.mjs` checks every file).

## Install

This repository is a Claude Code marketplace:

```
/plugin marketplace add <path or git URL of this repository>
/plugin install adf@agentic-dev-flow
```

Installing `adf` also installs and enables its dependency, Superpowers
(`superpowers@claude-plugins-official`). Node 20 or later is the only other prerequisite; the
openspec CLI is not needed.

Then, in the host project:

```
/adf:init
/adf:propose <change>
/adf:apply [change]
/adf:verify [change]
/adf:review [change]
/adf:archive [change]
/adf:land <change>
/adf:retro [--change <name> | --from <date> --to <date>]
/adf:add <plugin id or path>
/adf:remove <plugin name>
```

A plugin is installed for the project, then enabled by its id. For example, GitLab merge
requests, the wiki memory and the English check:

```
claude plugin install adf-gitlab@agentic-dev-flow --scope project
/adf:add adf-gitlab@agentic-dev-flow
claude plugin install adf-memory@agentic-dev-flow --scope project
/adf:add adf-memory@agentic-dev-flow
claude plugin install adf-english-check@agentic-dev-flow --scope project
```

The English check works as soon as it is installed: it is a Claude Code hook on every agent's
`git commit`. `/adf:add adf-english-check@agentic-dev-flow '{"include":[...]}'` only changes its
scope (`plugins/adf-english-check/README.md`).

A project on npm workspaces, PostgreSQL or Prisma provisions every worktree the flow makes
with the stack plugins, enabled in this order, each with its project values in `config`:

```
/adf:add adf-npm-workspaces@agentic-dev-flow '{"build":["npm run build:shared"]}'
/adf:add adf-postgres@agentic-dev-flow '{"prefix":"app","url":{"file":".env","key":"DATABASE_URL"},"exec":{"docker":"db"}}'
/adf:add adf-prisma@agentic-dev-flow
```

Each is installed first, like the plugins above. The planning guide names the files every
worktree gets a copy of (`## Worktree copies`), and a plan that needs a database says so
(`**Needs:** database`).

A project on Jira enables the tracker with its non-secret values in `config`, then sets up its
profile once:

```
/adf:add adf-jira@agentic-dev-flow '{"baseUrl":"https://jira.example.com","allowlist":["PROJ"],"statuses":{"start":"In Progress","handoff":"Review"}}'
/adf-jira:setup
```

The token and the personal logins go in the env file, never in the registry
(`plugins/adf-jira/README.md`, `plugins/adf-jira/env.example`). After a change is merged,
`/adf:land <change>` writes one comment per taken issue and hands it to the tester.

Only the flow's maintainer installs `adf-maintainer@agentic-dev-flow`: it files the
retrospective's findings and the ADF debt upstream (`plugins/adf-maintainer/README.md`). Every
other host has no `upstream` provider, and the retrospective skips the step.

## Host files

`/adf:init` writes the registry, `.claude/adf-extensions.json` (its keys are in
`plugins/adf/contract/README.md`), and `.gitignore` lines for the flow's local state
(`.claude/worktrees/`, `.superpowers/`, `docs/superpowers/`, `.adf/*`). The core's committed
directories in the host are in `.adf/`: the dated price table in `.adf/prices/` and the
retrospectives in `.adf/retro/`, which `.gitignore` re-includes. The rest of `.adf/` is the
extension plugins' local work directory, ignored: a directory per plugin, for example the plans
of `adf-jira` in `.adf/jira/<skill>/`.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: the core and every plugin
plugins/adf/                      the core
  commands/                       /adf:init, /adf:add, /adf:remove, /adf:propose, /adf:apply, /adf:verify, /adf:review, /adf:archive, /adf:land, /adf:retro
  agents/                         the capability-level subagents apply, verify, review and archive dispatch
  contract/                       the extension contract and its version
  schema/                         the artifact graph (schema.json), templates, instructions
  host/                           templates of files /adf:init adds to the host (planning guide)
  scripts/                        extensions, superpowers, workspace, changes, specs,
                                  plan-symbols, ledger, forge, reply, sdd, tasks, guard, with
                                  their library and tests
plugins/adf-gitlab/               the forge role for GitLab, through glab; the merge request template
plugins/adf-english-check/        a PreToolUse hook that blocks a commit with non-English text
plugins/adf-memory/               the wiki memory: the knowledge role, its log and its workflows
plugins/adf-npm-workspaces/       provision: a worktree's own node_modules; a guard against npm install in a worktree
plugins/adf-postgres/             provision and teardown: a database per worktree
plugins/adf-prisma/               provision: an own client, migrations and seed; verify-check: migration order
plugins/adf-jira/                 the tracker role on Jira Server and Data Center; guarded two-phase Jira skills
plugins/adf-maintainer/           the upstream role on GitHub, through gh: the maintainer's only
scripts/parity/                   dev tools: compare the ported scripts with the origin's and the
                                  openspec CLI on the origin project (npm run parity -- <root>)
test/fixtures/                    a host project and a plugin for end-to-end tests
docs/roadmap.md                   the porting order
docs/lessons/                     the origin project's rules per capability, with reasons
docs/iterations/                  one plan per iteration
```

## Tests

```bash
npm test
```
