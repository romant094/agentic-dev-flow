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
- **#41, the type from what is known, never a silent default (reworked after the developer's
  review, 2026-11-20).** The first fix made the quick skill always pass `--type fix`. The
  developer rejected it, because a quick task can be a small patch and not only a bug fix.
  `suggest` takes the type from the first of these, and `typeFrom` names which one:
  1. the developer's `--type`, refused unless it is one of `COMMIT_TYPES`;
  2. the change name's prefix (the `TYPES` map);
  3. the tracker: `fix` when every taken or partial tracker item is of kind `bug`
     (`trackerType` in `lib/scope.mjs`). Another kind, a mix of kinds, or no tracker item taken
     gives no type. The contract's kind, not the Jira issue type name, is read, so every tracker
     plugin gets the same rule.

  With none of the three, `branch` stays null. `suggestedType` then carries the quick estimate's
  suggestion, and the skill asks the developer, showing that suggestion. The estimate reply gets
  an optional `type`, from `COMMIT_TYPES`. This is a one-line schema change, plus one prompt
  step. `estimatedType` reads it for the taken and partial items, and gives a type only when they
  agree on one. **The estimate only suggests: it never names the branch.** It is an agent's
  judgement, and the developer said that there is never a silent default. The tracker rule also
  applies to propose, since `suggest` is shared. A propose change usually has a prefix, which
  wins. `workspace.mjs` still refuses every flag that it does not read. Propose's skill, when
  `branch` is null, asks for the type and runs `suggest` again with `--type`.
- **#42, the workflow decides (reworked after the developer's review, 2026-11-20).** The first
  fix took every issue that was not the developer's before its transition. The developer
  rejected it: some Jira setups let anyone move the status, and the take then changes the issue
  for no reason. Now `handoff` asks Jira what the developer may run, for an item that moves to
  the tester (`taken` or `not-reproduced`) and has a route:
  `GET /rest/api/2/issue/{key}/transitions?expand=transitions.fields`. Jira applies the
  workflow's conditions for the calling user there.
  - The route's first transition is offered: no take. The rows are transition, comment, tester.
  - It is not offered, and the issue is not the developer's (unassigned included): the plan
    takes it first. The rows are developer, transition, comment, tester.
  - It is not offered, and the issue is already the developer's: the issue is skipped at plan
    time, with a reason that names the transition and the status.
  - The offered transition's screen requires a field that the step does not fill: the issue is
    skipped, with a reason that names the field. A field with `hasDefaultValue` is not counted,
    since Jira fills it. **There is no exception for the assignee.** `route` already refuses a
    hop whose discovered screen requires any field, the assignee included. The plugin never fills
    a required field on its own, and a transition that writes the assignee would be a new kind of
    write.
  - **Plan time and apply time.** The plan reads the first hop only: the issue is not yet at the
    later hops' statuses. The read is read-only, so the held preview shows the real rows. Each
    transition step of such an item carries `check`, its `name` and the status it leaves (`from`).
    Before each such step, apply reads the transitions again and fails the row when the
    transition is not offered or a required field is missing. This covers a hop after the first,
    an issue changed between the hold and the yes, and a take that did not unlock the transition.
    Apply never adds a row the held plan does not state. A failed row leaves only the writes
    before it (the take, an earlier hop). The rows after it drift-skip, and the result names the
    transition and the status. Plans held before this change have no `check` and run as before.
  - A `partial` item keeps its rows: it goes back without a take, and stays with its assignee.
  - The land hand-off of a debt-group issue, never started, follows the same rule. The
    unconditional take that the first fix gave it is gone.
  - Option 2 of the issue (a separate retest `purpose`) is not taken: the rule holds for every
    hand-off.

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
| 3 | #41: `suggest --type`, the type from the name, then the tracker, the estimate's suggested type, the refused unknown flag, the quick and propose skills, the worktrees and quick pages | `workspace.spec.mjs`, `scope.spec.mjs`, `quick.spec.mjs` |
| 4 | #42: the hand-off asks Jira which transitions it offers, at plan time and again before each transition at apply; it takes the issue first only when that unlocks the transition; the preview; the adf-jira page | `tracker.spec.mjs`, `tracker-plugins.spec.mjs` |
| 5 | `npm test` after every step | the counts in `## Result` |

