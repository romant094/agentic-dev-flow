# Iteration 14b — Switch rehearsal and fix round

## Goal

Iteration 15 switches the origin project to the plugins without surprises. Before it, the switch
is rehearsed on clones of the origin with the plugins installed from the marketplace into a real
Claude Code, `/adf:init` and `/adf:add` answered by the developer, and one real change driven by
the developer from propose to land. Every defect the rehearsal finds is fixed here, in this
iteration, before 15.

The rehearsal has two variants, each in its own clone and on its own integration branch:

- `remove-first`: the origin's own flow is removed first, then init and add run on a project
  with no flow. Run on 2026-10-30 and 2026-11-02; findings below.
- `two-stage`: the switch as iteration 14 decided it: init and add on top of the origin's own
  flow (stage 1), then the removal in a merge request of its own (stage 2). Run on 2026-11-02
  without a second change: the change cycle is the same code `remove-first` already drove.

## Rehearsal: remove-first

Setup:

1. The origin at its integration branch's head, cloned into a sandbox; `origin` is the real forge,
   so merge requests are real. The integration branch is a rehearsal branch, never `develop`.
2. One commit removes the origin's own flow (inventory below), one installs the plugins at
   `project` scope, then `/adf:init`, `/adf:add` for every plugin and `/adf-jira:setup` run
   interactively.
3. One change: a small refactor from the debt epic, a real tracker issue, a real merge request
   into the rehearsal branch, merged on the forge, then land.

Measured: init 1m45, add and tracker setup 16 min (about 7 min the developer away), propose 37 min
(26 min waiting on the developer after a tracker refusal), apply 15.5 min (whole suite 2m46),
verify 4 min, review 52 s (0 findings), archive 12.4 min, land 5 min. About $27 in all, every
agent on the same top model. The cycle reached land; land made a complete hand-off and handled a
squash merge correctly (`forge.mjs:421`, the merge commit on the base).

What worked without help: init's branch, debt and preparation questions (the preparation inputs
inferred); tracker discovery, held plans and resume; the scope check correcting a stale issue;
branch, worktree, propose gates and the plan graph; the Draft, per-group push and undraft; SDD
dispatches, ledger and guard; both reuse sweeps; the whole suite with its base check; verify's
checks; review; the spec merge, archive move, ingest, metrics and worktree removal; land's wait
on the forge state.

### The origin's flow parts and what replaces them

| Origin part | Replaced by |
|---|---|
| In-repo tracker plugin and its `enabledPlugins` / marketplace entries | `adf-jira`; the profile directory stays |
| `.claude/commands/opsx/`, `openspec/schemas/<origin schema>/`, the spec-sync skill | `adf` |
| Agents per capability level | `adf` agents |
| Merge request script and the `opsx` merge request template | `adf-gitlab` and its template |
| Worktree database script | `adf-postgres` |
| Worktree provisioning script | `adf-npm-workspaces`, `adf-prisma` |
| Migration order check | `adf-prisma` `verify-check` |
| Log rotation script and skill | `adf-memory` |
| Reply, plan symbol, workspace and superpowers checks, ledger, metrics scripts, retro skill | `adf` |
| Flow capability specs in `openspec/specs/` (12 on the origin) | the port's flow; removed |
| `openspec/config.yaml` | `openspec/planning.md`; removed (developer decision) |
| Commands guard and its `openspec update` deny rules, workflow shape check, flow regression scripts, flow digest skill, the flow's memory pages | nothing; obsolete with the origin's flow |
| Pre-commit English check (lefthook) | `adf-english-check`, in the flow only (developer decision) |
| Price script called by the CI review job | kept with the CI review job until review is a stage of its own (F5); developer decision 2026-11-03, replacing the rehearsal's removal |
| Project skills, device plugin, user guide, corpus lint | kept (corpus lint reworded to `/adf:*`) |

## Findings

`F` findings came from building the sandbox, `N` findings from the session's transcript. Each
was checked in code where a file:line is given. `#n` is the port's issue that already tracks it.

