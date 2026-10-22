# Iteration 13 — Tracker plugin: Jira

## Goal

The origin's Jira plugin moves into the published plugin `adf-jira` with its behaviour unchanged,
and it provides a new `tracker` role the core calls at propose and after the merge. Propose
starts from a tracker key or from a phrase. Whatever the start, the core gathers what can be
done in the same change: the technical debt always, and the tracker when a provider is enabled.
The developer approves the scope. Each taken issue is checked by an agent that settles what it
can itself and asks only what it cannot. The taken issues move to In Progress. After the merge,
`/adf:land` writes one templated comment per issue (what was done, how to test it, the merge
request link when a forge is enabled) and hands each issue to the tester. With no tracker
provider every tracker step is skipped and reported. Every tracker write goes through the
core's two-phase hold.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Contract 1.7: the `tracker` role (`check`, `gather`, `start`, `handoff`) and the `forge` operation `state`; validation by operation version: a provider implements the operations of its declared contract version, and a later operation it lacks is `none` | `contract.spec.mjs`, `registry.spec.mjs`: a 1.6 forge declaration without `state` stays valid; a call of a missing later operation is `none` |
| 2 | `adf-gitlab` `state` through `glab mr view --output json`: `open`, `draft`, `merged`, `closed`, with `mergedAt` and `mergeCommit` | `forge.spec.mjs` with a fake `run`, by url and by branch |
| 3 | `lib/roles.mjs` tracker report: the "skipped" lines with no provider, an absent entry named, the hold shape (`held`, `plan`, `preview`) | `roles.spec.mjs` with a fixture tracker |
| 4 | `scope.mjs`: `gather` (a key list or a text; the tracker when enabled, the debt store always, the in-flight changes holding the same key), `select` (take, partial, exclude, each non-taken with a reason), `check-input`, `check` (the reply), `answer`, `render`, `start`, `retest`; `scope-check.schema.json`; state in `<main>/.superpowers/sdd/<change>/`; the issues' comments are always read | `scope.spec.mjs`: every refusal of the check, a skipped tracker, a stale status flagged once, a change found by key, a phrase with no tracker gathering only debt |
| 5 | The issue check: one read-only `scope-check <KEY>` dispatch per taken or partial issue, input by script. The agent states the requirements (for a bug: reproduction, expected, actual), checks them against the code, specs, memory, linked issues, comments, git history and the live system where allowed, settles what it can, and asks only the rest, each question with what it checked and what it needs. Verdicts `current`, `corrected`, `needs-developer`, `obsolete`, `not-reproduced`. A script refuses a correction without a source, a question without `checked` or `needs`, a bug with no reproduction and no question about it. All questions go to the developer in one message | `scope.spec.mjs` |
| 6 | A bug that does not reproduce is not closed: it leaves the change's scope, and `scope.mjs retest` sends it through `tracker.handoff` with state `not-reproduced`: the templated comment says it does not reproduce, what was tried and on which commit, and the issue goes to the tester for a retest. Held for the developer's yes | `scope.spec.mjs` |
| 7 | Propose: the gather, select, check and retest steps before the branch; the branch `<type>/<KEY>/<change>` from the key with the lowest rank, confirmed by the developer; `start` (In Progress) after the branch and worktree, held; `scope.json` copied into the change and committed with the artifacts; the proposal's `## Scope sources` rendered by script and checked by a gate | `propose.spec.mjs`, `workspace.spec.mjs` |
| 8 | Verify: the tasks check fails a taken or partial key that no `tasks.md` item names; a skipped tracker passes with a note | `verify.spec.mjs` |
| 9 | Archive: the `mr` step refuses a body that does not name every in-scope key; the report names `/adf:land <change>` when the scope holds tracker items | `archive.spec.mjs` |
| 10 | `land.mjs` and `/adf:land`: `check`, `wait` (`forge.state`, or git ancestry with no forge; `closed` stops), `comment-input`, `comment` (the agent's fields, checked by script), `handoff` (held), `report`; state in `<main>/.superpowers/sdd/<change>/land/`, resumable; never merges or pushes | `land.spec.mjs`: resume after each step, a closed merge request, the field limits, no link with no forge |
| 11 | The hand-off comment is a template rendered by script. The agent writes fields only (`done`, `test`, `remains`, or for a retest `tried`); the core checks them (word limits, no link or URL in agent text, every key complete); the plugin renders its template with the fields and the merge request link, which the core passes from the forge and which is absent with no forge. The default template ships in the plugin; `config.commentTemplate` names a host file that replaces it | `adf-jira` render tests; `land.spec.mjs` |
| 12 | `debt.mjs track --id --key` writes an entry's `Tracker` cell | `debt.spec.mjs` |
| 13 | Plugin `plugins/adf-jira/`: every skill and script of the origin's plugin ported to `.mjs` with its behaviour; `scripts/tracker.mjs` with the four operations over the existing engine; `check` probes `/myself` and reports `missing`, `unauthenticated` or `unconfigured` with a hint, never a value; the scripts read their env file themselves; `JIRA_PM` and `JIRA_QA` resolved inside the apply process; project values in `config` (URL, allowlist, `profileDir`, `debtEpic`, `commentTemplate`); setup refuses a profile file git does not ignore; `env.example` with neutral placeholders; README | the origin's eight jest suites ported to `node:test`; a fake `fetch` for every operation |
| 14 | Trigger phrases: every skill and command trigger is written in English, with the note that a trigger may come in any language; the rule stated once for every plugin | a test over every `SKILL.md` and command of the repository |
| 15 | Parity tools, offline: path solving, the allowlist, plan rendering, env parsing and the readers' rows against the origin's TypeScript | `npm run parity -- <origin>`, no network |
| 16 | Lessons rows pending on 13; the xnms inputs for iteration 15 (registry `config`, the profile location, the `Tracker` column, conventions sections); versions adf 0.14.0, contract 1.7, adf-gitlab 0.5.0, adf-jira 0.1.0; marketplace; roadmap rows 13 and 17 | `check-lessons.mjs`, `npm test`, `npm run parity -- <origin>`, `claude plugin validate .` |

## Contract 1.7

| Operation | Caller and moment | Input | Result when `done` |
|---|---|---|---|
| `tracker.check` | `scope.mjs gather` and `land.mjs`, before any other tracker call | `{}` | `tool: "ready"`, `account`; `degraded` with `tool` `missing`, `unauthenticated` or `unconfigured` and `hint` |
| `tracker.gather` | propose, in the main checkout | `keys` or `text`, `change`, `stateDir` | `items` (key, url, kind, title, status, open, parent, links, branch token and rank, flags, the file holding description, comments and fields), `notes` |
| `tracker.start` | propose, after the branch and worktree; held | `items`, `stateDir`, `apply` | without `apply`: `held`, `plan`, `preview`; with it: `applied`, `skipped`, `failed` per key |
| `tracker.handoff` | `/adf:land` after the merge, and `scope.mjs retest`; held | `items: [{ key, state: "taken" \| "partial" \| "not-reproduced", fields }]`, `mr: { url } \| null`, `stateDir`, `apply` | as `start`; `taken` and `not-reproduced`: comment, the hand-off status, the tester; `partial`: the comment only |
| `forge.state` | `land.mjs wait` | `change`, `branch`, `base`, `url` | `number`, `url`, `status`, `mergedAt`, `mergeCommit` |

With no tracker provider the role is `none`: `gather` returns no tracker items, and `start`,
`handoff` and the verify key check are skipped with a line that says so. A developer may skip
the tracker for one change after a `degraded` check; the scope records it once.

## Decisions

Settled by the developer on 2026-10-21. Analysis: the iteration 13 analysis of 2026-10-21.

- The origin's plugin is ported as it is; the flow integration is new.
- No tracker provider: every tracker step is skipped and reported.
- Propose starts from a key or a phrase. The debt store is always searched, and the tracker
  when enabled, for what fits the same change.
- The issue check: the agent's own attempt first, the developer's question second.
- The issues' comments are always read.
- A bug that does not reproduce is not closed: a comment says so, and it goes to the tester for
  a retest.
- The workflow scheme is local to each developer and never committed.
- The hand-off comment is always one shape: a template rendered by script, the default in the
  plugin, replaceable by the host; the merge request link when a forge is enabled.
- D1 A `tracker` role, not the roadmap's hooks `context-source`, `on-start`, `post-merge`.
- D2 Validation by operation version; `adf-gitlab` also gains `state`.
- D3 "Finished" means after the merge: `/adf:land`.
- D4 Land is a command with script state, resumable.
- D5 In Progress after the branch and worktree exist, held for the yes.
- D6 One read-only dispatch per issue, a JSON reply checked by script.
- D7 Corrections are recorded in `scope.json` and may also go to the issue as a comment in the
  `start` plan.
- D8 `scope.json` committed; the proposal table rendered from it and checked by a gate.
- D9 Non-secret values in registry `config`; the token and personal logins, `JIRA_QA`
  included, in the env file.
- D10 No env guard: reading the env file is allowed; the plugin's scripts read it themselves.
- D11 The plugin is `.mjs` on Node 20.
- D12 `config.profileDir`, default `.claude/jira/profile`, with a gitignore check.
- D13 `debt.mjs track` writes the `Tracker` cell.
- D14 No `Analysis` column: body files linked from the row.
- D15 Archive's `mr` step checks that the body names every in-scope key.
- D16 Every trigger is written in English with the note that it may come in any language; the
  rule holds for every plugin and every future trigger.
- D17 The comment's content is fields; the template and the markup are the plugin's.
- D18 A partial issue at land gets a comment of what remains and keeps its status.
- D19 Land with no forge decides "merged" from git ancestry.
- D20 Skipping the tracker for one change is recorded once in `scope.json`.

## Inputs for iteration 15

The origin project's values for `adf-jira`, recorded here for the switch. They are the only
place this repository names the origin's Jira; no plugin file carries them.

The registry entry, `.claude/adf-extensions.json`:

```json
{
  "id": "adf-jira@agentic-dev-flow",
  "config": {
    "baseUrl": "https://jira.promwad.com",
    "allowlist": ["DESTELENG"],
    "profileDir": ".claude/jira/profile",
    "debtEpic": "DESTELENG-399",
    "statuses": { "start": "In Progress", "handoff": "Review", "excluded": ["Suspended"] },
    "fields": ["Reproduce steps", "Expected result"]
  }
}
```

- `commentTemplate` and `correctionTemplate`: none. The origin has no hand-off comment
  template of its own, so the plugin's `templates/handoff.md` and `templates/corrections.md`
  apply; a host copy is made only if the team asks for another shape.
- `envFile`: not set; the default `.claude/.env` is the origin's file.
- The profile stays where it is, `.claude/jira/profile/`, the default `profileDir`:
  `conventions.md` committed, `discovered.json` and `local.md` ignored by the origin's
  `.gitignore` (checked on 2026-10-21 with `git check-ignore -v`). Run `/adf-jira:setup` once
  after the switch, which refuses to write while git does not ignore the personal files.
- The env keys each developer sets in `.claude/.env` (names only): `JIRA_PAT`,
  `JIRA_ASSIGNEE`, `JIRA_QA`, `JIRA_PM`, `JIRA_GIT_AUTHOR`, `JIRA_DEFAULT_PROJECT`. With
  `baseUrl` and `allowlist` in the registry, `JIRA_URL` and `JIRA_ALLOWED_PROJECTS` in the env
  file are no longer read and may be removed.
- The debt tree: the header of every `.claude/memory/tech-debt/*/index.md` (eight on
  2026-10-21) is `| ID | Title | Anchors | Class | Source | Jira |`; its last column becomes
  `Tracker`, the column `debt.mjs` checks and `track` writes (`docs/lessons/memory.md`).
- The project facts the origin's skills carried are no longer in the port's skills, which read
  them from `conventions.md` or from `config`:
  - the epic model (children are `Sub-task` issues with `parent`, `Epic Link` unused, a
    sub-task allowed directly under an epic on this instance; `epic` and `task` step 1):
    already in the origin's `conventions.md`, `## Work structure`;
  - the estimate through `timetracking` on the child, never on the epic (`epic`): already in
    `## Estimation`;
  - the debt epic `DESTELENG-399`, "Tech Debt", and its children's model (`sync-debt`): now
    `config.debtEpic`; the model is `## Work structure`;
  - the required fields per type (a `Bug` requires `Reproduce steps` and `Expected result`; a
    `ProjectInfo` requires `ProjectStatus`, `ProjectEstimate(Plan)`, `ProjectType`; `task`):
    read from `discovered.json`'s `requiredFields`, no longer from the skill;
  - `## Review hand-off` in `conventions.md` says the hop to `Review` and the reassignment are
    "two steps of one row"; since 9829c1f each is its own row. Reword it at the switch.
- The origin's old plans in `.claude-reports/jira/` (85 plan files at the top level and the
  directory `epic-performance-stability/` on 2026-10-21) do not migrate: the port writes its
  plans in `.adf/jira/<skill>/`, and `apply-plan.mjs` would refuse an old plan built against an
  older profile anyway. They stay where they are, gitignored. `customer/created-issues.md` is
  not a plan and stays too.
