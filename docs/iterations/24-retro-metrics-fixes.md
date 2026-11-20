# Iteration 24 — Retro and metrics fixes

## Goal

A retrospective reads true figures: the knowledge base's files stay out of the git figures or the
retrospective stops, a change run from a shared orchestrator session is charged only its own
share, and the `lateCaught` signal fires after a task review that ended in rulings.

## Intent

The window retrospective `2026-11-19-window` of the origin project (adf 0.21.0) reported three
metric defects as findings of the flow, and deferred a decision because of them:

- #44: the knowledge provider failed, because the core ran it with the `node` on `PATH`; the
  `window` step still reported `done`, and `.claude/memory/log.md` tied every later fix merge to
  every earlier merge in `fixesAfter`.
- #47: one orchestrator session ran 13 quick changes and a full change through dispatched agents;
  each change's metrics record counted the whole session up to its archive.
- #49: every full change has a task review that ended in `rule`, so `lateCaught` was 0 in all
  of them, and two real late catches were missed.

## What exists (checked 2026-11-19, at 5328c4f)

- `lib/roles.mjs:64` `runProvider` runs a provider with `spawnSync('node', ...)`. It is the only
  `spawn`/`exec` of `node` in `plugins/*/scripts` outside the tests. `scripts/parity/` spawns
  `node` too; it is retired tooling, not part of a plugin. Several scripts print commands of the
  form `node "<script>" ...` for the agent to run (`lib/verify.mjs:649`, `lib/propose.mjs:189`,
  `lib/suite.mjs:79`, `adf-gitlab/scripts/lib/forge.mjs:330`); the agent's shell runs them, not
  the core.
- `lib/retro-run.mjs:244-245` `windowStep`: `exclude = knowledge.state === 'done' ?
  knowledge.paths : []`, and the step returns `done` in every case. `knowledgePaths`
  (`lib/roles.mjs:204`) returns `none` with no provider, `refused` on a failed call, or the
  provider's own `degraded`.
- The exclusion list (`lib/window.mjs:299` `excluder`) feeds `mergeFigures`: the touched files of
  each merge, so `diffLines`, `fixesAfter`, `fixesPerChangeWeek` and every per-kloc figure.
- `lib/retro.mjs:76` `lateCaught`: passed only when the last accepted (`valid`) review or
  re-review of every task has the result `clean`. The task review results are `clean`, `fix` and
  `rule`.
- `lib/transcripts.mjs` `buildSession`: a session with no record on the change's branch gets
  scope `session`, all its records, and `readSubagents` with no branch, so every dispatched agent
  of the session. The ledger names the orchestrator's session, since a dispatched agent runs the
  preflight with the session's id.
- Each subagent's `.meta.json` carries `parentAgentId` and `description`; its transcript records
  carry `cwd` and `gitBranch`, and its first user record holds the prompt. Every ADF dispatch
  prompt names the change's worktree.
- `lib/window.mjs:644-648` `sharedBranch` drops a change's transcript groups when another change
  of the window shares its branch. Nothing drops them when two records share a session.

## Calls made by the designer, not the developer

- **#44 (a), the node.** `runProvider` runs the provider with `process.execPath`, the node that
  runs the core. The parity scripts and the printed commands are left as they are (see
  Non-goals).
- **#44 (b), refuse, not degrade.** When the knowledge provider is enabled and its `context` call
  is `refused` or `degraded`, `window` fails: the refusal names the provider's error and says that
  the git figures would count the knowledge base's files, and asks to fix the provider and run
  `window` again. Nothing is written: no sidecar, no input, no dispatch. Why not mark the figures
  unavailable: the exclusion list feeds `diffLines`, so every size-normalised figure depends on
  it, and a report with most of its figures blank is worth less than a rerun. `window` is the
  second step, so a rerun loses nothing, and a failed step runs again by the retro state rules.
  With no knowledge provider (`none`) nothing changes.
