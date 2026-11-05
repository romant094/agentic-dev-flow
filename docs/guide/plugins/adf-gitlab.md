<!-- sources:
- plugins/adf-gitlab/scripts/*.mjs
- plugins/adf-gitlab/scripts/lib/*.mjs
- plugins/adf-gitlab/adf-extension.json
- plugins/adf-gitlab/templates/**
-->

# `adf-gitlab`

`adf-gitlab` provides the `forge` role on GitLab, through the [`glab`](https://gitlab.com/gitlab-org/cli) CLI. The core calls it. You do not run it by hand, except to rerun a degraded `finalize`.

## What it does

| Operation | Does |
|---|---|
| `check` | Reports whether `glab` is installed and logged in. It gives the install or login command when it is not. |
| `open` | Pushes the change branch and opens a merge request into the base of the change, as a Draft by default. It reuses an open merge request for the branch. The first description is a placeholder inside the marker block of the change. It returns the number and the URL of the merge request. |
| `push` | Pushes the change branch and changes nothing else. It refuses when the root has another branch checked out, such as a group worktree. It needs only git, so it never degrades on `glab`. |
| `finalize` | Validates the description against the sections of the template. It merges the description into the existing one inside the marker block. It takes the merge request out of draft in the same call. Then it pushes the last commit. |
| `state` | Reads the merge request with `glab mr view <number\|branch> --output json` and writes nothing. |

Every push is `git push --set-upstream origin <branch>`. The plugin never forces a push.

The marker block of a change is `<!-- adf:<change> -->` ... `<!-- /adf:<change> -->`. The blocks of other changes stay as they are.

`finalize` also handles two special cases:

- A Draft with a `<!-- opsx:<change> -->` block of the same change and its placeholder sentence: the one `adf:` block replaces them. This happens once.
- No merge request: it pushes the branch and opens a ready merge request with the description.

### The state operation

The input is `{ change, branch, base, url? }`. The number in `url` wins over the branch, because the source branch may be deleted on merge.

It returns `number`, `url` and `status`: `open`, `draft`, `merged` or `closed`. It returns `mergedAt` and `mergeCommit` too. Both are `null` unless the merge request is merged. `mergeCommit` is `merge_commit_sha`, else `squash_commit_sha`. The operation refuses a failed call or unreadable JSON.

### Skip the pipeline

`open`, `push` and `finalize` take an optional `ci`. Its default is `true`. With `ci: false`, every push of the operation is `git push -o ci.skip ...`, so GitLab creates no pipeline for it. This is a push option. No title, description or commit message carries a skip marker.

### What it never does

The plugin never merges and never sets a reviewer, label or milestone. Integration is the developer's action. The target branch is always the base of the change.

### When `glab` is missing

When `glab` is missing or not logged in, every operation but `push` degrades. Nothing is pushed or sent. The result carries a `hint`, which is the install or login command. The `open`, `finalize` and `state` operations also carry a `fallback` to run later. `check` carries no `fallback`.

A degraded `finalize` saves its input to a file outside the repository. Its fallback reruns `finalize` on that file, so the merge with the blocks of other changes still happens.

## Install and enable

```
claude plugin install adf-gitlab@agentic-dev-flow --scope project
/adf:add adf-gitlab@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md).

`/adf:add` also copies the template `templates/merge_request.md` to `.gitlab/merge_request_templates/adf.md` when that file is missing.

## Configure

The `config` object of the entry in `.claude/adf-extensions.json`:

| Key | Default | Meaning |
|---|---|---|
| `host` | the host of the `origin` remote | The GitLab host named in the login hint, `glab auth login --hostname <host>`. A bare `glab auth login` authenticates gitlab.com. |
| `squash` | `true` | Create the merge request with squash on merge. |
| `removeSourceBranch` | `true` | Create the merge request with source branch removal on merge. |

## The merge request template

The plugin ships `templates/merge_request.md`, with the sections What, Why and QA. The installed copy gives the GitLab interface the same shape for a merge request that you open by hand.

`finalize` validates against the installed copy of the host when it exists. Otherwise it validates against the shipped copy. To change the required sections, edit the installed copy.

## CI: skip Draft merge requests

The flow pushes several times for each change. `finalize` relies on the host's CI skipping jobs on a merge request whose title marks it a Draft. It takes the merge request out of draft before the last push, so that push runs the full pipeline. Without such a rule, every push of a Draft runs the full pipeline.

A rule shared by the test and build jobs is recommended:

```yaml
.mr_rules_no_draft:
  rules:
    - if: '$CI_MERGE_REQUEST_TITLE =~ /^(\[Draft\]|\(Draft\)|Draft:|\[WIP\]|WIP:)/'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```

## Calling convention

The core runs `node <plugin>/scripts/forge.mjs <operation>` and writes one JSON object to stdin: `{ "root": "<host or worktree root>", "config": { ... }, "input": { ... } }`.

The plugin prints one JSON object. Its `state` is `done`, `degraded` or `refused`. A refusal carries `error`. The exit code is 0 for `done` and `degraded`, and 1 for `refused`.

`finalize --input-file <path>` reads the payload from a file instead of stdin.

## Points it provides

- [`forge`](../extension-points/contract/forge.md): the operations `check`, `open`, `push`, `finalize` and `state`.