- The origin's own plugin `.claude/plugins/jira/` and its `jira:*` skills are removed when
  `adf-jira` is enabled, so the two skill sets do not trigger on the same phrases.

## Result

Commits (`git log --oneline 5721643^..HEAD`, before this release step):

```
ebb231e test(adf): triggers in English with the any-language note, checked in every plugin
0b6be81 test(parity): compare the adf-jira port with the origin's Jira plugin offline
baaf592 feat(adf-jira): plans in .adf/jira/<skill>/, ignored by default
9829c1f fix(adf-jira): resumable tracker writes, correction comment at start, git author
3e20a37 feat(adf): land command, archive scope key check and hand-off fields
19ac51e feat(adf-jira): port the Jira plugin and provide the tracker role
159c4a9 feat(adf-gitlab): forge state operation for contract 1.7
d2e4184 feat(adf): contract 1.7 tracker role, propose scope gathering and issue check
5721643 docs(iterations): plan iteration 13, tracker plugin Jira
```

Shipped, by step:

- 1–9 (d2e4184, 3e20a37): contract 1.7 with the `tracker` role and `forge.state`, a
  declaration validated against its own contract version; the roles' tracker report;
  `scope.mjs` with `gather`, `select`, `check-input`, `check`, `answer`, `render`, `start` and
  `retest`, and `scope-check.schema.json`; propose's scope steps before the branch, the branch
  key, the held start, `scope.json` committed and `## Scope sources` rendered and gated;
  verify's key check; archive's `mr` key check and the `/adf:land` hint.
