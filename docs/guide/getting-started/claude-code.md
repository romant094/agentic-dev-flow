<!-- sources:
- plugins/adf/skills/init/**
- plugins/adf/skills/add/**
- plugins/adf/scripts/lib/update.mjs
- plugins/adf/scripts/lib/host-settings.mjs
- .claude-plugin/marketplace.json
-->

# Install in Claude Code

This page installs ADF in one project. The install is per project, so every teammate gets the same release.

## Before you start

- Install Node 20 or later.
- Use a git repository with an integration branch, for example `develop`.

The `openspec` command-line tool is not needed.

## Declare the marketplace

Pin the release in the project's `.claude/settings.json`. The pin is the entry `extraKnownMarketplaces.agentic-dev-flow.source.ref`. Merge this block into the file:

```json
{
  "extraKnownMarketplaces": {
    "agentic-dev-flow": {
      "source": {
        "source": "git",
        "url": "https://github.com/romant094/agentic-dev-flow.git",
        "ref": "v0.20.0"
      }
    }
  },
  "enabledPlugins": {
    "adf@agentic-dev-flow": true
  }
}
```

The `ref` must be a release tag in the form `v<x.y.z>`. `/adf:update` refuses a project whose `ref` is not such a tag. A teammate who trusts the project gets the same marketplace.

## Install the plugin

1. Open Claude Code in the project.
2. Trust the project when Claude Code asks.
3. Run this command in a shell:

   ```
   claude plugin install adf@agentic-dev-flow --scope project
   ```

The install also installs and enables the dependency, Superpowers (`superpowers@claude-plugins-official`).

Not checked: whether `claude plugin install` from a shell finds a marketplace that only `.claude/settings.json` declares. Not checked: whether trusting the project already offers the install.

If a plugin is already installed, `claude plugin install` does nothing. To move an installed plugin to a new release, use `/adf:update`. See [the update page](../update.md).

## Load the skills

Restart Claude Code in the project. The skills load at the restart.

## Set up the project

1. Run `/adf:init`.
2. Answer its questions.
3. Commit what it wrote.
4. Merge the commit into the integration branch before the first `/adf:propose`.

`/adf:init` is safe to run again. It creates only what is missing.

`/adf:init` asks about these values. It asks only when the project has no value yet:

- the integration branch, and any other branch that nobody commits to directly;
- the directory of the technical debt tree (it offers `docs/tech-debt`);
- the worktree preparation: the commands that rebuild what git ignores;
- the command that runs the whole test suite;
- the untracked files that every worktree copies from the main checkout, for example the env file;
- the format command that every commit of the flow runs.

`/adf:init` writes these files:

| File | Content |
|---|---|
| `.claude/adf-extensions.json` | the registry: the branch policy and the enabled plugins |
| `.claude/settings.json` | the `adf` plugin and the marketplace, only the keys that are missing |
| `openspec/planning.md` | the planning guide, with the answers above |
| `openspec/review-prompt.md` | the prompt of the code review |
| `.gitignore` | lines for the local state of the flow |
| the debt tree's root index | created when the tree does not exist |
| `.adf/retro/<date>-window.json` | the retrospective window, only when the integration branch already holds archived changes |

`/adf:init` does not commit. It does not edit your agent instruction files, such as `CLAUDE.md`. It lists the lines that name another flow's commands. Reword them to name `/adf:propose`.

## Enable more plugins

Enable a plugin in two steps. For example, for the memory plugin:

1. Install the plugin.
2. Enable it with `/adf:add`.

```
claude plugin install adf-memory@agentic-dev-flow --scope project
/adf:add adf-memory@agentic-dev-flow
```

`/adf:add` takes the plugin id and, as a second argument, its configuration as a JSON object. On a plugin that is already enabled, the configuration replaces the current one. [Plugins](../plugins/README.md) lists the plugins.

## Next

[Make your first change](first-change.md).

The Codex form of each command is in [the Codex page](codex.md).
