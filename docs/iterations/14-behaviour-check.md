# Iteration 14 — Behaviour check

## Goal

The port runs the whole cycle on the origin's own archived changes, in a sandbox copy of the
origin at each change's base commit, and the result is compared with what the origin produced:
the branch, the artifacts' structure, the plan's groups and waves, the commit sequence, the
ledger, the review verdict, the archive result and the merge request. Every existing parity
tool checks one script on origin data; this iteration checks one phase consuming another
phase's output. The replay is script-level and repeatable, and it runs in `npm run parity`. One
pass with real agents through the real commands checks what the scripts cannot: the commands'
text and the agents' replies. Strong differences are fixed before the switch (iteration 15).

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Sandbox builder `scripts/parity/lib/sandbox.mjs`: a `--no-hardlinks` clone of the origin as a per-run cache under `os.tmpdir()/adf-replay-<id>/` (no `xnms` in the path), one `--shared` clone per candidate from that cache, a bare `remote.git` that both `origin` URLs point at, `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR` inside the sandbox, a `PATH` starting with the sandbox `bin/` holding logging fakes of `glab`, `docker`, `psql` and `npx`, and the fake-Jira preload; an isolation assertion at start | `sandbox.spec.mjs`: refuses a remote URL outside the sandbox, a fake binary that does not resolve into `bin/`, the real `HOME`; a poisoned `PATH` run refuses; the origin's refs, `git status` and stash are unchanged after a run |
| 2 | Candidate discovery by rule, not by a committed list: regular changes of the final origin flow (archive with a ledger, `plan.md`, `verify.md` and `review.md`), plus named exceptions given as arguments; the base: the exact base when the local branch survives, else the merge's first parent (D3); the merge request number from the merge commit | `replay-candidates.spec.mjs` on a fixture repository: squashed and branch-kept changes, an anomaly left out, `no-branch` reported (D10) |
| 3 | Host setup driver: `/adf:init`, the branch policy, the debt root and the registry entries from the inputs of iterations 12 and 13, committed on the sandbox `develop` and pushed to `remote.git`; it reports every host edit the switch needs (registry, `.gitignore`, `openspec/planning.md` sections, the debt tables' `Jira` → `Tracker` rename) | the host check passes after setup; the edit list is written into this record's inputs for 15 |
| 4 | Reply synthesizer: every place an agent writes is filled from the origin's records (artifacts from the archive directory or the propose commit, task results from the commits, review findings from `review.md`, the ingest reply from the memory diff), each reply validated by the port's own schema (D5) | every synthesized reply passes its schema; a synthesized difference is classified `injected` |
| 5 | Phase drivers, fresh mode: propose (create, gates, commit, Draft), apply (groups, waves, group worktrees, task commits, merges, suite record), verify, review (assemble, gate), archive (all steps and resume), land; each phase reads only the previous phase's output and the injected replies | each candidate reaches the end of archive; a resumed archive gives the same result |
| 6 | Mid-flight mode (the change with the kept branch): start from the origin's own propose commit, pinned to the origin schema, and continue with the port's apply to archive; `adf-gitlab` `finalize` replaces a Draft block with the origin's `opsx:` marker of the same change once (D6) | `forge.spec.mjs`: an `opsx:` block is replaced, no second block; the mid-flight replay reaches the end of archive |
| 7 | Comparison and report in `scripts/parity/origin-replay.mjs`: branch, worktree, artifacts and their headings, gate verdicts, groups and waves, the commit sequence by phase, the ledger, the review verdict and counts, the main specs after merge, the final `openspec/` and memory tree, the merge request call log against `glab mr view`; each difference `explained` (it cites a lessons row), `older-origin`, `injected` or `defect`; only `defect` fails, and a strong difference (D7) is always `defect` until explained | the tool runs in `npm run parity` on every candidate |
| 8 | The plan graph gap (D8): run the graph check offline on every regular origin plan; tasks the origin ran on the change branch after the groups are either allowed by the port or a plan defect, decided on that evidence; `tasks-lint` stops warning on origin wording that is not a path (`N/A`, a directory name) | `plan.spec.mjs` / `tasks-lint` tests with the origin wordings |
| 9 | Fix every `defect` the replay finds; a difference the developer accepts becomes a `changed` lessons row | `origin-replay.mjs` has no `defect` |
| 10 | One pass with real agents: a small candidate through `/adf:propose` … `/adf:archive` in a sandbox (D1). An executor agent follows the commands' text and returns every question for the developer; an answerer agent answers from the developer's recorded answers in that change's session transcripts and its artifacts, naming the source of each answer; a question no record answers goes to the developer; nothing leaves the sandbox | the transcript and the result are recorded in `## Result`; every difference from the script-level replay is classified |
| 11 | Inputs for iteration 15 (host edits from step 3, the in-flight Drafts, the mid-flight rule); lessons; version; roadmap row 14; `## Result` | `check-lessons.mjs`, `npm test`, `npm run parity -- <origin>`, `claude plugin validate .` |

## Decisions

Settled by the developer on 2026-10-22, all as recommended. Analysis: the iteration 14
analysis of 2026-10-22.

- D1 Script-level replay first, in `npm run parity`; then one pass with real agents on the
  small candidate. A full pass with real agents on every candidate is not done (about $200 per
  pass); row 18 repeats the agent pass on real systems after the switch.
- D2 Candidates: a small change, a database change, a flow-only change and a large change, by
  rule, taken only from the changes the developer made: the developer can answer for them, and
  their session transcripts exist.
- D3 A squash-merged change replays from the merge's first parent; a gate difference that comes
  only from that base is `injected`.
- D4 No real database: `docker`, `psql` and `npx` are logging fakes; the real create, drop and
  generate stay "not run" until the switch, as iteration 12 recorded.
- D5 Agent replies are synthesized from the origin's records everywhere; transcripts are a
  cross-check only where they exist.
- D6 `finalize` replaces the origin's `opsx:` block of the same change once, so the in-flight
  Drafts migrate at the switch without a duplicate block.
- D7 Strong: a stopped phase, another branch or base, a lost or invented ledger record, another
  spec merge result, another merge request state sequence. Wording, warnings and noise are
  recorded only.
- D8 Tasks outside every group are decided on the evidence of every regular origin plan.
- D9 One clone of the origin per run, as a cache inside the sandbox.
- D11 The agent pass answers from the developer's own transcripts, not from the developer in
  person; an answer matched by meaning rather than found verbatim is `injected`.
- D10 A change without its local branch is replayed and compared on its final tree only. The
  developer keeps the two branches the mid-flight mode needs until iteration 15.
- No origin content is committed to this repository: candidates are found at run time, and no
  change name, commit, bundle or merge request body is stored here.

Settled by the developer on 2026-10-26, all as recommended, from the agent pass (step 10):

- D12 A review fix may touch the finding's file, its tests or both; a test of the file is a
  test file named after it. A missing-test finding is fixed by a test-only commit.
- D13 A false alarm of the test-first proof (a finding the evidence shows the check caused,
  not the tests) is dismissed by a ruling and a deviation; `suite.mjs covering` and
  `tdd-proof` refuse a command that names a checkout by absolute path, the cause of that alarm.
- D14 The planning guide's `## Worktree preparation` lists the builds a fresh worktree lacks,
  each with the input paths that trigger it; `/adf:init` proposes candidates and the developer
  confirms them; the scripts run them, never an agent.
- D15 A base that fails at scale with one environment error signature, or a suite that ran on
  neither side, is `environment-broken`, never `pre-existing`; it blocks.
- D16 The active change is per worktree: a change the conversation names is passed as the
  name; else the checkout's pointer in `.adf/active.json`; else the one change in flight; the
  developer is asked only otherwise.
- D17 The tasks gate at propose refuses a taken or partial key, a debt id or a tracker key,
  that no task names: the rule verify's `tasks` check applies.
- D18 The ingest agent writes no page: its reply carries each page's edit as a patch, and
  `archive.mjs ingest` checks and applies it. The port writes no permission rule into the host.
- D19 A stopped dispatch's attempt count is reset only by the developer, through a held command
  recorded in the ledger.
- D20 A fix round that returns `BLOCKED` with no commit goes to its ruling before the breaker:
  the orchestrator rules for a task, the developer for a group or the final review.
- D21 `adf-npm-workspaces` `config.build` is deprecated in favour of the recipe (D14), with no
  change of behaviour.
- D22 A main checkout on the integration branch with several worktree pointers: the script asks.
- D23 Ledger records written after `commit-metrics` do not reach the archived copy: an accepted
  residue, kept as port debt (`## Result`, left for later).
- D24 Open findings of a consolidation's re-review do not block apply, as for the final review.
- D25 The brainstorm does not read the `review.md` of a similar archived change: the origin
  rule behind it is older-origin.
- D26 The bench is simulated in the replay; bench testing becomes a plugin of its own later,
  tuned on real changes.

Settled by the developer on 2026-10-27, all as recommended, from the second agent pass:

- D27 The attempt limit counts refused replies, not dispatches, from the latest of the phase
  run's start, the developer's last reset and the name's last valid reply; one helper gives
  the run start (verify's session, the review run's start, the apply round's start).
- D28 Verify opens a new session itself when code commits moved HEAD; a commit of only the
  change directory or of filtered paths, verify's own record commit among them, does not.
- D29 After a verify `FAIL`, `plan.mjs reopen` opens an apply round: it appends the fix task to
  `tasks.md` and `plan.md`, commits them and writes an `apply-round` ledger record naming the
  failing checks; preflight names the round. `PASS WITH WARNINGS` opens none: its warnings go
  to the review.
- D30 In a round, the groups merged before it are frozen out of the graph; the final
  whole-branch review and the reuse sweep run once more per round on the round's diff, the
  sweep against the whole tree; their counts start at the round.
- D31 A commit that changes only the change directory or filtered paths is not unreviewed;
  after a PASS followed only by such commits, `review.mjs start` reports that the record
  stands; `--fresh` overrides.
- D32 The test-first proof cache keys on its share list.
- D33 Sweep locations are recorded repository-relative when the reply is recorded; an absolute
  path outside the repository refuses the reply. `dup.mjs mark --finding <reply> --id S<n>`
  takes the location and the reason from the reply. A dismissal is recognised by its accepted
  debt ledger record, not only by the marker line, and a marker on the finding's own line
  covers it.
- D34 Apply pushes the change branch after the whole-suite record commit.
- D35 The consolidation's fix prompt asks the fixer to reuse an existing helper before writing
  a replacement; re-sweeps stay over the full range (the range superseded by D41).
- D36 The tracker gather takes keys and a phrase together; debt ids are not sent to the
  tracker.
- D37 Prompts rendered from a skeleton (the scope check, the land comment) carry the frame's
  single Tools rule.
- D38 The branch key: among named issues the first named wins; a sub-bug ranks as a bug; a tie
  remains only among phrase-search hits.
- D39 At hand-off a partial issue gets its comment and is routed back to the tracker's initial
  status, never through the hand-off status; with no initial status, or no such route, the
  comment only, and the plan says why. Supersedes iteration 13 D18.
- D40 The replay host runs init's worktree preparation step, every candidate confirmed.
- D41 The first reuse sweep is two passes in parallel, `sweep p1` and `sweep p2`, read as one
  run once both are accepted on one HEAD: a finding whose two locations name the same files with
  overlapping lines as an earlier one is that finding, across passes and runs, so one duplicate
  keeps one id. A consolidation's re-sweep reads only that consolidation's diff and carries the
  round's open findings; one its re-review found not consolidated is not cleared by the
  re-sweep's silence. Supersedes the range of D35.
- D42 Every fix round is a fresh `fix` dispatch whose prompt carries the task brief and the
  reviewed range; an agent is resumed only for a refused reply's retry and a `provide-context`
  answer, each dispatched afresh where the harness cannot resume it.
- D43 `dispatch.mjs prompt` cuts the review package for every role that reads it and refuses a
  range it cannot cut; the orchestrator no longer cuts it.
- D44 The gather report names a debt entry matched by its debt id as such, never as a tracker key.
- D45 `/adf-jira:setup` asks for the initial status, from the discovered status names only;
  while it is unset, the tracker check returns a note that propose and land show, and
  `/adf:init` and `/adf:add` run the tracker check once the registry check passes and show it.

## Inputs for iteration 15

The host setup driver (step 3) ran the port's own init path on the origin at each candidate's
base, with the values recorded by iterations 12 and 13, and listed every edit it made or a
port check demanded. The switch makes the same edits; none is committed here.

- `.claude/adf-extensions.json`: the registry at contract 1.7 with `review.prompt`; the branch
  policy (integration branch `develop`, detected by init); `debt.root` set to
  `.claude/memory/tech-debt`; the entries, in this order: `adf-gitlab`, `adf-memory`,
  `adf-english-check`, `adf-npm-workspaces`, `adf-postgres` (the README's example `config` with
  the origin's own prefix), `adf-prisma`, and `adf-jira` with the `config` recorded in
  `docs/iterations/13-tracker-jira.md`, `## Inputs for iteration 15`. At the switch each entry
  names the installed plugin by id; the replay used `path` entries.
- `.claude/settings.json`: `enabledPlugins["adf@agentic-dev-flow"]`.
- `.gitignore`: `.adf/*`, `!.adf/prices/`, `!.adf/retro/`.
- `openspec/planning.md`: the template, then the values the lessons record as pending on 15:
  `## Whole-suite command` (`docs/lessons/apply.md`), `## Packages` with the origin's package
  list and order (`docs/lessons/propose.md`), `## Fresh-run proof` (`docs/lessons/verify.md`),
  `## Worktree copies` with the env file the database URL is rewritten in
  (`plugins/adf-postgres/README.md`). New since step 3: `## Worktree preparation` (D14), the
  build of the shared package and any generated code, each with its input paths; confirm the
  candidates `/adf:init` proposes rather than writing them by hand. With the recipe in place,
  the `adf-npm-workspaces` entry carries no `build` (D21).
- `openspec/review-prompt.md`: the template, for the team to tune.
- `.gitlab/merge_request_templates/adf.md`: the host file `adf-gitlab` declares, copied by
  `/adf:add`.
- The debt tree: the header's last column `Jira` becomes `Tracker` in every debt table of
  every category index (eight files and nine tables on 2026-10-22, one file holds two;
  `debt.mjs check` refuses the tree until each is renamed); the example row in the root
  index's format description is removed, and the switch replaces that description with the
  port's (`plugins/adf/contract/debt-format.md`).
- The tracker profile: `/adf-jira:setup` once after the switch, with the env keys and the
  profile location recorded in iteration 13's inputs; until then the tracker check is
  `degraded` and propose offers to skip it. The `adf-jira` entry's `statuses.initial` names the
  status a partial issue goes back to at hand-off (D39); without it a partial issue keeps its
  status. The developer confirms the value at the switch.

The changes in flight at the switch (eight change directories on the origin's `develop` on
2026-10-26, more in its worktrees; each with a Draft opened by the origin's merge request
script):

- Each is pinned to the origin schema and has no `.adf.json`. The port reads an in-flight
  change's base from a `base:` line in its `.openspec.yaml`, else the integration branch
  (`readChangeMeta`). Check the base of each in-flight change at the switch: a change forked
  from a feature branch would get the integration branch as its base, the wrong one; give it a
  `base:` line first.
- `adf-gitlab` `finalize` writes the `adf:` block in place of the same change's `opsx:` block
  or placeholder, once (D6); the Drafts need no hand edit.
- The mid-flight replay (step 6) continued such a change from its own propose commit through
  the port's apply to archive; verify's `specs-base` warns, not fails, on a change with no
  `specs-base.json`.

Run `/adf:init` (and `/adf:add`) interactively at the switch, never headless: Claude Code
asks for an approval of every write under a project's `.claude/` directory, the registry and
the settings included, and no allow rule lifts it (`docs/lessons/superpowers-gate.md`).

Bench testing: the replay simulated the hardware pass the origin's plans hold (the agent pass's
bench answer was simulated, D26). A bench plugin is future work; tune it on real changes after
the switch, not on the replay.

## Harness debt

1. The fake forge has no merge emulation. Land waits for a merge, and the developer must
   emulate it by hand: edit `forge.json`, then fast-forward `develop` on the sandbox remote.
   Proposed: an `autoMerge` option in the fake `glab`. On the first poll of land after the
   undraft, it marks the merge request merged and fast-forwards the sandbox remote.
2. The fake Jira ignores JQL. A propose with a phrase and no key gets every issue. Proposed:
   a minimal JQL subset (`key in`, `text ~`, `status`), before a pass that starts without a
   key.

## Result

Commits (`git log --oneline bbee130..HEAD`, before this release step; the version-only patch
bumps are in them):

```
57738cd fix(adf): refuse only text after a sweep location's line; parity replay splits a fix by the finding's own tests
3805b9d fix(adf): worktree preparation recipe, environment-broken suite verdict, active change per worktree, sweep consolidation round, taken debt named at propose
eaa5ab7 fix(adf): apply ingest page edits by script, drop the ineffective allow rules, name the reset on a limit stop
0e0fbb7 feat(adf): let the developer reset a stopped dispatch's attempt count through a held command recorded in the ledger
c5e7cee fix(adf): make the knowledge base writable in every change worktree through host allow rules
e70e9d5 fix(adf): accept a review fix that touches only the tests of the finding's file; every fix refusal says retry or stop
e2154d7 fix(adf): one tools rule for every agent, per-role dispatch examples, deletion check skips knowledge and debt pages
bd92b12 fix(adf): read an in-flight change's base, one execution-graph parser, commit-none replies, specs-base warning
7622422 test(parity): compare the replay with the origin and classify each difference
8dba2a9 test(parity): drive the replay through every phase, fresh and mid-flight
8b2d8f3 test(parity): match the reworded adf-jira registry note
7bffe71 test(parity): replay host setup and replies built from the origin's records
4894246 test(parity): replay sandbox and candidate discovery for the behaviour check
7f6cf63 fix(adf): no package boundary without a Packages guide, fewer false path warnings
2af127b feat(adf-gitlab): finalize takes over the origin's Draft block of the same change
53aad23 docs(iterations): iteration 14 replays only the developer's own changes, answered from transcripts
```

The candidates, by kind (D2; found by rule at run time, never named here): a small fix, a
database change (a migration and the stack plugins' path), a flow-only change of the earlier
flow era (its differences from that era are `older-origin`), and a large change with parallel
groups, which also runs mid-flight from the origin's own propose commit.

By step:

- 1 (4894246) `scripts/parity/lib/sandbox.mjs`: the per-run cache clone, a shared clone and a
  bare remote per candidate, home, config and temp directories inside the sandbox, logging
  fakes of `glab`, `docker`, `psql` and `npx` first on `PATH`, the fake-Jira preload, and the
  isolation assertion. `sandbox.spec.mjs` passes, the poisoned-`PATH` refusal among it. Every
  run ends with "Origin unchanged: true" (refs, `git status` and stash hashed before and
  after); a ref the developer's own work in flight moved during a run is named as such.
- 2 (4894246) `replay-candidates.mjs`: the developer's regular archived changes of the final
  flow by rule, plus the named exceptions, with the merge request, the branch and the base,
  exact where the local branch survives, else the merge's first parent (D3);
  `replay-candidates.spec.mjs` passes on a fixture repository.
- 3 (7bffe71, 8b2d8f3) `replay-host.mjs`: the port's own init path at each candidate's base
  with the values of iterations 12 and 13. The host check passes after setup; the edit list is
  `## Inputs for iteration 15` above. The run also fixed the `adf-jira` registry entry recorded
  in iteration 13, which used `id` for `plugin`.
- 4 (7bffe71) `replay-replies.mjs`: every structured reply of the cycle built from the origin's
  artifacts, commits, ledger and review record, each validated by the port's own checks and
  naming its source; a reply the records cannot give is missing, never invented.
- 5 (8dba2a9) `replay-drive.mjs`, fresh mode: every candidate reaches the end of archive and
  land; a resumed archive gives the same result.
- 6 (2af127b, 8dba2a9) mid-flight mode: the large candidate continues from the origin's own
  propose commit, pinned to the origin schema, to the end of archive; `finalize` writes the
  `adf:` block in place of the same change's `opsx:` block or placeholder once
  (`forge.spec.mjs`).
- 7 (7622422) `scripts/parity/origin-replay.mjs` in `npm run parity`: each difference
  `explained` (it cites a lessons row), `older-origin`, `injected` or `defect`, the rest
  recorded only. The first full run, 206 differences:

  | Run | Total | Explained | Older-origin | Injected | Defect | Recorded |
  |---|---|---|---|---|---|---|
  | small, fresh | 29 | 17 | 0 | 11 | 0 | 1 |
  | database, fresh | 72 | 19 | 2 | 47 | 3 | 1 |
  | large, fresh | 36 | 19 | 1 | 14 | 1 | 1 |
  | flow-only, fresh | 32 | 15 | 4 | 13 | 0 | 0 |
  | large, mid-flight | 37 | 14 | 1 | 18 | 3 | 1 |

  The seven defects were four port defects: a labelled group cell such as "A: contracts" was
  a group to `plan.mjs` and not to `dispatch.mjs`; no valid `impl` reply existed for a
  verification-only task whose Commit step says none (three tasks); an in-flight change with
  `.openspec.yaml` and no `.adf.json` was refused; verify's `specs-base` failed a change with
  no base entry where archive warns.
- 8 (7f6cf63) the plan graph gap (D8): on the origin's 18 regular final-flow plans, no task is
  outside every group, so that stays an error, and the flow-only candidate's two such tasks are
  `older-origin`. `plan-lint` gave 29 false cross-package warnings with no `## Packages` guide,
  now none; `tasks-lint` no longer reads `N/A`, a bare directory name or an artifact name as a
  path.
- 9 (bd92b12) the four defects fixed: one execution-graph parser (`parseExecutionGraph`), the
  commit-none `impl` reply checked against the plan text, an in-flight change's base through
  `readChangeMeta`, and verify's `specs-base` warning. The replay after the fixes, then after
  the step 10 fixes (the release run, 2026-10-26):

  | Run | After step 9: total, explained, older-origin, injected, defect, recorded | Release run: the same |
  |---|---|---|
  | small, fresh | 29, 17, 0, 11, 0, 1 | 29, 17, 0, 11, 0, 1 |
  | database, fresh | 68, 19, 2, 46, 0, 1 | 68, 19, 2, 46, 0, 1 |
  | large, fresh | 34, 19, 1, 13, 0, 1 | 34, 19, 1, 13, 0, 1 |
  | flow-only, fresh | 32, 15, 4, 13, 0, 0 | 32, 15, 4, 13, 0, 0 |
  | large, mid-flight | 31, 13, 1, 16, 0, 1 | 31, 13, 1, 16, 0, 1 |

  Both runs: 194 differences, no `defect`, and every phase a run drives reached (fresh: host
  to land; mid-flight: host, then apply to archive). The step 10 fixes changed no count.
- 10 the agent pass (D1, D11): one more of the developer's small changes, a form change of 9
  tasks in three groups, through `/adf:propose`, `/adf:apply`, `/adf:verify`, `/adf:review`,
  `/adf:archive` and `/adf:land` in a sandbox, by an executor session that followed the
  commands' text and an answerer session that answered from the developer's transcripts of
  that change and its artifacts, naming the source of each answer. Every phase was reached;
  verify PASS WITH WARNINGS and review PASS, as in the origin; the merge request went Draft →
  ready and stays open, since no one merges in the sandbox; land skipped, the tracker having
  been skipped for the change. Nothing left the sandbox, and the origin was unchanged.
  - Questions: 28. By answer kind: 1 found verbatim, 13 matched by meaning (`injected`, D11),
    3 answered from the code and the artifacts, 11 with no record. Of those 11: 7 went to the
    developer, 1 was the first asking of a question that came back after a resume, and 3 were the sandbox's
    own (the tracker with no token, skipped with a reason; the bench consent, simulated, D26;
    the ingest's write permission, a port defect below). The developer also confirmed each
    attempt reset after a port fix.
  - The developer's 7 rulings: a permission refusal is not a developer question, re-dispatch
    under the frame's Tools rule; a test-first finding dismissed as a false alarm (D13); the
    bench pass answered as run and passed (simulated, D26); two sweep duplicates accepted as
    consolidated and the third dismissed with the project's own deferral reason; verify's
    `tasks` key check and a contradiction check accepted by ruling, the debt widened (D17); the
    review's test-only fix kept, the port's fix check corrected (D12); archive's placements
    approved as proposed.
  - Permission refusals: about 18 compound shell commands from the dispatched agents before
    the frame's single Tools rule (e2154d7), none after it. The refusals left were the
    ingest's page writes under `.claude/`, which no allow rule lifts (below).
  - Cost: about $122 (executor $117.19, answerer $4.28, a smoke run $0.21), against the
    planned $15–30. The executor ran on the top model throughout, and it was resumed six
    times on newer port versions after the fixes below, each resume reading the whole session
    again.
  - The final tree against the origin's: the code, 33 files in both, 22 only in the origin's,
    5 only in the port's; the knowledge base, the port's ingest edited 7 of the 11 pages the
    origin's did, and one page of its own; the new capability's main spec, 6 requirements in
    the port against 7 in the origin. The missing one is `older-origin`: it came from an origin
    review finding never filed as debt. The comparison tool marks 91 differences `defect`, 87
    of them ledger records: an agent pass makes its own rulings, so no origin ruling has a
    port twin and back; the others are this pass's setup commit as the base, the
    `specs-validate` refusal of the agent's own first draft (fixed by the agent at once), the
    spec merge of different specs, and the merge request left open. Each was read and none is a
    port defect.
  - Port defects found and fixed: the dispatched agents' compound shell commands (one Tools
    rule in the frame, per-role dispatch examples) and the propose skill's Execution Handoff
    question (e2154d7); the deletion sweep refusing a plan over knowledge and debt pages
    (e2154d7); a missing-test review fix refused (e70e9d5); no way to reset a stopped
    dispatch's attempt count (0e0fbb7); the ingest's page writes refused (eaa5ab7, below);
    the worktree builds an agent ran by hand, a base failing for its environment read as
    pre-existing, the change asked for on every command, a consolidation with no dispatch of
    its own, a taken key no task names found only at verify, a fix loop running to the breaker
    on a finding with nothing to fix, a background dispatch dying with the turn, the archived
    ledger missing the records written after the move, and a test-first proof run on the new
    code through an absolute path (3805b9d); a sweep location with a symbol after its line
    keeping a consolidated duplicate open (57738cd).
  - The allow rules c5e7cee wrote into the host were ineffective: Claude Code treats every
    file under a project's `.claude/` directory as sensitive and asks for an interactive
    approval of every Edit or Write there even when a `permissions.allow` rule matches
    (headless probes, `docs/lessons/superpowers-gate.md`). eaa5ab7 removed them: the ingest
    reply carries each page's edit as a patch, and `archive.mjs ingest` checks and applies it
    (D18).
  - Open: ledger records written after `commit-metrics` (a land run's, a later resume's) do not
    reach the archived copy; accepted by the developer as port debt (D23, left for later).
  - The second agent pass (2026-10-26/27, adf 0.15.0): the same small change, with an emulated
    tracker seeded from the change's real issues. It ran propose and apply through verify and
    was stopped at the third verify run, at about $122; review, archive and land were not
    reached. Port defects found and fixed (D27–D40): the attempt limit counting dispatches and
    not refusals, verify keeping an old session after code moved HEAD, no scripted way from a
    verify `FAIL` back into apply, review re-entry after a record-only commit, the test-first
    proof cache ignoring its shares, absolute sweep locations and a dismissal known only by its
    marker line, no push after the whole-suite record, the tracker gather taking keys or a
    phrase but not both, the branch key ranking, a partial issue kept at its status, skeleton
    prompts without the Tools rule, and the replay host skipping init's worktree preparation
    (5e26a89, 675bcb5, 942c65b, 0edc685, 8b6bffc, b2bc731). Not port defects: the replay
    harness copied only the root dependencies (fixed in the harness, outside this repository);
    the answerer returned `none` on questions a standing rule covered; the executor tried to
    move the partial issue during apply. Agent judgement: the first sweep missed a duplicate
    that a re-sweep found (D35). A third pass on adf 0.16.0, the same change, the emulated
    tracker and a recorded initial status (2026-10-27): 48 turns, about $102, from propose to
    land; verify passed with warnings on its first run, so the apply round after a `FAIL` was
    not exercised; the hand-off moved four issues to Review and the partial one back to Opened
    (D39). Port defects it found: the sweep took four consolidation rounds, most of them for
    duplicates the first sweep missed, and one duplicate got a second id at shifted lines (D41);
    a fix round told to resume the implementer, which a headless pass cannot do (D42); no review
    package was cut in the whole run, so the reviewers read `git diff` (D43); a debt id shown
    as a tracker key (D44); no step asks for the initial status (D45) (73d391d, 0309426,
    f8bd7df). Not port defects: the answerer once returned an empty answer (fixed in the
    harness); the replay's merge and the fake tracker's JQL are recorded under
    `## Harness debt`. Agent judgement: compound shell commands the permission rules refused,
    a refused reply sent again unchanged, and an invented subnet in a tracker comment, which
    the answerer caught.
- 11 (this step): `## Result`, the inputs for iteration 15, the decisions D12–D26,
  `adf-npm-workspaces` `config.build` deprecated in its README (D21), versions, marketplace,
  README and roadmap row 14. No lessons row was added: every row this iteration changed
  carries its "since iteration 14" note, and none is pending on 14. After the second agent
  pass (2026-10-27): the decisions D27–D40, versions, marketplace and roadmap row 14; the
  lessons rows the decisions changed carry a "since iteration 14 (developer decision,
  2026-10-27)" note (`apply.md`, `verify.md`, `review.md`, `propose.md`, `forge-gitlab.md`). After the third
  pass (2026-10-28): the decisions D41–D45, versions, marketplace and roadmap row 14.

Checks, on 2026-10-26:

- `npm test`: 1446 tests, 1441 pass, 0 failures, 5 skipped (the live openspec parity with `OPENSPEC_DIST` not set, and four live origin tests with `ADF_ORIGIN` not set: the name parity of `adf-postgres` and three of the replay); `check-lessons.mjs`: ok, 770 rows, 19 pending, none on 14.
- `npm run parity -- <origin>` with the four fresh candidates and the mid-flight one (the
  author, `ADF_REPLAY_FRESH`, `ADF_REPLAY_MID`): 23 of 23 PASS, `origin-replay.mjs` among them with no `defect`, the origin unchanged.
- `claude plugin validate .`: passed.
- On 2026-10-27, after the second pass's fixes: `npm test`: 1485 tests, 1480 pass, 0
  failures, 5 skipped (the same five); `check-lessons.mjs`: ok, 770 rows, 19 pending, none on
  14.
- On 2026-10-28, after the third pass's fixes: `npm test`: 1494 tests, 1489 pass, 0
  failures, 5 skipped (the same five); `check-lessons.mjs`: ok, 770 rows, 19 pending, none on
  14.
- Not run: a real database create and drop, a real `prisma generate` (fakes, D4); a live
  `glab`, Jira or bench; the agent pass on the larger candidates (D1; row 18 repeats it on
  real systems after the switch).

Left for later:

- Ledger records written after `commit-metrics` do not reach the archived `ledger.jsonl`
  (D23): `commit-metrics` copies the live ledger before the final commit, so a record written
  later (a land run, a resume after the final commit) stays only in the live ledger, which
  the worktree removal deletes.
- Bench testing as a plugin of its own (D26), tuned on real changes after the switch.
- The comparison's ledger rules suit injected replies; an agent pass needs a rule of its own
  that pairs rulings by meaning rather than by text.

Versions: adf 0.17.1 (0.15.0 at the first release of this iteration, 0.16.0 after the second
pass), contract 1.7 unchanged; adf-jira 0.4.0 (0.3.0 after the second pass); adf-gitlab 0.6.0;
adf-npm-workspaces 0.1.1; adf-memory 0.2.1 (bumped during the iteration); adf-english-check
0.6.0, adf-maintainer 0.1.0, adf-postgres 0.1.0 and adf-prisma 0.1.0 unchanged.
