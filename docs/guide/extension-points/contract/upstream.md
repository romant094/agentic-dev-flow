<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/scripts/lib/roles.mjs
-->

# The upstream role

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`upstream` is a role. It files the findings of a retrospective outside the host project. The target is the issue tracker of the flow itself. The core never names that tracker. The core reads the repository as the `owner/name` path of the `repository` URL in its own `plugin.json`. The contract is in [the contract README](../../../../plugins/adf/contract/README.md#upstream-role-since-14-content-since-15).

| Operation | What it does |
|---|---|
| `check` | Checks that the repository is reachable and writable. It refuses when you have no push permission. |
| `file` | Files each finding and each ADF debt record as an issue. A rerun returns the issue filed before, with `existed: true`. |

The core sends the content of the findings and of the debt records. The provider reads no file of the host.

## When it acts

[/adf:retro](../../cycle/retro.md) runs the `file` step. The core calls `check` first. It calls `file` only after a `done` check and your yes. You can choose which findings to file. After a `done` file, the core marks each debt record as filed, with the URL of its issue.

## With no provider

- Nothing is filed.
- The findings stay in the sidecar of the retrospective.
- The ADF debt stays unfiled.

## Providers

| Plugin | Notes |
|---|---|
| [`adf-maintainer`](../../plugins/adf-maintainer.md) | Provides `check` and `file`. |
