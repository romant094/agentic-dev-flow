<!-- sources:
- plugins/adf-npm-workspaces/scripts/*.mjs
- plugins/adf-npm-workspaces/scripts/lib/*.mjs
- plugins/adf-npm-workspaces/adf-extension.json
- plugins/adf-npm-workspaces/hooks/**
-->

# `adf-npm-workspaces`

`adf-npm-workspaces` provides the `provision` hook for an npm-workspaces monorepo. Every worktree that the core makes gets its own `node_modules`: a change, a group, a base check and a proof tree. Its third-party packages are the main checkout's. Its workspace packages are its own. The core calls the plugin. You do not run it by hand.

The plugin also ships a hook of the agent: a guard that enforces the install rule below.

## Install and enable

1. Install the plugin by id. The guard loads only for a plugin installed by id.
2. Enable it in the registry.

```
claude plugin install adf-npm-workspaces@agentic-dev-flow --scope project
/adf:add adf-npm-workspaces@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md).

A registry `path` entry runs `provision` but carries no guard.

## The install rule

Never run `npm install`, `ci`, `add`, `update` or `uninstall` in a worktree. Its `node_modules` links into the one of the main checkout, so the command rewrites the dependencies of the main checkout. A dependency update is its own change, made in the main checkout.

The plugin enforces the rule with a Claude Code `PreToolUse` hook on Bash commands, `scripts/guard.mjs`. See [the agents' own hooks](../extension-points/agent-hooks.md).

- It blocks those commands, and the aliases that npm accepts for them, when the directory they run in is a linked git worktree. Its git directory then differs from the common directory of the repository.
- It reads `cd <dir> &&` and `npm --prefix <dir>` (or `-C`).
- It allows the main checkout, `npm install -g` and every other command.
- It allows a command line that it cannot read, and a `cd` to a variable. The guard fails open.

The guard acts only in a repository whose registry has an entry for this plugin. The registry is `.claude/adf-extensions.json` in the main checkout. The entry is an installed id, or a `path` entry whose directory holds the `adf-extension.json` of this plugin. With no registry, or no entry for this plugin, the guard exits 0 and prints nothing, although the plugin is installed.

## What `provision` does

It acts only when the `package.json` of the main checkout has `workspaces` and its `node_modules` exists. Otherwise it is `done` with no actions and a note that says why.

It handles the root `node_modules`, and the `node_modules` of each workspace that the `workspaces` patterns name. A pattern is a literal segment or one with `*`. The plugin notes and skips a negation or `**`.

| Entry in the main checkout | In the worktree |
|---|---|
| a workspace self-link: a symlink that resolves inside the repository and outside every `node_modules` | the same relative link text, so it resolves to the package of the worktree |
| a directory that holds a self-link, such as a scope `@acme` | a real directory, recursed |
| `.bin` | a real directory; each relative link keeps its text and resolves through the entries of the worktree, so a third-party binary runs from the main checkout and a workspace binary from the worktree |
| a cache named in `unshared` | left out; the worktree fills its own; a link there is removed |
| anything else, such as a package, a scope of third-party packages or `.package-lock.json` | an absolute symlink to the entry of the main checkout |

The main checkout is only read. The plugin writes nothing through a link. It checks every directory on the way to a write with `lstat`. It removes a link first where a real directory is needed. This also repairs a worktree whose whole `node_modules` was once a link into the main checkout. It never removes a link that is part of the tracked tree of the worktree, such as a workspace directory that is a symlink. The run refuses instead.

The run is safe to repeat. It leaves an entry that is already right. A second run reports no actions. It keeps an entry in the worktree that the main checkout does not have.

Then each command in `config.build` runs through the shell in the worktree, in order. A command that fails refuses the run, with its exit code and the last 20 lines of its output. The commands after it do not run.

## Configure

The `config` object of the registry entry:

| Field | Default | Meaning |
|---|---|---|
| `build` | `[]` | deprecated: shell commands that run in the worktree after provisioning, for example `["npm run build:shared"]` |
| `unshared` | `[]` | entry names never shared with the main checkout, added to `.vite` and `.vite-temp` |

The plugin refuses an unknown field.

`build` still runs, but only at provisioning. Use the worktree preparation recipe of the core instead. It is `## Worktree preparation` in `openspec/planning.md` of the project. It names each build with the input paths that trigger it. The scripts of the core run it at provisioning, before a covering or whole-suite run, and after a group merge, when its inputs changed. `/adf:init` proposes the candidates.

To move a build into the recipe:

1. Run `prepare.mjs add` for each `build` command. The script is `plugins/adf/scripts/prepare.mjs`.
2. Remove `build` from the registry entry.

Then the same build does not run twice.

## Registry order

The `provision` hook runs in registry order. List this plugin before `adf-postgres` and `adf-prisma`. The Prisma plugin replaces links that this plugin makes, and it needs the `node_modules` of the worktree to exist.

## Calling convention

The core runs `node <plugin>/scripts/provision.mjs provision` with the host root as the working directory. It writes one JSON object to stdin: `{ "root", "config", "input" }`. The `input` is `{ worktree, main, kind, change, branch, base: { ref, commit }, files, needs }`. The plugin reads `worktree`, `main` and `kind`. It accepts the others and does not use them.

The plugin prints one JSON object.

| State | Shape |
|---|---|
| `done` | `{ state, actions: [{ op, path }], notes }`; `op` is `mkdir`, `link`, `relink`, `unlink` or `remove`; `path` is relative to the worktree; `notes` always ends with the install rule |
| `refused` (exit 1) | `{ state, error }`, for bad input or config, a worktree that resolves to the main checkout, a link on the tracked tree, or a failed build command; a failed build command adds `actions` |

The plugin never returns `degraded`. It needs no tool but `node` and the shell.

## Points it provides

- [`provision`](../extension-points/contract/provision-teardown.md): the operation `provision`.