- **#49, a ruled review passes.** A task's review passes when its last accepted review or
  re-review has the result `clean` or `rule`. A `rule` result that was accepted means the
  findings went to the developer's rulings; a ruling that sends the task back to fixing leads to
  a fix and a re-review, whose result is then the last one. The ledger is not read again per
  finding: the signal reads the attempts log only, as now. The signal's detail adds `ruled`, the
  tasks whose last review was `rule`.
- **#47, the change's own agent tree.** A session with no record on the change's branch is
  measured as now (scope `session`) unless it also ran another change's work. A dispatched agent
  works on this change when a record of it is on the change's branch (or a group branch), its
  `cwd` is in the change's worktree, or its prompt names the change's worktree; it works on
  another change when a record is on another branch that is neither an integration branch nor
  the base, or its `cwd` or prompt names another of the flow's worktrees
  (`<main>/.claude/worktrees/<name>`). A tree is a top-level agent and every descendant, by
  `parentAgentId`. When a tree of the session works on another change, the session is shared:
  - with one or more trees of this change, and none of them also working on another change, the
    session is measured as those trees, every agent whole, plus the orchestrator's records made
    while a tree ran (from its first to its last record): scope `tree`;
  - otherwise the change's transcript figures are none, with the reason
    `session <id> is shared with other changes, and <why>`, the same treatment as a shared
    branch. Partial figures would under-count with no sign of it.
  Two trees running at the same time both count the orchestrator's records of the overlap: a
  known over-count, smaller than the session.
- **#47, the records already written.** The window also drops the transcript figures of a change
  whose record has a session of scope `session` that another archived record names
  (`sharedSession`, beside `sharedBranch`), so the origin project's records written by 0.21.0
  stop distorting the aggregates. A record of scope `tree` measured its own share and is kept.
- **The record format.** `sources.transcripts.sessions[].scope` takes the new value `tree`. The
  schema already takes any string, so old records stay valid and readable;
  `contract/metrics-format.md` names the value.

## Non-goals

- #36, a switch for the metrics record, and #46, `subagent-cache-ttl` against the one-hour cache:
  deferred to the developer.
- The commands the core prints for the agent (`node "<script>" ...`) and the host's own commands
  (the planning guide's format command, a teardown script): the agent's shell or the host runs
  them, with its own `PATH`. The `record` failure named in #44 came from that `PATH`, not from
  the core; it stays open as a host setup note.
- `scripts/parity/`: retired since iteration 16, kept as the record of what was compared.
- Splitting the orchestrator's records between two trees that ran at the same time.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | #44: the provider runs with `process.execPath`; `window` fails on a refused or degraded knowledge call, nothing written; the retro instructions and guide page say so | `roles.spec.mjs`, `retro-cli.spec.mjs` |
| 2 | #49: `lateCaught` counts a `rule` review as passed, and names the ruled tasks | `retro.spec.mjs` |
| 3 | #47: the change's agent tree for a shared session (scope `tree`), none with a reason when it cannot be found; the window's `sharedSession` for the records already written; the format and the metrics guide page | `transcripts.spec.mjs`, `window.spec.mjs` |
| 4 | The whole suite, the guide check | `npm test` |

## Result

Each fix was written test first: the new test failed on the code before the fix and passed
after it.

- **#44.** `lib/roles.mjs` `runProvider` runs a provider with `process.execPath`; the contract's
  calling convention says so. Proved by `roles.spec.mjs` "a provider runs with the node that runs
  the core, not the node on PATH", which empties `PATH`. `lib/retro-run.mjs` `windowStep` fails on
  a `refused` or `degraded` knowledge call, with the provider's error and the reason, and writes
  no sidecar, input or dispatch; a rerun after the provider answers is `done`. Proved by
  `retro-cli.spec.mjs` "window fails on a refused or degraded knowledge call ...". The retro
  instructions, the retro skill and the guide page `cycle/retro.md` say what to do.
- **#49.** `lib/retro.mjs` `lateCaught` counts a task whose last accepted review or re-review is
  `rule` as passed, and names those tasks in `ruled`; a later re-review still decides. Proved by
  the added cases of `retro.spec.mjs` "signals: a task review left open counts nothing late ...".
  The issue's stricter form (every finding of the review ruled in the ledger) is not read: the
  designer's call above.
- **#47.** `lib/transcripts.mjs`: a session with no record on the change branch whose dispatched
  agents also worked on another change is measured as the change's agent trees and the
  orchestrator's records made while they ran (scope `tree`); with no tree of the change, or a
  tree that also worked on another change, the change's transcripts are `null` with the reason.
  A session that ran no other change's agents is measured whole, as before. Proved by three
  tests of `transcripts.spec.mjs` on a two-change orchestrator fixture. `lib/window.mjs` drops
  the transcript figures of a change whose `session`-scope session another archived record holds
  (`sharedSession`), for the records written before this fix; a `tree` share stays. Proved by
  `window.spec.mjs` "a session counted whole that another record also holds ...". The format
  (`contract/metrics-format.md`) and the guide page `concepts/metrics.md` name the new scope and
  the rule; the schema is unchanged, so every older record stays valid. The lesson evidence of
  `readSubagents` (`docs/lessons/metrics.md`) follows its new signature.

Checks: `npm test` green at every commit; at the last fix 1840 tests, 1835 passed, 0 failed,
5 skipped; `check-lessons.mjs`, `check-release.mjs` and `check-guide.mjs` with no error.

Open:

- The `remove` failure named in #44, the `adf-postgres` teardown, ran through the same
  `runProvider` and is fixed with it. The `record` failure came from the planning guide's format
  command, a host command run with the shell's `PATH`; the core does not choose its `node`. A
  host whose node comes from a version manager must put it on `PATH` for non-interactive shells.
- #36 and #46 are deferred to the developer.

## Follow-up: the metrics switch (#36)

The developer's decision (2026-11-20, the issue's last comment): a registry switch for the
metrics record, on by default and asked at `/adf:init`, and a section at the top of the guide
page `concepts/metrics.md` that says what is collected, where it is kept, what leaves the
machine and why it is worth keeping on.