- 2 (159c4a9): `adf-gitlab` `state` through `glab mr view`, by url and by branch.
- 10–12 (3e20a37): `land.mjs` and `/adf:land`, resumable, never merging or pushing; the
  hand-off fields checked by the core and rendered by the plugin; `debt.mjs track`.
- 13 (19ac51e, 9829c1f, baaf592): `adf-jira`, every skill and script of the origin's plugin
  ported to `.mjs`, its eight suites on `node:test`, `tracker.mjs` with the four operations.
- 14 (ebb231e): every trigger in English with the any-language note, checked by
  `plugins/adf/scripts/__tests__/triggers.spec.mjs` over every plugin.
- 15 (0b6be81): `scripts/parity/origin-jira.mjs`, offline against the origin's TypeScript.
- 16 (this step): the lessons rows pending on 13 closed, the inputs for iteration 15 above,
  versions, marketplace, README and roadmap.

Decided after the plan:

- `start` and `handoff` write one plan row per step (`transition`, `assignee`, `comment`), so
  a rerun of the same plan sends only the rows not yet done; a comment row posts nothing when
  the issue already holds a comment with the same body.
- `start` gives an item a templated correction comment when the issue check corrected it: by
  the verdict `corrected` with its corrections, or by the developer's answers; the core sends
  each item's verdict. An item with no correction gets no comment.
