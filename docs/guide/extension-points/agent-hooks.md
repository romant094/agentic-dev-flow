<!-- sources:
- plugins/adf/hooks/**
- plugins/adf/contract/README.md
- plugins/adf-english-check/hooks/**
- plugins/adf-npm-workspaces/hooks/**
- plugins/adf/scripts/update.mjs
- plugins/adf-english-check/scripts/hook.mjs
- plugins/adf-npm-workspaces/scripts/guard.mjs
- plugins/adf-english-check/scripts/lib/english.mjs
- plugins/adf-npm-workspaces/scripts/lib/guard.mjs
- plugins/adf/scripts/lib/update.mjs
- plugins/adf-english-check/.codex-plugin/plugin.json
-->

# The agents' own hooks

An agent hook is not a contract point. The agent runtime runs it: Claude Code or Codex. Each hook is a `hooks/hooks.json` file in a plugin. The runtime calls the script of the hook at a fixed event.

Three plugins ship hooks.

| Plugin | Event | What it does |
|---|---|---|
| `adf` | `SessionStart` | Tells you when a newer release exists. |
| `adf-english-check` | `PreToolUse` on Bash | Blocks a commit of non-English lines. |
| `adf-npm-workspaces` | `PreToolUse` on Bash | Blocks an npm command that changes dependencies in a linked worktree. |

For the Codex form of each command, see [the Codex page](../getting-started/codex.md).

## Hooks in Codex

In Codex, a hook runs only after you trust it in `/hooks`. See the step "Trust the hooks" on [the Codex page](../getting-started/codex.md).

A plugin with hooks ships `.codex-plugin/plugin.json`. Codex loads the hooks of a plugin only from that file or from `.claude-plugin/plugin.json`. The package generates the file for each plugin that has a `hooks/hooks.json`.

Claude Code loads the hooks of a plugin only when you install the plugin by id. A registry entry with a `path` gets the contract points only. See [the registry](../concepts/registry.md).

## The English check

Plugin: [`adf-english-check`](../plugins/adf-english-check.md). Event: `PreToolUse`, matcher `Bash`. Script: `scripts/hook.mjs`.

The hook blocks a commit that takes a line of non-English text. For the characters it finds, the scope, the commits it sees, the exit codes and the block message, see [adf-english-check](../plugins/adf-english-check.md).

Not checked: the hook in Codex, with the trust given on the `/hooks` screen.

## The npm guard

Plugin: [`adf-npm-workspaces`](../plugins/adf-npm-workspaces.md). Event: `PreToolUse`, matcher `Bash`. Script: `scripts/guard.mjs`.

The guard blocks an npm command that changes dependencies in a linked git worktree. For the commands it blocks, the directory it reads and the exit codes, see [adf-npm-workspaces](../plugins/adf-npm-workspaces.md).

Not checked: the guard in Codex.

## The session-start update notice

Plugin: `adf`, the core. Event: `SessionStart`, matcher `startup`, timeout 10 seconds. Script: `scripts/update.mjs notice`.

The hook prints a message at session start in two cases:

- A newer ADF release exists.
- The project pins a release that is not installed.

The message names the update command. In Claude Code it is `/adf:update`. The hook asks the remote once a day. When there is nothing to say, or an error occurs, it prints nothing and exits 0.

For the update steps, see [update](../update.md).

In Codex, the notice names the skill `adf:update`. Not checked: the notice in Codex.