What changed:

- `lib/registry.mjs`: `metrics.enabled`, `true` or `false`, checked by
  `validateMetricsSettings`; `metricsSwitch` reads it (a missing key is on, `recorded` false)
  and `setMetricsSwitch` writes it. `metrics.mjs switch [--set true|false]` is the CLI.
- `/adf:init` asks in a new step 10, only when `recorded` is false, and reports
  `Metrics record: on|off`.
- `lib/archive.mjs`: with the switch off, `metrics` is `skipped` with no record and no price
  fetch, `detail.report` saying so; `commit-metrics` commits the ledger copy alone, or is
  `skipped` when the copy is current; the report says the hurt signals were not read.
- `/adf:quick` writes its record through the same archive steps, so the switch covers it with
  no change of its own.
- `lib/window.mjs`: with the switch off, the sidecar's coverage holds `metrics: "off"`, an absent
  record's reason names the switch, and `metricsOffReport` gives the line `retro.mjs window`
  returns as `detail.metrics`; the rendered report's Records line says metrics are off.
- `/adf:update`: nothing. A registry with no key keeps metrics on, so no migration is needed.

Calls made by the implementer, not the developer:

- **The key is `metrics.enabled`, not a boolean `metrics`.** The registry already holds a
  `metrics` object with `pricesUrl`; a boolean in its place would drop that setting. The
  switch lives beside it.
- **`commit-metrics` still copies the ledger with metrics off.** The step also carries the
  ledger records written after `move` into the archived change; skipping it whole would lose
  them. With metrics off it commits that copy alone, `chore(archive): copy the ledger of
  <name>`, and is `skipped` only when the copy is current.
- **A record written before the switch was turned off still counts in the retrospective.** The
  window line says the window has no records when none is there, else that it has no new ones
  and how many were written before.
- **`metrics.mjs prices fetch` by hand still fetches.** The switch governs archive's automatic
  fetch; a developer's explicit fetch is their own call.
- **No contract version change.** The key is a core registry setting, not a field of the
  extension contract that a plugin reads.

Checks: `npm test` green at each commit; 1882 tests, 1877 passed, 0 failed, 5 skipped;
`check-lessons.mjs`, `check-release.mjs` and `check-guide.mjs` with no error.