- The standalone skills' plans go to `.adf/jira/<skill>/` in the main checkout, and
  `apply-plan.mjs` refuses a plan git does not ignore. `/adf:init` ignores `.adf/*` and
  re-includes `.adf/prices/` and `.adf/retro/`, so a plugin's local work directory under `.adf/`
  is ignored by default.
- A stale status: an excluded issue whose latest comment is newer than its move into its
  status is flagged once, with both dates; the exclusion still holds.
- An item's `kind` is one of a fixed set, `bug`, `sub-task`, `epic`, `story`, `task`, named in
  the contract.
- `JIRA_GIT_AUTHOR` reaches the worklog skill through `profile.mjs` (`gitAuthor`), which reads
  the env file for that one value; the agent still never reads the env file.
- `land.mjs wait` reads `forge.state`, or git ancestry when no forge is enabled or the forge
  does not provide `state`; a closed merge request stops land.
- The hand-off field limits: `done` 80 words, `test` 120, `remains` 80, `tried` 80
  (`FIELD_LIMITS` in `plugins/adf/scripts/lib/tracker.mjs`).

Checks, on 2026-10-21:

- `npm test`: 1320 tests, 1318 pass, 0 failures, 2 skipped (the live openspec parity with
  `OPENSPEC_DIST` not set, and the live origin name parity of `adf-postgres` with
  `ADF_ORIGIN` not set); `check-lessons.mjs`: ok, 770 rows, 19 pending, none on 13.
