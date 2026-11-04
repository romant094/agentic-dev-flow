<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/scripts/lib/provision.mjs
-->

# The worktree hooks

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`provision` and `teardown` are hooks. The core calls every enabled provider, in registry order. A plugin that does not provide the hook is skipped. This is not an error. The contracts are in [`provision`](../../../../plugins/adf/contract/README.md#provision-hook-since-16) and [`teardown`](../../../../plugins/adf/contract/README.md#teardown-hook-since-16) of the contract README.

| Hook | What it does |
|---|---|
| `provision` | Prepares a worktree the core made, before anything runs in it. It returns `actions` and `notes`. |
| `teardown` | Releases what `provision` made, before the core runs `git worktree remove`. |

The core makes four kinds of worktree: `change`, `group`, `base-check` and `proof`. A `base-check` worktree tells a failure that existed before the change from a new one. A `proof` worktree holds a test-first proof. Both are throwaway. See [worktrees](../../concepts/worktrees.md).

A provider writes only paths that git ignores in the worktree. It never writes in the main checkout. The core compares `git status --porcelain` of both trees before and after the call. It refuses on any difference. A call is re-runnable: a second call changes nothing.

## When it acts

| Hook | Stage |
|---|---|
| `provision` | [/adf:propose](../../cycle/propose.md) makes the `change` worktree. [/adf:apply](../../cycle/apply.md) makes the `group`, `base-check` and `proof` worktrees. |
| `teardown` | Before the core removes any of those worktrees. [/adf:archive](../../cycle/archive.md) removes the `change` worktree. |

Before the `provision` call, the core copies into the worktree the untracked files that the section `## Worktree copies` of the planning guide names. It takes them from the main checkout.

## With no provider

- `provision`: the core makes the copies and does nothing else.
- `teardown`: the core removes the worktree.

## Results

| State | Effect |
|---|---|
| `done` | The step continues. |
| `degraded` | The tool of the plugin is missing. The step continues and the report gives the hint. |
| `refused` | `provision` stops the step. `teardown` stops the removal, and the worktree stays. |

## Providers

| Plugin | `provision` | `teardown` |
|---|---|---|
| [`adf-npm-workspaces`](../../plugins/adf-npm-workspaces.md) | yes | no |
| [`adf-postgres`](../../plugins/adf-postgres.md) | yes | yes |
| [`adf-prisma`](../../plugins/adf-prisma.md) | yes | no |
