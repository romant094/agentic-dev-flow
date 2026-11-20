<!-- sources:
- plugins/adf/scripts/lib/installed.mjs
- plugins/adf/scripts/lib/runtime.mjs
- plugins/adf/scripts/lib/update.mjs
- plugins/adf/scripts/lib/superpowers.mjs
-->

# Several projects on one machine

Several projects can use the flow on one machine, each on its own release. This page says what is shared and what is not. Claude Code and Codex install plugins in different ways, so each has its own section. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## Claude Code

### What belongs to a project

Each project declares the marketplace and enables the plugins in its own `.claude/settings.json`, and the project commits that file. The registry, `.claude/adf-extensions.json`, and the planning guide, `openspec/planning.md`, are also the project's own.

A plugin acts only in the sessions of a project that enables it. A hook of `adf-english-check` or `adf-npm-workspaces` does nothing in a project without an entry in its registry.

### What the projects share

Claude Code keeps its plugin files in `~/.claude/plugins/`. The variable `CLAUDE_CONFIG_DIR` replaces `~/.claude`.

- The plugin code is in a cache, one directory for each plugin version: `cache/agentic-dev-flow/<plugin>/<version>`.
- `installed_plugins.json` keeps one record for each plugin and project path. Two projects can run two versions side by side.
- `known_marketplaces.json` keeps one record of the marketplace `agentic-dev-flow`, with one `ref`.

When two projects pin different refs, the marketplace clone follows the last marketplace add or update. The install record of each project does not change with it.

Not checked: what an install or a project trust in the other project then takes.

### Where to install

The main directory is the directory of the main checkout of the project, where the repository was cloned. It is not the branch `main`. Every worktree of the project belongs to it.

The flow reads the install records of Claude Code for the main directory of the project. The Superpowers gate uses the same rules as every other plugin:

- A user-scope record counts everywhere.
- A project or local record counts when its project path is the main directory, or the worktree where the command runs.
- At the same scope, the record of the main directory wins over the record of a worktree.
- With no record, a plugin counts when the project settings enable it and its files are in the plugin cache. This is the case of a teammate who trusts the project.
- The flow reads the enabled and disabled settings from the main directory.

A project install that you make in a worktree counts only for commands that run in that worktree. Install from the main directory, so that every worktree finds the plugin. Do this also when you switch a project in a worktree. When a plugin is not installed, the message and the registry check name the command and say to run it from the main directory.

`claude plugin install --scope project` rewrites `.claude/settings.json` of the main directory. Commit that change, or restore the file with `git checkout -- .claude/settings.json` when it only changed the indentation. See [Troubleshooting](../troubleshooting.md).

### A teammate on the same machine

A teammate who clones the project and trusts it needs no install record of their own. Claude Code enables the plugins at the pinned version from the shared cache. `update.mjs check` then reports the installed release equal to the pin.

When the project moves to a new release, each developer runs `/adf:update` once. See [What a teammate does](team.md).

## Codex

Codex installs plugins at user scope. One install and one marketplace record serve every project on the machine.

- The flow finds `adf` when the plugin is enabled in `config.toml` and its files are in the plugin cache. The user's `config.toml` and the project's `.codex/config.toml` both count, and the project's value wins.
- A project that pins a release moves the user's marketplace record to its `ref` when `/adf:update` pulls the release. The record is then the same for every project. `/adf:update` says so.
- The user's marketplace record is the only one that Codex has. A project that pins another `ref` moves it.

Not checked: two projects that pin different refs in Codex, run one after the other.

The Codex install is on [the Codex page](../getting-started/codex.md).
