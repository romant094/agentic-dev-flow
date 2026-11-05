<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/scripts/forge.mjs
- plugins/adf/scripts/lib/local-merge.mjs
- plugins/adf/scripts/lib/mr-links.mjs
- plugins/adf/scripts/lib/roles.mjs
-->

# The forge role

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`forge` is a role. The provider pushes the change branch and keeps the merge request of the change. The core never names a forge. The contract is in [the contract README](../../../../plugins/adf/contract/README.md#forge-role-since-11-push-since-12-ci-since-14-state-since-17-links-since-110).

| Operation | What it does |
|---|---|
| `check` | Reports whether the forge tool is ready. |
| `open` | Pushes the branch and opens a merge request into the base branch. It reuses an open one. |
| `push` | Pushes the branch. Nothing else changes. |
| `finalize` | Writes the description, takes the request out of draft, then pushes. |
| `state` | Reads the state of the merge request: `open`, `draft`, `merged` or `closed`. It sends nothing. |

The provider never forces a push. It refuses an empty branch and a protected branch.

`open`, `push` and `finalize` take an optional `ci` field. With `ci: false`, the provider asks the forge to start no pipeline. `/adf:archive --no-ci` sets it. A provider whose forge cannot skip CI refuses.

## The `links` input

Contract 1.10 adds the optional `links` input to `open` and `finalize`. The core builds it from the `scope.json` of the change. The agent never writes it.

- `links` lists the taken and partial scope items. Tracker items come first.
- A tracker link holds `kind`, `key`, `title` and `url`. The `url` is `null` when the tracker gave none.
- A debt link holds `kind`, `key`, `title`, `path` and `commit`. The `commit` is the merge base with `origin/<base>`. It is `null` when the entry is not in that commit.
- The provider writes one line per item at the top of the block of the change.
- A reused `open` changes no description.
- A change with no `scope.json`, or with no taken item, has no `links`.

The `forge.mjs` script refuses an input that already holds `links`. The core adds them to `open` and `finalize` when the call names a change.

A provider written for a contract below 1.10 does not take `links`. The core then puts the same lines at the top of `body` at `finalize`. For `open`, the core adds nothing, so the Draft of such a provider shows no links. In that case the lines hold no URL for a debt item, because the core builds no file URL.

## When it acts

| Stage | Operation |
|---|---|
| [/adf:propose](../../cycle/propose.md) | `open`: a draft merge request after the artifacts are committed. |
| [/adf:apply](../../cycle/apply.md) | `push`: after each group merge and after the suite record. |
| [/adf:archive](../../cycle/archive.md) | `finalize`: the `mr` step. |
| [/adf:retro](../../cycle/retro.md) | `open`, not a draft, with no CI run. |
| [/adf:land](tracker.md) | `state`: the check that the merge happened. |

`/adf:archive` calls `check` before `finalize`.

## With no provider

- Nothing is pushed. No merge request exists. Each report says so.
- `/adf:archive` offers to merge the change into its base branch. It merges only after your yes (the `merge-local` step).
- The local merge runs `git merge --no-ff <branch>` in the main checkout. The main checkout must be clean and have the base branch checked out. The branch stays. A failed merge is aborted.
- For `state`, the core decides "merged" from git. The branch tip must be an ancestor of the local base or of `origin/<base>`. Or a squash commit on the base has the patch id of the whole change. The core fetches nothing. See [the land command](tracker.md#the-land-command).

A provider that does not declare an operation is not called for it. The core applies the same default.

## Providers

| Plugin | Notes |
|---|---|
| [`adf-gitlab`](../../plugins/adf-gitlab.md) | Provides `check`, `open`, `push`, `finalize` and `state`. Its `hostFiles` entry copies a merge request template into `.gitlab/merge_request_templates/adf.md`. |
