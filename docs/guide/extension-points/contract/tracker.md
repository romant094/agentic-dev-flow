<!-- sources:
- plugins/adf/skills/land/**
- plugins/adf/contract/README.md
- plugins/adf/scripts/land.mjs
- plugins/adf/scripts/lib/land.mjs
- plugins/adf/scripts/lib/tracker.mjs
-->

# The tracker role

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`tracker` is a role. The provider connects the host project's issue tracker. Propose gathers and starts issues. After the merge, the change hands each issue to its tester. The core never names a tracker, its statuses or its markup. The contract is in [the contract README](../../../../plugins/adf/contract/README.md#tracker-role-since-17).

| Operation | What it does |
|---|---|
| `check` | Reports whether the tracker tool is ready. A degraded result is `missing`, `unauthenticated` or `unconfigured`. It never shows a secret. |
| `gather` | Returns the issues for a list of keys or a text. Each item has a key, a title, a status and a kind. |
| `bugs` | Since contract 1.11. Returns the open bugs of the tracker. Each item has the shape of a `gather` item, and its kind is `bug`. |
| `start` | Starts the issues of the change. It is held for your yes. |
| `handoff` | Writes a comment on each issue and hands it to its tester. It is held for your yes. |

The provider keeps its files and plans in `<main>/.superpowers/sdd/<change>/tracker/`. The directory is in the main checkout, so it outlives the worktree.

Every write is held for your yes. The core calls `start` and `handoff` without `apply` and shows a preview. It calls again with `apply` only after your yes. An issue that you moved by hand meanwhile is skipped, not failed.

## When it acts

| Stage | Operation |
|---|---|
| [/adf:propose](../../cycle/propose.md) | `check` and `gather` before the branch. `start` after the worktree exists. |
| [/adf:verify](../../cycle/verify.md) | The key check maps the tracker key. |
| [/adf:land](#the-land-command) | `check` and `handoff` after the merge. |

The command `scope.mjs gather --change <name> --bugs` calls `bugs` in place of `gather`. It takes no keys and no phrase. The debt store adds each open entry of class `defect`. So the open defects of both sources show together. A provider written for a contract below 1.11 has no `bugs`. The report says so and asks you to name a key or a phrase.

An item of kind `bug` triggers the bug check of the core. The check needs a reproduction and the expected behaviour.

## With no provider

- `gather` returns no item. The scope holds only the debt store and the changes in flight.
- `start` and `handoff` are skipped.
- The verify key check maps no tracker key.
- Each report says: "no tracker plugin is enabled; the tracker step was skipped".

After a `degraded` check, you may skip the tracker for one change. The scope records the choice. Every later tracker step skips and says so.

## Providers

| Plugin | Notes |
|---|---|
| [`adf-jira`](../../plugins/adf-jira.md) | Provides `check`, `gather`, `bugs`, `start` and `handoff`. |

## The land command

`/adf:land <change-name>` lands a change after its merge. It is not in the main cycle. It needs a tracker plugin. The change name is optional. Without it, land uses the change that the conversation names. If none, it looks for archived changes and asks which one to land only when the choice is not clear.

Land gives each tracker issue that the change took one comment. The tracker plugin renders the comment from fields that an agent writes and the script checks. The issue then goes to its tester.

- A partial issue gets a comment of what remains. Where the tracker plugin has an initial status, the issue goes back to it. It never goes past the tester.
- An issue that mirrors a group of debt entries is handed off when no entry of its group remains in the debt tree. While some remain, it is partial.
- Land runs after [/adf:archive](../../cycle/archive.md), once the merge request is merged. With no forge, it runs once the branch is merged into its base.
- Land merges nothing and pushes nothing.

### The steps

Each step is one `land.mjs` call or one dispatch. Each step records its result in the main checkout. A rerun of `/adf:land` resumes. A finished step returns what it recorded.

| Step | Name | What happens |
|---|---|---|
| 1 | Resume | `land.mjs report`. When the state is `complete` or `skipped`, land shows the report and stops. When it is `stopped`, the merge request was closed without a merge. Land shows the report and stops. |
| 2 | Check | `land.mjs check`. When it is `skipped`, land shows why and stops. The reasons are no tracker plugin, a tracker skipped for this change, or no issue and no tracked debt. When it is `degraded`, land shows the hint and asks you to fix the tracker. |
| 3 | Wait | `land.mjs wait`. When the change is merged, land goes on. When it is not, land shows the report and stops. When the merge request is closed, land shows the refusal and hands off nothing. When it is `degraded`, land shows the hint. Run `/adf:land` again once the forge is fixed. |
| 4 | Write the inputs | `land.mjs comment-input`. Land dispatches one read-only agent for each issue, all in parallel. |
| 5 | Check each reply | `land.mjs comment`. The script checks the fields of the reply. |
| 6 | Hand off | `land.mjs handoff`. The tracker previews each comment and status change. Land asks for your yes. |
| 7 | Report | Land shows the report as it is. |

With no forge `state`, "merged" has two forms. The branch tip is in its base. Or a squash commit on the base has the patch id of the whole change. Land does not see a squash that carries other edits too. Only a forge with `state` sees it.

If the main checkout does not hold the merged change, the script reads it from the merge commit. It fetches the commit when it is not local. Do not pull or update the main checkout.

### The comment fields

The core checks the fields. The provider renders the comment.

| State | Fields | Word limit |
|---|---|---|
| `taken` | `done`, `test` | 80 and 120 |
| `partial` | `done`, `test`, `remains` | 80, 120 and 80 |
| `not-reproduced` | `tried` | 80 |

The core refuses a missing field, an empty field, a field the state does not take, a field over its limit, and a link or URL in any field. On a refusal, land sends the errors to the same agent once. After a second refusal, land writes the fields with you.

### What it asks

- Which archived change to land, when the name is not clear.
- To fix the tracker, when the check is `degraded`.
- The fields of a comment, after two refusals of the agent's reply.
- Your yes before the hand-off. A warning says the change merged into a branch other than the integration branch. Land shows it and names it when it asks for your yes.

### What it never does

- It never merges.
- It never pushes.
- It never writes to the tracker before your yes.

### If a step fails

1. If the hand-off has a `failed` item, run `/adf:land` again. Answer yes. The plan resumes where it stopped.
2. If the hand-off is `refused`, read the error. Run `/adf:land` again. It builds a new plan.
3. If the wait says the merge request is open, merge it. Then run `/adf:land` again.
