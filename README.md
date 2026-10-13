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
| Extension contract `1.0`, registry, `/adf:init`, `/adf:add`, `/adf:remove` | done (iteration 01) |
| Superpowers as a dependency, the availability gate | done (iteration 02) |
| The schema and the change engine (`new`, `list`, `status`, `instructions`, spec validation) in place of the openspec CLI | done (iteration 03) |
| The change cycle (propose, apply, verify, review, archive) | not ported |
| Ledger, metrics, retrospective | not ported |
| Wiki memory and technical debt | not ported |
| Plugins: forge (GitLab), worktree, tracker (Jira), project stack | not started |

The order is in `docs/roadmap.md`.

## Core and plugins

- **Core** (`plugins/adf/`): the change cycle and its gates, the review stage, the execution
  ledger, metrics and the retrospective, the wiki memory with its technical debt ledger, and
  the extension contract.
- **Plugins** (`plugins/<name>/`): each declares in `adf-extension.json` which contract points
  it provides. The contract, its points and its version rule are in
  `plugins/adf/contract/README.md`.

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
/adf:add <plugin path>
/adf:remove <plugin name>
```

## Layout

```
.claude-plugin/marketplace.json   the marketplace: the core and every plugin
plugins/adf/                      the core
  commands/                       /adf:init, /adf:add, /adf:remove
  contract/                       the extension contract and its version
  schema/                         the artifact graph (schema.json), templates, instructions
  scripts/                        extensions, superpowers, changes, specs, with their library and tests
scripts/parity/                   dev tools: compare the engine with the openspec CLI on a project
test/fixtures/                    a host project and a plugin for end-to-end tests
docs/roadmap.md                   the porting order
docs/lessons/                     the origin project's rules per capability, with reasons
docs/iterations/                  one plan per iteration
```

## Tests

```bash
npm test
```
