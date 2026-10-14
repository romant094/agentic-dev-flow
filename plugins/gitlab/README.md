# GitLab forge for the Agentic Dev Flow

This plugin provides the `forge` role of the ADF extension contract (version 1.1) on GitLab,
through the [`glab`](https://gitlab.com/gitlab-org/cli) CLI. The ADF core calls it; you do not
run it by hand, except to rerun a degraded `finalize`.

## What it does

| Operation | Does |
|---|---|
| `check` | Reports whether `glab` is installed and logged in, with the install or login command when it is not. |
| `open` | Pushes the change branch (`git push --set-upstream origin <branch>`, never forced) and opens a merge request into the change's base, as a Draft by default. An open merge request for the branch is reused. The first description is a placeholder inside the change's marker block. Returns the merge request's number and URL. |
| `finalize` | Validates the description against the template's sections, merges it into the existing description inside the change's marker block (`<!-- adf:<change> -->` ... `<!-- /adf:<change> -->`), takes the merge request out of draft in the same call, and only then pushes the last commit. When no merge request exists, it pushes the branch and opens a ready one with the description. |

The plugin never merges and never sets a reviewer, label or milestone: integration is the
developer's action. The target branch is always the change's base; nothing is hard-coded.

When `glab` is missing or not logged in, every operation degrades: nothing is pushed or sent,
and the result carries a `hint` (the install or login command) and a `fallback` to run later.
A degraded `finalize` saves its input to a file outside the repository and its fallback reruns
`finalize` on that file, so the merge with other changes' blocks still happens.

## Calling convention

The core runs `node <plugin>/scripts/forge.mjs <operation>` and writes one JSON object to stdin:
`{ "root": "<host or worktree root>", "config": { ... }, "input": { ... } }`. The plugin prints
one JSON object with `state` set to `done`, `degraded` or `refused` (with `error`). The exit code
is 0 for `done` and `degraded`, 1 for `refused`. `finalize --input-file <path>` reads the
payload from a file instead of stdin.

## Configuration

The `config` object of this plugin's entry in `.claude/adf-extensions.json`:

| Key | Default | Meaning |
|---|---|---|
| `host` | the host of the `origin` remote | The GitLab host named in the login hint, `glab auth login --hostname <host>`. A bare `glab auth login` authenticates gitlab.com. |
| `squash` | `true` | Create the merge request with squash on merge. |
| `removeSourceBranch` | `true` | Create the merge request with source branch removal on merge. |

## The merge request template

The plugin ships `templates/merge_request.md` (sections What, Why and QA). `/adf:add` copies it
to `.gitlab/merge_request_templates/adf.md` when that file is missing, so the GitLab interface
offers the same shape to a merge request opened by hand. `finalize` validates against the
host's installed copy when it exists, else against the shipped one: edit the installed copy to
change the required sections.

## CI: skip Draft merge requests

The flow pushes several times per change. `finalize` relies on the host's CI skipping jobs on
a merge request whose title marks it a Draft: it takes the merge request out of draft before
the last push, so that push runs the full pipeline. Without such a rule, every push of a Draft
runs the full pipeline. A rule like this, shared by the test and build jobs, is recommended:

```yaml
.mr_rules_no_draft:
  rules:
    - if: '$CI_MERGE_REQUEST_TITLE =~ /^(\[Draft\]|\(Draft\)|Draft:|\[WIP\]|WIP:)/'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
```