- `npm run parity -- <origin>`: 22 of 22 PASS, `origin-jira.mjs` among them, with no network.
- `claude plugin validate .`: passed, and each of the nine plugins passes alone.
- Not run: any call to a live Jira; a live `glab mr view`; a propose, land or sync-debt in the
  origin (iteration 15 writes its registry values, above).

Left for later:

- `sync-debt` reads the epic's children into `<plans.dir>/epic.json`; that file is not checked
  against `.gitignore` the way `apply-plan.mjs` checks a plan.
- No migration of the origin's old plans in `.claude-reports/jira/` (above).
- The parity tool does not cover the apply engine's run against Jira or the client's paging;
  the ported suites and the fake `fetch` cover them.
- The English check's default scope still keeps every skill out; whether the origin includes
  its skills now that every plugin's trigger is English is decided at the switch, iteration 15
  (`docs/lessons/english-check.md`).

Versions: adf 0.14.0, contract 1.7; adf-gitlab 0.5.0; adf-jira 0.1.0 (new);
adf-english-check 0.6.0, adf-memory 0.2.0, adf-maintainer 0.1.0, adf-npm-workspaces 0.1.0,
adf-postgres 0.1.0 and adf-prisma 0.1.0 unchanged.

## Iteration 13a

Settled by the developer on 2026-10-22, after the release.

- A debt id is never reused. Each block's `index.md` carries ``Last id: `<block>-NN` ``;
  `add` allocates above it, `remove` keeps it, `check` refuses a row above it. Before, `nextId`
  took the highest id in the files, so removing the last entry gave its id to the next one,
  against the rule already stated in `lib/debt.mjs`.
- Archive's `placements` step removes the scope's `taken` debt entries from the tree; a
  `partial` entry stays. The removal is committed with the memory ingest. The resolved ids go
  to the knowledge log at ingest, not into a commit message; an entry already gone is logged
  too. With no knowledge provider the report names the ids that are not logged.
- `read-issues.mjs` and `read-comments.mjs` refuse to write an output file git does not
  ignore, before any request.
- Roadmap row 17 takes the developer's input: verify and review choose their checks by what
  the change touched.

Versions: adf 0.14.1; adf-jira 0.1.1.

## Iteration 13b

Settled by the developer on 2026-10-22.

- One tracker issue mirrors a group of related debt entries; several entries may share a
  Tracker key (`trackerGroups`). `sync-debt` works from the debt tree alone:
  `sync-debt.mjs state` reports the groups and the keyless entries, the agent decides the
  grouping (join, create, wait), `check-groups` checks it, `plan` builds a create per new
  group and a script-rendered entry list per existing group, and `track` writes the keys of
  the applied rows back.
- An entry related to an issue that has left the initial status waits for a new group: each
  edit row expects `config.statuses.initial`, and the apply engine skips a drifted row.
- A description is rewritten only when it has the group template's shape or the previous
  one-entry template's shape, so the origin's existing mirrors convert on their first sync.
- Land hands a debt group's issue to the tester when every entry of the group is resolved,
  and comments what remains otherwise; a key that is also a scope tracker item is handed off
  once.
- Fixed: the core and `adf-jira` disagreed on the hand-off fields (strings against lists,
  `test` on a partial item), so every real hand-off and retest was refused. The wire format
  is now a list of one-line texts for every text field; the core normalizes what the agent
  writes (lines split, list markers dropped) and checks the limits over all lines; a partial
  item carries `done`, `test` and `remains` on both sides. `tracker-plugins.spec.mjs` runs the
  real core scripts against the real `adf-jira` and `adf-gitlab` with Jira faked at `fetch`
  and `glab` faked on `PATH`; it fails on the previous code.

Versions: adf 0.14.2; adf-jira 0.2.0.
