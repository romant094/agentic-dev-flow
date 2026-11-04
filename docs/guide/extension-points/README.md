<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/contract/contract.json
- plugins/adf/scripts/lib/registry.mjs
- plugins/adf/scripts/lib/roles.mjs
-->

# Extension points

The ADF core runs the change cycle. It never names a tool such as a forge or an issue tracker. A plugin adds such a tool at an extension point. Every extension point is optional.

Extension points have two parts:

- Contract points. The core calls a plugin script at a named place in the flow. This page and the pages under `contract/` describe them.
- Agent hooks. The agent runtime calls a script before a tool call or at session start. See [the agents' own hooks](agent-hooks.md).

Plugin authors read `plugins/adf/contract/README.md`. It is the normative contract: the input, the output and the version rules of each point. These pages describe what each point does for the reader. They do not repeat the contract.

For the Codex form of each command, see [the Codex page](../getting-started/codex.md).

## The full cycle

The main cycle has five stages. See [the main cycle](../cycle/README.md).

```text
propose -> apply -> verify -> review -> archive -> land
```

`/adf:land` is optional. It needs a tracker plugin. You run it after the merge request is merged. See [the tracker role](contract/tracker.md).

`/adf:retro` is apart from the cycle. It uses the `forge` and `upstream` roles. See [/adf:retro](../cycle/retro.md).

## The points

There are two kinds of contract point.

- A role has at most one provider. With no provider, the core runs its own default.
- A hook has any number of providers. The core calls each one in registry order. With no provider, the core does nothing extra.

| Point | Kind | When it acts | Plugins that provide it | With no provider |
|---|---|---|---|---|
| [`forge`](contract/forge.md) | role | Propose opens the merge request. Apply pushes. Archive finalizes it. | [`adf-gitlab`](../plugins/adf-gitlab.md) | Nothing is pushed. No merge request exists. Archive offers a local merge. |
| [`knowledge`](contract/knowledge.md) | role | Propose reads the index. Verify checks the paths. Archive ingests and logs. | [`adf-memory`](../plugins/adf-memory.md) | No index is read. Archive skips the ingest. No log entry is written. |
| [`upstream`](contract/upstream.md) | role | Retro files its findings and the ADF debt. | [`adf-maintainer`](../plugins/adf-maintainer.md) | Nothing is filed. |
| [`tracker`](contract/tracker.md) | role | Propose gathers and starts issues. Verify maps the tracker key. Land hands the issues off. | [`adf-jira`](../plugins/adf-jira.md) | The scope holds only the core's own sources. The tracker steps are skipped. |
| [`provision`](contract/provision-teardown.md) | hook | After the core makes a worktree. | [`adf-npm-workspaces`](../plugins/adf-npm-workspaces.md), [`adf-postgres`](../plugins/adf-postgres.md), [`adf-prisma`](../plugins/adf-prisma.md) | The core copies the files the planning guide names. Nothing else is done. |
| [`teardown`](contract/provision-teardown.md) | hook | Before the core removes a worktree. | [`adf-postgres`](../plugins/adf-postgres.md) | The worktree is removed. |
| [`verify-check`](contract/verify-check.md) | hook | Verify runs it after the core's own checks. | [`adf-prisma`](../plugins/adf-prisma.md) | Verify adds no section. |

The plugin [`adf-english-check`](../plugins/adf-english-check.md) provides no contract point. It is an agent hook.

## The registry

A project enables a plugin in `.claude/adf-extensions.json`. The core reads the registry and calls the enabled plugins. `/adf:add` writes the entry. See [the registry](../concepts/registry.md).
