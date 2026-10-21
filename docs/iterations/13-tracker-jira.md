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
