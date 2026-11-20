<!-- sources:
- plugins/adf/scripts/lib/provision.mjs
- plugins/adf/scripts/lib/groups.mjs
- plugins/adf/scripts/lib/branches.mjs
- plugins/adf/scripts/lib/workspace.mjs
- plugins/adf/schema/settings.schema.json
-->

# Worktrees

Every change runs in its own git worktree. The main checkout is never switched, so several changes can run at the same time and none touches your working tree.

## One branch and worktree per change

`/adf:propose` makes the branch and the worktree before it writes any artifact. The worktree is at `.claude/worktrees/<change>`. `/adf:init` adds `.claude/worktrees/` to `.gitignore`. Without that line, `/adf:propose` refuses. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

The branch name is `<type>/<change>`. The type comes from the start of the change name:

| Change name starts with | Type |
|---|---|
| `add-` | `feat` |
| `fix-` | `fix` |
| `restructure-` or `refactor-` | `refactor` |

When a tracker issue names the change, the branch is `<type>/<key>/<change>`. The type is the first of these:

1. The type you give (`workspace.mjs suggest --type <type>`). It is one of the Conventional Commits types.
2. The prefix of the change name.
3. `fix`, when every tracker issue that the change takes is a bug. The tracker gives no other type.

With none of these, the command asks you for the type. `/adf:quick` also shows the type that its estimate suggests, when there is one. That suggestion never names the branch by itself. You confirm the branch name.

You choose the base of the change:

- The integration branch. The flow fetches it first when the project has a remote.
- Your current branch, when you work in the middle of a feature and the branch is not protected.

The change merges back into its base. A branch in `branches.protected` is never a change branch. See [the registry](registry.md).

The later stages run in the same worktree. `/adf:archive` removes it. See [/adf:archive](../cycle/archive.md).

The removal never uses `--force`. It refuses a worktree with uncommitted changes or untracked files, and it keeps the branch.

## Groups

A group is a set of tasks of the plan that can run in parallel. The plan lists the groups in its `## Execution Graph` table.

When the first wave holds one group, its tasks run in the change worktree. When it holds more, each group gets its own worktree and branch:

| Item | Name |
|---|---|
| Worktree | `.claude/worktrees/<change>--group-<n>` |
| Branch | `<change branch>--group-<n>` |

A group branch forks from the change branch. The flow merges the groups into the change branch one by one, with a merge commit, and a scoped review checks each merge. A conflict leaves the merge open for the agent that resolves it.

The flow removes the worktree and the branch of a merged group. A blocked group keeps both. See [/adf:apply](../cycle/apply.md).

## Provisioning

A new worktree lacks what git ignores, such as `node_modules` or an env file. The flow prepares each worktree it makes, in this order:

1. The flow copies the paths listed in the key `worktreeCopies` of `openspec/settings.json` from the main checkout. It copies a path only when the worktree does not hold it and git ignores it there.
2. The flow calls the `provision` hook. Each enabled provider prepares the worktree for its stack.
3. The flow runs the commands of the key `worktreePreparation` in `openspec/settings.json`. It runs a command again after a group merge when the inputs of the command changed.

After the hook, the flow compares `git status` of the worktree and of the main checkout with their state before. A difference refuses the provisioning and names the paths. This catches a provider that changed a tracked file or wrote into the main checkout.

Before the flow removes a worktree, it calls the `teardown` hook. A refused teardown keeps the worktree.

The kinds of worktree are `change`, `group`, `base-check` and `proof`. A `base-check` or `proof` worktree gets no needs from the plan. For the hooks, see [the worktree hooks](../extension-points/contract/provision-teardown.md).