### Core (`adf`)

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| N3, N4 | An enabled plugin cannot be reconfigured; remove and add again reorders the registry. `remove` takes only the short name, `add` the id (#8) | `lib/registry.mjs:251`, `extensions.mjs:94` | `extensions.mjs config <name>`; both name forms everywhere |
| N5 | A registry or guide change on the integration branch has no effect on a change already open: provision reads the change worktree's copy | session | Say so in init's and add's closing note; the switch merges the setup before the first propose |
| N6 | Init asks neither the whole-suite command nor the worktree copies; both were found at the end of apply | `commands/init.md` | Init proposes both: the suite from CI and `package.json`, the copies from the ignored `.env*` files |
| N7 | `suite.mjs run` with no command still commits and pushes a `not-run` record (#9) | `lib/suite.mjs:501` | No record for `not-run` |
| N8 | `suite set` during apply writes the guide into the change branch, then verify fails `out-of-plan` | session | Exempt the flow's own guide write, or write it on the integration branch |
| N9 | A pathspec commit with a host pre-commit formatter (`stage_fixed`) leaves the index ahead of HEAD; the next step refuses the files as foreign (#1, #2) | `lib/commit.mjs:81` | Commit through the index; an optional `## Format command` in the guide, run before each flow commit |
| N10 | The debt tables kept the column `Jira`; propose found no entry for the issue and archive closed none. Neither init, add nor `debt check` refused the tree (#4) | `lib/debt.mjs:23` | `debt check` refuses an unknown last column and names the rename; init and add run it |
| N11 | A refactor with no requirement change has no path without a spec delta (#5) | `schema/schema.json:32` | `skip specs --reason`, checked at verify |
| N12 | A skipped optional artifact shows `ready` (#6) | session | Show `skipped` |
| N14 | Script outputs too large for the agent: provision lists every link; `instructions apply` is 48 KB. The agent wrapped commands in `node -e` and pipes against the one-command rule | session | Provision summarises its actions; split the apply instruction |
| N15 | The final-review dispatch needs `--question-file`, `--base`, `--head`; three attempts | session | Give the exact command line |
| N16 | Archive's dependent steps ran in parallel; three refused | session | `archive.md`: the steps are sequential |
| N17 | Verify's c4 "nothing exercised" stays after the developer's own check (#10) | session | The developer section supersedes c4's warning |
| N18 | The corpus lint is "due" at the first archive: the window counts the origin's 80 earlier archives | session | Init seeds the window marker |
| N19 | The metrics window starts after most of propose (3.6 min measured, 37 min wall) | `metrics.json` | Start at the change's first ledger entry |
| N24 | Land's comment input refuses until the main checkout has the merged change; the agent pulled on its own | `lib/land.mjs:326` | Read the archive from the merge commit after a fetch, or a land step that fast-forwards |
| N25 | Land hands off although the merge request's base is not the integration branch | `scripts/lib/land.mjs:221` | Name the difference in the hand-off preview |
| N26 | With no forge, land decides "merged" by ancestry and cannot see a squash merge (not hit) | `lib/land.mjs:266` | Compare patch ids, or require a forge where merges squash |
| F2 | Nothing tells the host how to reword its own agent instructions (`CLAUDE.md`) that describe the old flow; three sections were rewritten by hand | — | A switch checklist in the README; init names the host files that mention the old flow |
| F10 | The rehearsal's removal commit also deleted the seven changes in flight under `openspec/changes/`; nothing in the switch list forbade it. Found after the release, 2026-11-03 | `2e827e07c` in the rehearsal clone | `docs/switching.md` step 7: the removal never touches `openspec/changes/` |
| F3, F6, F7 | The switch list misses the flow capability specs, the old merge request template, `openspec/config.yaml` and the memory pages that name removed scripts | — | The inventory table above becomes the switch checklist |

### Hooks

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| F1 | `adf-english-check` and `adf-npm-workspaces` act in every repository: english-check uses its defaults with no registry entry, npm-workspaces never reads the registry. Developer decision: a hook does nothing where the registry does not enable its plugin | `adf-english-check/scripts/lib/english.mjs:100`, `adf-npm-workspaces/scripts/lib/guard.mjs:133` | Both exit 0 with no registry or no entry; specs for both cases |

### `adf-jira`

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| N1 | Start fails with 400 on an issue assigned to someone else: the transition row comes before the assignee row (#3) | `scripts/lib/tracker.mjs:492` | Start: assignee first, then the transition |
| N22 | Hand-off puts the assignee before the comment. Developer rule: when handing over, every action on the issue first, the assignee last | `scripts/lib/tracker.mjs:492-495` | Hand-off: transition, comment, assignee |
| N23 | A held plan edited by hand is applied without notice | `scripts/apply-plan.mjs:40-61` | A digest of the rows at hold, checked at apply |
| N20 | Setup recommended a status without checking; the per-type workflows and an assignee-only condition were found by an ad-hoc script | session | Discovery samples type × status and records transition conditions |
| N21 | The personal layer is interviewed again though the origin has one | session | Offer to import an existing `local.md` |

### `adf-postgres`

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| N2 | Enabled with no config, provision refuses even when the change needs no database; add does not check the config (#7) | `scripts/lib/postgres.mjs:261` | Check `needs` and kind first; add validates a required config |

### Marketplace and install

| ID | Finding | Fix |
|---|---|---|
| F8 | The marketplace was declared by an absolute local path in the project settings, which no other developer has | The switch declares the marketplace by its git URL |
| F9 | `claude plugin install` rewrites the project settings file with spaces; the origin uses tabs | Claude Code's behaviour: the switch commit says so; the formatter fixes it (N9) |

### Decided, not fixed here

- F5 Code review becomes a stage of its own after 15: no CI review job; review runs inside the
  flow and can be addressed to another provider. The origin's CI review job stays until then.
- N13 Every capability level ran on the same top model: the plugin maps a level to an effort, not
  to a model. Open: document it, or let the registry map a level to a model.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Hooks: F1 | `english.spec.mjs`, `guard.spec.mjs` with no registry and no entry |
| 2 | `adf-jira`: N1, N22, N23 | `tracker.spec.mjs`, `apply-plan.spec.mjs` |
| 3 | `adf-postgres`: N2 | `postgres.spec.mjs` |
| 4 | Registry: N3, N4 | `registry.spec.mjs`, `extensions.spec.mjs` |
| 5 | Commits and the formatter: N9 | `commit.spec.mjs` with a formatting pre-commit hook |
| 6 | Debt: N10 | `debt.spec.mjs` with a `Jira` column |
| 7 | Init: N5, N6, N18; F2, F3, F6, F7 as the README's switch checklist | `init.spec.mjs` |
| 8 | Suite and verify: N7, N8, N17 | `suite.spec.mjs`, `verify.spec.mjs` |
| 9 | Propose: N11, N12 | `schema.spec.mjs`, `changes.spec.mjs` |
| 10 | Land: N24, N25, N26 | `land.spec.mjs` |
| 11 | Instructions and outputs: N14, N15, N16, N19 | `npm test` |
| 12 | Tracker setup: N20, N21 | `discover.spec.mjs` |
| 13 | The switch checklist (README): one stage after a freeze, the two-stage switch with T1–T4 as the fallback. The host repository declares the marketplace and enables the plugins in its committed project settings, so no developer installs a plugin by hand. A developer's migration guide: what each developer does after the switch merges, on their machine and for each of their changes in flight (developer decision, 2026-11-02) | the comparison below |
| 14 | Version and release | `npm test`, `npm run parity -- <origin>` |

## Inputs for iteration 15

These replace or add to iteration 14's `## Inputs for iteration 15` where they differ. The switch
is one stage after a freeze (developer decision, 2026-11-02; see the comparison below), not the
two stages iteration 14 decided.

Freeze and switch:

1. Collect the phase of every change in flight, the developers' worktrees included.
2. Before the freeze, finish to archive with the origin's flow every change past verify. On
   2026-11-02 these were `add-manual-backup-now`, `add-sync-backup-summary-toast` and
   `close-backup-action-dialog-on-submit`.
3. A change with a plan and apply records but no verify either finishes with the origin's flow
   before the freeze, or continues with `/adf:verify` after it; the second path is not rehearsed.
   On 2026-11-02: `enrich-backup-preview-diff`, `rework-firmware-upgrade-lock-and-cancel`.
4. A change with only propose's artifacts continues with `/adf:apply` after the switch, the path
   iteration 14's replay covered. On 2026-11-02: `add-firmware-distribution`,
   `correct-backup-run-outcome-reporting`.
5. Freeze: nobody commits to a change branch until step 12.
6. One merge request switches: the `remove-first` removal (inventory above), the debt column
   rename `Jira` to `Tracker` with the example row of the root index replaced by a pointer to the
   port's debt format (T4, N10), and the plugin install.

Setup, in the switch branch:

7. Declare the marketplace in the committed project settings by its git URL with the release tag
   as `ref` (developer decision, 2026-11-02; `docs/switching.md`); enable every plugin at
   `project` scope.
8. `/adf:init`: integration branch `develop`; no other protected branch (the origin has no
   `main`); debt root `.claude/memory/tech-debt`; preparation `npm run build:shared` with the
   inputs init infers.
9. The guide: whole-suite command `npx turbo run test --force`; `## Worktree copies` names `.env`.
10. `/adf:add` once per plugin, each with its config on the first add (until N3):
    `adf-postgres` before `adf-prisma`; `adf-jira` with the statuses the developer confirmed in
    the rehearsal: `initial` Opened, `start` In Progress, `handoff` Review, `excluded` Resolved,
    Closed, Review, Suspended.
11. `/adf-jira:setup`; take the personal layer from the origin's existing one.

After the switch:

12. Merge the switch into `develop` before the first propose (N5); end the freeze.
13. Merge `develop` into every change branch still open; never rebase a pushed branch. A change
    forked from a branch other than `develop` gets a `base:` line in its `.openspec.yaml`.
14. Continue each change with the `/adf:*` command of its next phase; `adf-gitlab` finalize
    takes over its `opsx` Draft (D6).
15. Until N1 and N22 are fixed: reassign before start; at hand-off, the assignee last.

## Comparison: remove-first and two-stage

Init, add and tracker setup were answered by the developer in both variants and gave the same
host files, except for choices the developer made differently: the protected branches, the
registry order of `adf-gitlab` and `adf-memory`, and the order of the excluded statuses. Stage 2
was the `remove-first` removal commit picked onto the stage 1 branch; only the project settings
file conflicted, because the install had rewritten it (F9).

Findings only `two-stage` shows (stage 1, both flows present):

| ID | Finding | Fix |
|---|---|---|
| T1 | The origin's own tracker skills still describe the debt column as `Jira` after the rename | Disable the origin's tracker plugin in stage 1 (T3) |
| T2 | The host's agent instructions still name the origin's propose; an agent asked to start a change picks it over `/adf:propose` | Stage 1 rewords the entry point for new changes; changes in flight keep the origin's commands |
| T3 | The origin's tracker skills and `adf-jira`'s have near-identical descriptions; the agent chose `adf-jira` only from a commit message. The origin's flow does not call its tracker plugin | Stage 1 disables the origin's tracker plugin |
| T4 | After the rename, `debt check` refuses the root index: the format description's example row is read as an entry. Before the rename the tree passed silently (N10) | The rename and the example row's removal are one edit |
| T5 | The origin's capability-level agents sit beside the plugin's; no name clash | Removed in stage 2 |

After stage 2: the registry and debt checks pass, and an agent picks `/adf:propose` and
`adf-jira:task`.

Not rehearsed: a change of the origin's schema continuing after stage 1, and `finalize` taking
over its Draft (D6). The clone's in-flight branches and Drafts belong to other developers. The
risk stays for iteration 15; the replay's mid-flight run (iteration 14) is the only evidence.

Decision for 15 (developer, 2026-11-02): one stage after a freeze. Work in flight stops at a
phase boundary, the switch is the `remove-first` commit set this rehearsal drove end to end, and
open change branches take `develop` by merge. Both flows never coexist, so T1–T5 do not arise.
The two-stage switch stays the fallback where a freeze is not possible, with T2–T4 in stage 1.

## Result

Released as adf 0.18.0 (contract 1.8: the optional declaration field `requiredConfig`), with
adf-english-check 0.7.0, adf-npm-workspaces 0.2.0, adf-postgres 0.2.0 and adf-jira 0.5.0; tag
`v0.18.0`, the `ref` a host's project settings name. Steps 1–14 are done; every finding above
is fixed except F5 and N13 (decided, not fixed here). The port's issues #1–#10 are closed.

The `v0.18.0` tag points at a commit whose suite fails two contract-version assertions (the
plugin code is the same); adf 0.18.1, tag `v0.18.1`, is the same release on a passing commit
and is the `ref` to name.

- Steps 1–12 ran as one branch each (`fix/14b-*`), merged into `feat/plugin-core`.
- Step 13 is `docs/switching.md`: the one-stage switch after a freeze, the two-stage fallback
  and the developer's migration guide.
- Step 14: `npm test` passes; `npm run parity -- <origin>` passes 23 of 23 tools, the origin
  checkout unchanged. Four parity classes are new: `rotated` (a log finding moved into its
  month's archive), `ledger-lead-in` (N19), `origin-anchor` (the origin's own window anchor,
  which init's seed replaces after the switch) and `rounded-inputs` (the origin averages
  rounded per-change values).

Not done here: the rehearsal was not repeated on 0.18.0. Iteration 15 is its first real run.