## Result

- **#39.** `quick.mjs estimate-check` writes a quick correction as `{ what: '', was: '', now }`.
  `renderCorrection` (`adf-jira`) and the scope note (`noteOf`, core) print a correction with no
  subject, or with a subject equal to the correction, once: `# The anchor moved to b.ts:49.`. A
  full correction keeps `what: now (was was)`. The correction template's preface, the adf-jira
  page and the quick page say so. Tests: `comment.spec.mjs` (`renderCorrection`, two cases),
  `scope.spec.mjs` (render names a correction once), `quick.spec.mjs` (the recorded shape).
- **#40.** `quick.mjs filter` counts a debt entry whose `tracker` is a named key as named: it is
  never excluded, and its first flag is `<id> mirrors <KEY>, a key you named; take it with
  <KEY>`. A large mirror also gets the too-large flag. The quick skill's step 4 takes a flagged
  mirror together with its key; the quick page says so. Test: `quick.spec.mjs` (filter keeps the
  mirror and flags it, once on a rerun).
- **#41.** `suggest` takes the type from `--type`, then from the name prefix, then from the
  tracker (`fix` when every taken tracker item is a bug), and reports `typeFrom`. For a
  key-only quick change whose taken issue is a bug, `suggest --change proj-1` gives
  `fix/PROJ-1/proj-1`. With no type, `branch` is null. `suggestedType` then carries the quick
  estimate's optional `type`, when the taken items agree on one. The quick skill no longer
  passes a type: it asks the developer when `branch` is null, and shows the suggestion.
  `workspace.mjs` refuses every flag that no command reads. Tests:
  - `workspace.spec.mjs`: the order given, then name, then tracker; the suggestion only when no
    type is known; the command line reading the scope and the estimate; `--type`; an unknown flag.
  - `scope.spec.mjs`: `trackerType`.
  - `quick.spec.mjs`: the estimate's `type` checked against the schema, and `estimatedType`.
- **#42.** `adf-jira` `handoff` reads `transitions?expand=transitions.fields` for each issue
  that moves to the tester. When Jira offers the first transition, the rows are as before:
  transition, comment, tester. When Jira does not offer it and the issue is not the developer's,
  the developer is assigned first, and the preview shows `assignee <developer> first`. An issue
  already the developer's whose transition is not offered is skipped, and the reason names the
  transition and the status. A transition whose screen requires a field the step does not fill
  is skipped, and the reason names the field. Apply asks Jira again before each checked
  transition. It fails the row, naming the transition and the status, or the field, and sends
  nothing more for that issue. The fake Jira answers `GET .../transitions` and applies `offers`
  (`assignee`, `none`) and `screens`. Tests in `tracker.spec.mjs`:
  - offered, so no take;
  - offered to the assignee only, so take, then move;
  - offered to no one, so the take, then a failure that names "Start Progress" and "Opened";
  - the developer's own issue not offered, so it is skipped;
  - a required field, skipped at plan time and failed at apply time on the second hop.

  The first test's row list and `tracker-plugins.spec.mjs` (the debt-group land hand-off) are
  back to the rows they had before the first fix.

Checks: `npm test` before the first change, 1834 tests, 1829 passed, 0 failed, 5 skipped; after
each fix commit green; after the first four fixes, 1841 tests, 1836 passed, 0 failed, 5
skipped; after the #42 rework, 1845 tests, 1840 passed; after the #41 rework, 1849 tests, 1844
passed, 0 failed, 5 skipped.
`check-guide.mjs` passed inside each run.

Nothing is left open.
