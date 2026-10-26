# ADF npm workspaces

This plugin provides the `provision` hook of the ADF extension contract (version 1.6) for an
npm-workspaces monorepo. Every worktree the core makes (a change, a group, a base check, a
proof tree) gets its own `node_modules`: its third-party packages are the main checkout's, and
its workspace packages are its own. The ADF core calls it; you do not run it by hand.

Install it in the host project, then add it to the registry with `/adf:add`:

```
/plugin install adf-npm-workspaces --marketplace romant094/agentic-dev-flow
```

## The install rule

Never run `npm install`, `ci`, `add`, `update` or `uninstall` in a worktree. Its
`node_modules` links into the main checkout's, so the command rewrites the main checkout's
dependencies. A dependency update is its own change, made in the main checkout.

The plugin enforces the rule with a Claude Code `PreToolUse` hook on Bash commands
(`scripts/guard.mjs`). It blocks those commands, and the aliases npm accepts for them, when the
directory they run in is a linked git worktree (its git directory differs from the
repository's common directory). It reads `cd <dir> &&` and `npm --prefix <dir>` (or `-C`). The
main checkout, `npm install -g` and every other command are allowed. A command line it cannot
read, or a `cd` to a variable, is allowed: the guard fails open. Claude Code loads a plugin's
hooks only for a plugin installed by id, so the guard needs the plugin installed as above: a
registry `path` entry runs `provision` but carries no guard.

## What `provision` does

It acts only when the main checkout's `package.json` has `workspaces` and its `node_modules`
exists. Otherwise it is `done` with no actions and a note that says why.

For the root `node_modules`, and for the `node_modules` of each workspace the `workspaces`
patterns name (a literal segment or one with `*`; a negation or `**` is noted and skipped):

| Entry in the main checkout | In the worktree |
|---|---|
| a workspace self-link: a symlink that resolves inside the repository and outside every `node_modules` | the same relative link text, so it resolves to the worktree's own package |
| a directory that holds a self-link (a scope such as `@acme`) | a real directory, recursed |
| `.bin` | a real directory; each relative link keeps its text and resolves through the worktree's own entries, so a third-party binary runs from the main checkout and a workspace binary from the worktree |
| a cache named in `unshared` | left out; the worktree fills its own. A link there is removed |
| anything else (a package, a scope of third-party packages, `.package-lock.json`) | an absolute symlink to the main checkout's entry |

The main checkout is only read. Nothing is written through a link: every directory on the way
to a write is checked with `lstat`, and a link where a real directory is needed is removed
first. This also repairs a worktree whose whole `node_modules` was once a link into the main
checkout. A link that is part of the worktree's tracked tree (a workspace directory that is a
symlink) is never removed: the run refuses.

The run is safe to repeat: an entry already right is left as it is, and a second run reports
no actions. An entry in the worktree that the main checkout does not have is kept.

Then each command in `config.build` runs through the shell in the worktree, in order. A command
that fails refuses the run with its exit code and the last 20 lines of its output; the commands
after it do not run. `config.build` is deprecated: list those builds in the core's worktree
preparation recipe instead (below).

## Configuration

The registry entry's `config`:

| Field | Default | Meaning |
|---|---|---|
| `build` | `[]` | deprecated: shell commands run in the worktree after provisioning, for example `["npm run build:shared"]` |
| `unshared` | `[]` | entry names never shared with the main checkout, added to `.vite` and `.vite-temp` |

An unknown field is refused.

`build` still runs as described, but it runs only at provisioning. The core's worktree
preparation recipe, `## Worktree preparation` in the host's `openspec/planning.md`, names each
build with the input paths that trigger it, and the core's scripts run it at provisioning and
again before a covering or whole-suite run, or after a group merge, when its inputs changed
(`plugins/adf/scripts/prepare.mjs`; `/adf:init` proposes the candidates). Move each `build`
command into the recipe with `prepare.mjs add` and remove `build` from the registry entry, so
the same build does not run twice.

## Registry order

The `provision` hook runs in registry order. List this plugin before `adf-postgres` and
`adf-prisma`: the Prisma plugin replaces links this plugin makes and needs the worktree's
`node_modules` to exist.

## Calling convention

The core runs `node <plugin>/scripts/provision.mjs provision` with the host root as the working
directory and writes one JSON object to stdin: `{ "root", "config", "input" }`, where `input`
is `{ worktree, main, kind, change, branch, base: { ref, commit }, files, needs }`. The plugin
reads `worktree`, `main` and `kind`; the others are accepted and not used.

The plugin prints one JSON object. `done`: `{ state, actions: [{ op, path }], notes }`, where
`op` is `mkdir`, `link`, `relink`, `unlink` or `remove` and `path` is relative to the worktree;
`notes` always ends with the install rule. `refused` (exit 1): `{ state, error }`, for bad input
or config, a worktree that resolves to the main checkout, a link on the tracked tree, or a
failed build command (then with `actions` too). The plugin never returns `degraded`: it needs
no tool but `node` and the shell.
