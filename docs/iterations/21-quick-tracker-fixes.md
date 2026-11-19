# Iteration 21 — Quick and tracker fixes

## Goal

Fix the four defects that the origin project's quick changes found on adf 0.21.0 and
adf-jira 0.6.0: the start comment repeats a correction (#39), the quick filter drops the debt
entry that mirrors a named tracker key (#40), `workspace.mjs suggest` gives no branch for a
key-only quick change and ignores `--type` (#41), and a retest fails on an issue that is
assigned to someone else (#42).

## Intent

Each issue names its cause and the expected behaviour. The fixes are small and each stays in
the module that the issue names. No fix changes the contract: the tracker's `start` and
`handoff` inputs stay as they are, and only the rows that `adf-jira` plans change.

## What exists (checked 2026-11-19 against 5328c4f)

- `plugins/adf/scripts/lib/quick.mjs:171`: `estimate-check` turns each string correction into
  `{ what: c, was: '', now: c }`. `plugins/adf-jira/scripts/lib/comment.mjs:154`
  (`renderCorrection`) prints `what: now`, so the line is `X: X`. The core's scope note
  (`plugins/adf/scripts/lib/scope.mjs:766`, `noteOf`) prints `corrected: X, now X` for the same
  record.
- `plugins/adf/scripts/lib/quick.mjs:65-70` (`largeReason`) gives `class <class>` for every debt
  entry that is not a defect. `filter` (`:83-99`) protects only `scope.from.keys`. A debt entry's
  key is its debt id, so its `tracker` field is never compared with the named keys.
- `plugins/adf/scripts/lib/workspace.mjs:19-28` maps only the name prefixes `add-`, `fix-`,
  `restructure-` and `refactor-` to a type; `suggest` (`:59-79`) gives `branch: null` for any
  other name. `plugins/adf/scripts/workspace.mjs` (`run`) reads only the flags it asks for; an
  unknown flag stays in `args` and is not refused. `plugins/adf/scripts/lib/roles.mjs:122` holds
  the Conventional Commits types, `COMMIT_TYPES`.
- `plugins/adf-jira/scripts/lib/tracker.mjs:519-532` (`issueRows`) orders a hand-off's rows as
  transition, comment, assignee; only `start` (`takeFirst`) assigns the developer first. The
  core's `retest` (`plugins/adf/scripts/lib/scope.mjs:890-910`) calls `handoff` on an issue that
  `start` never took.

## Calls made by the designer, not the developer

- **#39, both ends.** `estimate-check` writes a string correction as `{ what: '', was: '', now:
  c }`: the quick estimate has no separate subject. `renderCorrection` and the core's `noteOf`
  print only `now` (and `was`, when given) when `what` is empty or equal to `now`. The second
  rule also fixes the scopes already recorded with `what` equal to `now`, so a change in flight
  needs no migration. The quick estimate schema keeps its strings (option 2 of the issue is not
  taken): the estimate is meant to be short, and the full check's sources are not needed there.
- **#40, kept and flagged, not taken by the script.** `filter` treats a debt entry whose
  `tracker` is a named key as named: it never excludes it. It gets one flag line that names the
  key it mirrors (`<id> mirrors <KEY>; take it with <KEY>`), and, when it is also large, the
  usual too-large flag. The estimate reads the flags. The developer still takes it with
  `scope.mjs select`; the quick skill's step 4 says to take a mirror together with its tracker
  item. An automatic take in `select` would change the full propose path too, and at `filter`
  nothing is taken yet, so the script cannot know that the tracker item will be taken.
- **#41, all three options.** `suggest` takes `--type <type>`, refused unless it is one of
  `COMMIT_TYPES`. A given type wins over the name prefix. The quick skill always passes `--type
  fix`: a quick task restores specified behaviour, and the developer confirms the branch name
  in the same question. Propose's skill, when `branch` is null, asks for the type and runs
  `suggest` again with `--type`. `workspace.mjs` refuses every flag it did not read, for every
  command. The schema of the change cannot set the type: `suggest` runs before `propose.mjs
  create --schema quick` makes the change.
- **#42, option 1, the moving items only.** In `handoff`, an item that moves to the tester
  (`taken` or `not-reproduced`) and has a transition to make gets a leading assignee row to the
  developer (`<JIRA_ASSIGNEE>`) when its assignee is not the developer, as `start` does. The
  trailing row to the tester stays. A land hand-off of an issue that `start` took is unchanged.
  A `partial` item keeps its rows: it stays with its assignee, and it was taken at start. An
  unassigned issue counts as not the developer's, as at `start`. The preview names both
  assignees: `assignee <developer> first; <route>; assignee <tester>`.

## Non-goals

- A `{ what, was, now }` shape for the quick estimate (#39, option 2).
- An automatic take of a mirror debt entry in `scope.mjs select` (#40, option 2).
- A new `purpose` for the retest plan (#42, option 2).
- `CHANGELOG.md` and the version bump: the release writes them.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | #39: the string correction has no `what`; the renderer and the scope note print a correction once | `comment.spec.mjs`, `quick.spec.mjs`, `scope.spec.mjs` |
| 2 | #40: `filter` keeps and flags a debt entry whose Tracker key is named; the quick skill and its guide page | `quick.spec.mjs` |
| 3 | #41: `suggest --type`, the refused unknown flag, the quick and propose skills, the worktrees page | `workspace.spec.mjs` |
| 4 | #42: the leading developer row in a hand-off of an issue that is not the developer's; the preview; the adf-jira page | `tracker.spec.mjs` |
| 5 | `npm test` after every step | the counts in `## Result` |
