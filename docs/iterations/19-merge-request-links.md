# Iteration 19 — Merge request links

## Goal

Every merge request the flow opens starts with links to what the change took: each tracker issue
and each technical debt entry of its scope. The flow writes them itself, from the change's
`scope.json`, so a host project needs no CI job of its own for it.

## Intent

In the origin project a CI job, `jira_link_mr` (`.gitlab-ci.yml`, stage `jira-link`, script
`infra/gitlab/jira-link.sh`), puts one line at the top of the description:
`Jira issue: [KEY](<jira>/browse/KEY)`. It reads one key, from the branch name, so a merge
request that takes several issues or debt entries links only one of them, and a branch without
a key links nothing. It also needs a GitLab token in CI and knows the Jira address. The flow
already knows the whole scope.

## Settled by the developer (2026-11-05)

1. The description starts with links to every tracker issue and every debt entry the change took.
2. The tracker gives each issue's link. With no tracker plugin, the tracker links are left out and
   only the debt entries are listed.
3. The flow writes them, not CI. After the release, the origin project removes `jira_link_mr`.
4. Before the quick task (iteration 20), so that the quick task gets the links.

## What exists (checked 2026-11-05)

- `scope.json` keeps each taken tracker item's `url` from the tracker's `gather`
  (`lib/scope.mjs:210`, `:596`) and each debt item's `block` and `files`, the first being its
  block's `index.md` (`lib/scope.mjs:243-253`).
- The forge role's `open` takes no description: the GitLab provider writes a placeholder block
  `<!-- adf:<change> -->` (`adf-gitlab/scripts/lib/forge.mjs:165`). `finalize` takes `body`, the
  sections of the plugin's template, written into the change's block at archive.
- Archive refuses a body that does not name every key of the scope (`lib/archive.mjs:813`), so
  the agent writing the body repeats every key by hand today.

## Calls made by the designer, not the developer

- **Links are data, rendered by the forge provider.** A new optional input `links` of the forge
  operations `open` and `finalize` (contract 1.10): a list of `{ kind, key, title, url }`, `kind`
  `tracker` or `debt`. The core builds it by script from `scope.json` (taken and partial items,
  in the scope's order, tracker items first); the agent never writes it. The provider renders it
  at the top of the change's block, before the template's sections, one line per item. `open`
  writes them when it creates the merge request; a reused `open` still touches no description
  (`adf-gitlab/scripts/lib/forge.mjs:260`), and `finalize` writes them again with the body.
- **Tracker links** are the item's `url`. An item with no `url` is listed as its key and title
  with no link.
- **Debt links** point to the entry's block index as it was when the change took it: the core
  passes the path (`files[0]`) and the commit `git merge-base HEAD origin/<base>`, the one the
  forge holds; the provider makes the forge's permanent file URL for that commit, so the link
  does not break when archive later moves the entry to `resolved.md` or the branch is deleted.
  Gather reads the debt tree from the working tree (`lib/scope.mjs:232`), so the entry may not be
  in that commit: the core checks it with `git cat-file -e <commit>:<path>` and, when it is
  absent, passes no commit, and the entry is listed as its id and title. A provider that cannot
  make a file URL does the same.
- **From the first push.** `forge.mjs open --change` builds `links` from the change's `scope.json`
  when it has one, so propose and the quick task pass them with no step of their own and the
  Draft shows them from the start, as the CI job did. Calls without a change (update, retro) pass
  none.
- **The key check at archive** stays as a guard and counts the keys the links name, so the agent
  no longer repeats them in the body; `mr-input` and the archive skill stop asking for them. Since
  the links come from the same scope, the check fires only when the links could not be built.
- **No scope, no links.** A change with no `scope.json`, or none taken, gets no links section.
- **A provider written before 1.10** ignores `links`. The core knows it from the provider's
  registry declaration (`contract` below 1.10) and then puts the same lines at the top of `body`
  at `finalize`, so the links reach the description at archive at the latest.
- **One release.** `adf` and `adf-gitlab` go out in one package release (iteration 16: one package
  version), `adf-gitlab` declaring contract 1.10.
- **The transition in the origin project.** The CI script adds its line only when the description
  does not hold the key yet (`jira-link.sh`), so while both run there is no duplicate. After the
  release, the project's owner removes the job, its `jira-link` stage and the script in the update
  merge request; the guide's update page says so.

## Non-goals

- Links to anything outside the scope (other merge requests, specs, the change's files).
- Updating the tracker issue with a link back to the merge request (the hand-off at land does it).
- Editing a host's CI configuration from the flow.

## Depends on

- Iteration 13: `scope.json`, the tracker's `gather` with `url`.
- Iteration 05: the forge role and the GitLab provider.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Contract 1.10: the forge `open` and `finalize` input `links`; `extensions.mjs` and the contract's README | contract tests |
| 2 | The core builds `links` from `scope.json` (tracker url, debt path and merge base) and passes it at propose's `open` and archive's `finalize`; the archive key check counts the links; the fallback into `body` for an older provider | `scope.spec.mjs`, `archive.spec.mjs`, `propose.spec.mjs` |
| 3 | `adf-gitlab`: render `links` at the top of the change's block in `open` and `finalize`, the permanent file URL of a debt entry, the merge with an existing description kept | `adf-gitlab` forge tests on recorded `glab` replies |
| 4 | The guide: the merge request section of the GitLab plugin page and the cycle pages; the update page names the removal of a host CI job that did the same | `check-guide.mjs` |
| 5 | One real merge request on a test GitLab project, with a tracker item and a debt entry, and one with debt only | the run's notes in the `## Result` |
