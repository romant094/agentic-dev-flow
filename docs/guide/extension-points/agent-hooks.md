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

The hook reads each Bash command before it runs. When the command commits, the hook checks the files that the commit takes. A line with non-English text blocks the commit.

The hook finds these characters: Cyrillic, CJK punctuation, CJK ideographs and fullwidth forms. Em dashes, arrows and typographic quotes pass.

The hook acts only in a project whose registry enables `adf-english-check`. Without an entry, it does nothing.

### Which files it checks

The registry entry sets the scope in its `config`. A key you do not set keeps its default.

| Key | Default |
|---|---|
| `include` | `openspec/changes/**`, `openspec/specs/**` |
| `exclude` | `openspec/changes/**/plan.md` |
| `extensions` | `md`, `mjs`, `yaml`, `yml`, `json` |

An `exclude` glob wins over an `include` glob.

### Which commits it sees

The hook sees a `git commit` command. It sees the commit scripts of the ADF core too, such as `commit.mjs`. It reads the paths such a script commits.

### What you see

| Exit code | Meaning |
|---|---|
| 0 | The call runs. The command is not a commit, or the hook found nothing. |
| 2 | The call is blocked. The agent gets one line `path:line: text` for each finding. |
| 1 | The check failed. The call runs. The message says the commit was not checked. |

The block message starts with `adf-english-check: the commit was stopped; these lines are not in English:`. It ends with the instruction to rewrite the lines in English and run the command again.

### In Codex

Not checked: the hook with the trust given on the `/hooks` screen.

## The npm guard

Plugin: [`adf-npm-workspaces`](../plugins/adf-npm-workspaces.md). Event: `PreToolUse`, matcher `Bash`. Script: `scripts/guard.mjs`.

A worktree that the plugin provisions has a `node_modules` that links into the `node_modules` of the main checkout. An npm command that changes dependencies would rewrite the main checkout's dependencies. The guard blocks it.

The guard blocks these commands in a linked git worktree, with their npm aliases: `install`, `ci`, `add`, `update` and `uninstall`. It does not block a global command (`-g`).

The guard reads `cd <dir>` and `npm --prefix <dir>` to find the directory where the command runs. A command line that it cannot read is allowed.

The guard acts only when the registry of the main checkout enables `adf-npm-workspaces`.

| Exit code | Meaning |
|---|---|
| 0 | The call runs. |
| 2 | The call is blocked. The message says that a dependency update is its own change, to make in the main checkout. |
| 1 | The guard failed. The call runs. The message says the command was not checked. |

Not checked: the guard in Codex.

## The session-start update notice

Plugin: `adf`, the core. Event: `SessionStart`, matcher `startup`, timeout 10 seconds. Script: `scripts/update.mjs notice`.

The hook prints a message at session start in two cases:

- A newer ADF release exists.
- The project pins a release that is not installed.

The message names the update command. In Claude Code it is `/adf:update`. The hook asks the remote once a day. When there is nothing to say, or an error occurs, it prints nothing and exits 0.

For the update steps, see [update](../update.md).

In Codex, the notice names the skill `adf:update`. Not checked: the notice in Codex.
