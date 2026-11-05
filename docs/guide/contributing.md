<!-- sources:
- package.json
- scripts/*.mjs
- .claude-plugin/marketplace.json
- plugins/adf/.codex-plugin/plugin.json
-->

# Contributing

Issues and pull requests are welcome. Open an issue to report a defect or to propose a change. Run `npm test` before you open a pull request. Use [Conventional Commits](https://www.conventionalcommits.org/) for the commit messages.

Node 20 or later is required.

## Repository layout

```text
.claude-plugin/marketplace.json   the Claude Code marketplace: the core and every plugin
.agents/plugins/marketplace.json  the Codex marketplace
plugins/adf/                      the core
  .codex-plugin/plugin.json       the Codex manifest
  skills/                         the commands, one <name>/SKILL.md each
  agents/                         the capability-level subagents
  contract/                       the extension contract and its version
  schema/                         the artifact graph, the templates and the instructions
  schema/runtimes/                one file for each runtime: the flow's words mapped to its tools
  host/                           the templates of the files /adf:init adds to a project
  scripts/                        the command-line scripts, their library in lib/ and their tests
plugins/adf-gitlab/               the forge role for GitLab
plugins/adf-english-check/        a hook that blocks a commit with non-English text
plugins/adf-memory/               the wiki memory: the knowledge role
plugins/adf-npm-workspaces/       worktree provisioning for npm workspaces
plugins/adf-postgres/             a database for each worktree
plugins/adf-prisma/               the Prisma client, migrations and seed for each worktree
plugins/adf-jira/                 the tracker role for Jira Server and Data Center
plugins/adf-maintainer/           the upstream role on GitHub
scripts/                          the checks that npm test runs, and dev tools
test/fixtures/                    a host project and a plugin for end-to-end tests
docs/guide/                       this guide
```

The commands are in the Commands table of [the README](../../README.md#commands). In Codex they are the skills `adf:<name>`. See [the Codex page](getting-started/codex.md).

A plugin with hooks (`adf`, `adf-english-check`, `adf-npm-workspaces`) has its Codex manifest at `.codex-plugin/plugin.json`. Every other plugin has a `plugin.json` in its root. `scripts/manifests.mjs` generates these files from the manifests in `.claude-plugin/`. Do not edit them by hand.

For each plugin, see [Plugins](plugins/README.md).

## Tests

```bash
npm test
```

`npm test` runs these steps in order:

1. The unit and end-to-end specs, with `node --test`: `plugins/*/scripts/__tests__/*.spec.mjs` and `scripts/parity/__tests__/*.spec.mjs`. `test/env.mjs` removes the variables that select a runtime, so the specs run the same in both.
2. `scripts/check-lessons.mjs` checks the rule tables under `docs/`. Each cited file must exist and hold the cited phrase.
3. `scripts/check-release.mjs` checks the package version in `.claude-plugin/marketplace.json`. Each plugin's version must equal the one in its `plugin.json`. A release tag on `HEAD` must equal the package version. `CHANGELOG.md` must have a section for the package version. Every pinned tag in `README.md` and in the guide must equal `v<package version>`. The generated Codex manifests must match `scripts/manifests.mjs --check`.
4. `scripts/check-guide.mjs` checks this guide. Every command, plugin, extension point and registry key must appear in backticks on some page. Every file under `skills/`, `commands/`, `contract/` and `hooks/` must match a `sources:` entry of some page. Every `sources:` entry must match a file. Every link must resolve.

Each step must pass. A failing step ends the run.

## Rules for the guide

- Write in English.
- Write in Simplified Technical English: one idea in a sentence, at most 20 words in a step and 25 in a description.
- Use the active voice. Use one term for one concept.
- Start each page with a `sources:` comment that lists the files that the page describes. The comment is HTML on the first lines of the page, not front matter.
- Update the pages in the same commit as the flow change.
- Add an `## [Unreleased]` entry to `CHANGELOG.md` for the change.
