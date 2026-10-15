The procedure `/adf:apply` executes once the change is resolved and its plan is in place. The
command file carries the step order; the orchestrator's rules are stated here in full and the
command points at them. What a dispatched agent is told is stated in full in the prompt
skeletons under `${CLAUDE_PLUGIN_ROOT}/schema/prompts/`, which `dispatch.mjs prompt` fills; this
instruction names them and does not restate them. `<root>` is the change worktree the change was
resolved to, `<change>` its name. Every script below takes `--change <change> --root <root>`
and prints one JSON object; a mechanical step is that call, and you act on its result.

**Apply starts by confirming isolation, never by creating it.**

`preflight.mjs --phase apply` refuses a root that is the main checkout or not the top level of
its worktree, a branch that is unnamed or protected, a change whose plan is missing or whose
tasks are all ticked, a plan naming what the tree does not hold, and a foreign SDD workspace;
it then records the session. Print a refusal verbatim and stop: a blocked change is continued
by `/adf:propose <change>`, never by apply, and a plan finding is corrected in the plan before
anything is dispatched. Apply never makes the change's branch or worktree.

Do NOT invoke `superpowers:using-git-worktrees`, and ignore the line of
`subagent-driven-development` that sends you to it. The change already has its worktree; the
skill would make a second one at a path the host does not ignore, commit a `.gitignore` edit of
its own, and run a dependency install in it.

Apply installs nothing. The core makes a worktree and does nothing more to it: no dependency
install, no environment file, no database. A task that turns out to need a package that is not
installed stops and is reported as separate work: a dependency update is its own change.

**One orchestrator: the main session.**

The main session invokes `superpowers:subagent-driven-development` with the Skill tool and runs
it for every task group of the plan. It does not implement a task itself: it dispatches each
task's implementer and reviewers, as the capability-level agents, directly into the worktree of
the task's group. There is no per-group controller agent. Hold the skill to the rulings below,
or the same tests run three times and a merge menu appears that this flow never answers.

A runtime without subagent support uses `superpowers:executing-plans` instead. It brings no
test-first discipline and no review gate: follow the plan's RED and GREEN steps yourself, and
invoke `superpowers:requesting-code-review` after the last task, before the reuse sweep. This
fallback is for a missing capability of the runtime, not for a missing skill.

**The SDD workspace is named by the change, never by the plan's file name.**

The preflight writes `.superpowers/sdd/<change>/progress.md`, the skill's working memory, with
its identity line; the flow writes nothing else there and reads nothing from it. Every plan is
`plan.md`, so the skill's own default directory, `.superpowers/sdd/plan/`, is shared by every
change: a controller once read another change's progress there as its own and skipped completed
work. Call the skill's two scripts only through `sdd.mjs`, which passes the change's own output
path every time:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sdd.mjs" brief --change <change> --task <N> --root <root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/sdd.mjs" package --change <change> --base <ref> --head <ref> --root <root>
```

`brief` before a task's first dispatch, `package` before a review; `file` is the output. A
non-empty `stray` means a call wrote to the shared default and the script moved it: report it.

**Read the Execution Graph before Task 1, and never recompute it.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" schedule --change <change> --root <root>
```

It numbers the groups by their row in the graph's group table, applies the cap, and returns
`single`, `startNow` and `waiting`; a group keeps its letter in dispatch names. A plan with no
graph section is not dispatched, and a graph running a `strong` pair, or a `medium` pair marked
high-criticality, in one wave is refused: a graph that does is a plan defect, not a schedule.
Both exit 1; have the plan corrected.

**Fan-out within the cap is mandatory.**

The groups in `startNow` run at once in sibling group worktrees, at most 2-3 groups at once;
the rest wait for a slot. Running them one after another is a deliberate departure: record a
`deviation` naming the groups and the reason. No later check gates this; a gate that fires after
the work ran serially reports history rather than preventing it.

For each running group, make its worktree from the change branch's current HEAD:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-add --change <change> --group <N> --root <root>
```

The script roots the path at the main checkout itself: a relative path from inside the change
worktree once nested a group inside it, where removing the change worktree stranded it. Make
group worktrees only here, never by hand. When `single` is true, a graph naming exactly one
wave-1 group runs as one sequential pass in the change worktree, with no group worktree.

**Dispatch in rounds, under the tree guard.**

A round issues at most one dispatch per running group, all of them in one response, and waits
for the completion notices instead of polling. Within one worktree the skill's rule holds: one
implementer at a time. Before a round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" snapshot --change <change> --dispatch "<name>" [--dispatch "<name>" ...] --root <root>
```

Pass one `--dispatch` per dispatch of the round, its `name` from `dispatch.mjs prompt`; the
script places each dispatch as `dispatch.mjs` does and watches every other checkout. When every
dispatch of the round has returned, and before acting on any reply:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" compare --change <change> --root <root>
```

`ok` false means a dispatch wrote outside its worktree, into the main checkout, a sibling's
worktree or another change's: STOP apply and show `changed`. Three times an implementer wrote
where it was not sent, and nothing noticed but a refused merge and a crashed server. One
snapshot is open at a time, so no orchestrator write (a tick, a merge) happens inside a round.

**Every dispatch comes from `dispatch.mjs`.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" attempt --change <change> --name "<name>" --root <root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" prompt --change <change> --role <role> [--task <N>] [--group <G>] [--round <k>] [--topic <word>] [--question-file <file>] [--base <sha> --head <sha>] --root <root>
```

`prompt` returns the dispatch's `name`, `agent`, `worktree`, `replyFile` and `prompt`. Dispatch
`agent` with `name` as its short description and `prompt` as its text, both unchanged. The
script reads the task's `**Level:**`, so name the level in the dispatch by passing the agent it
chose; it puts reviews at the integration level or above and merge reviews and the final review
at the architecture level, and a fix loop entering round 2 is re-dispatched one level higher.
Round 1 resumes the implementer that holds the context. The roles are `impl`, `review`,
`re-review` and `fix` with `--task`; `fix` and `re-review` also with `--group`, or alone after
the final review, and with `--round` from round 1 on; `merge-review` with `--group`;
`final-review`; `sweep`; `investigate` with a one-word `--topic`. `--base` and `--head` are
commit ids, the range of the review package.

Name every dispatch in the fixed form. The name is what the metrics read the role, the task and
the round from; the script composes it, and a dispatch under any other name is not counted.

Dispatch every subagent as the agent of its level. The mechanical level takes only work the
flow checks itself: a diff that is reviewed afterwards, a search, an inventory, a move,
formatting. A claim nobody re-checks ("committed", "the suite is green", anything about a live
environment) goes one level up, or the question requires the raw command output instead of an
account of it. Every fabricated report this flow has recorded was such a claim from the
cheapest level. Which model runs a level is the runtime's choice; flow text never names a model
or a vendor.

You write only the question, into `--question-file`: for a review, what to look at; for a fix,
the findings; for a merge resolver or a merge review, the conflict list or the context. The
skeletons carry every fixed rule an agent follows (`implementer`, `reviewer`, `merge-review`,
`test-first`, `sweep`, `read-only`, `git`, `reply`), among them the implementer's duty to
state the task's Files, Interfaces and acceptance criteria before the first edit; a question
restates none of them. A continuation sentence is not a prompt: a fresh agent holds none of the prior
context and spends its output rediscovering it. One more step of earlier work goes to the agent
that holds that context, by resuming it, not to a new dispatch. A read-only question about the
branch gets no worktree isolation of its own: it writes nothing. A read-only verdict that does
not answer gets a second, wider read-only dispatch, never the orchestrator opening the files.

**A fix loop's round comes from `dispatch.mjs round`.** When a review, a re-review, a merge
review or the final review returns a load-bearing finding, ask where its loop stands:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" round --change <change> [--task <N> | --group <G>] --root <root>
```

`--task` for a task's loop, `--group` for the loop after a merge review, neither after the final
review. It counts the rounds from the recorded attempts, a round being one `fix` and its scoped
`re-review`, so the count survives a handoff and never rests on memory. `next` is one of:

- `fix`: dispatch `fix`, then `reReview`, the round's two names, with `--round` set to `round`;
- `adjudicate`: a task at the breaker. Rule on each open finding as the skill's breaker does and
  record each as a `ruling`; a load-bearing finding you cannot rule on blocks the task's group,
  or pauses a single-group pass;
- `escalate-to-developer`: a group's loop or the final review's at the breaker. Stop and put
  the open findings to the developer.

**The reply is a file of its role's shape.**

The prompt names the reply file, an absolute path into the change worktree, never a group
worktree, which is removed after its merge and takes its files along. A reply file is never
overwritten: the script takes `-2`, `-3` when the name is taken. This replaces the report
formats of the Superpowers prompts for these roles; the plugin's files are never edited. Before
acting on a reply, validate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reply.mjs" --role <role> <reply file> --root <root>
```

Act on no reply it refuses. Record an attempt before every dispatch and every retry: `next`
`dispatch` sends it; on a refusal, `retry` means it goes back once, to the same agent, resumed,
with the `reasons`; `stop` means the dispatch is `BLOCKED`: it produced no result, and nothing it
reported is recorded. A reply that is prose and no file is a refusal.

**Rulings over the Superpowers defaults.** Inside an apply run these override the skills that
load beside `subagent-driven-development`:

- **The report is the evidence.** An `impl` or `fix` reply whose `tests` names the covering
  tests' command and carries its output is the evidence that the task's tests pass. You do not
  re-run them, and the independent re-checks of `superpowers:verification-before-completion`
  and `superpowers:dispatching-parallel-agents` do not apply to it. A reply missing the command
  or its output goes back to its implementer.
- **Per task, the covering tests; once, the whole suite.** The whole suite runs once, at the end.
- **One task, one commit,** also when the skill batches small same-shape tasks into one
  dispatch.
- **Stop at `finishing-a-development-branch`.** When the skill reaches its finish step, control
  returns to apply. Do not invoke `superpowers:finishing-a-development-branch`: its suite run,
  merge menu and branch options are covered by apply's whole-suite run and by archive, which
  owns the merge request.

**Test-first only where the task says so.** The skill's implementer writes a failing test
first only "if task says to". Before Task 1, say which tasks are test-driven: `testFirst` of
`apply-status.mjs`, the plan's tasks carrying both a RED and a GREEN step. A task that should be (a behaviour change whose
failing test can be written before the code) and is not listed is corrected in the plan text
before it is dispatched. The `review` prompt of a test-first task carries the `test-first`
skeleton; pass `--base` and `--head` so it names the task's commit.

The per-task code review and the final whole-branch review come with
`subagent-driven-development`; do not invoke them by hand. The final whole-branch review runs at
the architecture level once every group is merged: it catches defects between tasks that no task
review saw.

**Tick a task when its last dispatch returns.**

A task is complete when its review, or its last re-review, passes, or when the skill's breaker
parks its findings with a ruling. Then, after the round's guard compare:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.mjs" tick --plan-task <N> --change <change> --root <root> --commit
```

It ticks the `tasks.md` item the plan task's back-reference names and commits it, with
`plan.md` when it changed. No agent edits a checkbox by hand. Ticks land in the change worktree,
never a group's, so two groups never conflict over `tasks.md`, and committing at once leaves the
change worktree clean for the next merge.

**Work added during apply is recorded against the plan.**

Every fix (a task's fix round, a merge fix, the final-review fix, the sweep's consolidation) is
followed by its scoped `re-review`, and that is where the files it added are found: the `prompt`
call of a `re-review` given the fix's range as `--base` and `--head` also returns `unplanned`,
each file the range touched that no task names, with its `owner`, the task itself in a task's
round. For each file it lists, give the reason:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" added --change <change> --path <path> --why "<why>" [--task <N>] --root <root> [--commit]
```

It writes the dated "Added during apply" bullet into the owning task's Files block, the owner
`unplanned` proposed unless `--task` names another; with no owner, `--task` names one. Verify
reads only a backticked path. It compares the branch with the plan's file blocks: without the
line, a correct apply fails there. The next tick commits the plan; with no tick left, pass
`--commit` on the last `added` call, which commits `plan.md` alone.

**Merge a group as soon as every task of it is complete.**

From the change worktree, never a group's:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-merge --change <change> --group <N> --root <root>
```

- `merged` true: the merge is made, but not done; `package` is the merge-review package.
- `merged` false: `conflicts` lists the files and the merge is left in progress. Dispatch a
  scoped resolver, `fix` with `--group`, with the conflict list and both groups' tasks in the
  question. Any conflict goes to it, not only mechanical hunks. It completes the merge commit;
  run `group-merge` again for the package.

Either way, the merge is done only when a scoped `merge-review` with `--group` over that
package passes. A load-bearing finding is fixed forward in the change branch, one `fix` and one
scoped `re-review` per round, both with `--group` and `--round`, the mechanism of a task's own
fix loop; the merge is never reverted, since a rollback discards the other groups' merged work.
At the breaker, `round --group` says `escalate-to-developer`. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-finish --change <change> --group <N> --root <root>
```

It removes the group's worktree and branch and pushes the change branch through the forge role.
**Push after each group merge, from the change worktree.** A push from a group worktree pushes
the group branch instead. A single-group pass pushes once its last task is ticked:
`forge.mjs push --change <change> --root <root>`. The push is a backup and a progress signal:
the draft merge request gates nothing, so nobody waits on it or reacts to it. Read `push.state`:
`none` means no forge plugin is enabled and nothing is pushed, which is not an error; `degraded`
is reported with its `hint` and apply continues; `refused` is reported as it is.

**Wave 2, and a blocked group.**

After each merge, `apply-status.mjs --change <change> --root <root>` names the groups to start
now, `startable`. A wave-2 group starts once every wave-1 group it depends on, by the graph's
stated dependency or by the coupling that kept it out of wave 1, is merged and its merge review
passed; it then runs like a wave-1 group, from the change branch's new HEAD, under the same cap.
Nothing depends on a wave-2 group: there is no wave 3.

A group whose fix loop reaches the round-5 breaker with a load-bearing finding stays `BLOCKED`:
keep its worktree, do not merge its branch, and report it. Whether it is blocked, and why, is
your judgement; the record is the script's:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-status.mjs" handoff --change <change> --next "<dispatch>" --block <G> --reason "<why>" --root <root>
```

It writes a `handoff` with the reason, whose merged groups, remaining items and
blocked groups come from the state, so the group stays blocked in every later handoff until it
is merged. Every independent group, running or queued,
continues and merges. Only the wave-2 groups that depend on it wait. Apply concludes only when
every group worktree is merged and removed; a blocked group pauses apply, with its worktree
kept for the developer.

**The code reuse sweep: once per change, over the merged branch.**

When every group is merged, every task ticked and the final review's fixes are in, issue the
`sweep` dispatch, exactly once, before the whole-suite run. Never per group: a duplicate
introduced by two groups is invisible to either group's own sweep, and that is the case most
worth catching. It is not a phase: no artifact, no verify check, no command. `dispatch.mjs`
puts it at the integration level: a cheap dispatch answers `CLEAN` almost always, which leaves
the gate green forever and indistinguishable from a working one. Its prompt carries the base,
the range and, when a delta spec carries `REMOVED` or `RENAMED`, the second question on each
requirement's `**Code Disposition:**`, all read by `sweep.mjs inputs`. It holds no write access
and no fix authority, and dispatches no agent; its tree access widens no other reviewer's
scope.

Read the reply through the filter, not `reply.mjs`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep.mjs" filter <reply file> --record --change <change> --root <root>
```

It validates the reply and drops every finding whose introduced location carries a `DUP`
marker naming that existing location. A sweep with no accepted reply after its retry is no
verdict, never `CLEAN`. `--record` writes each entry of an accepted reply's `dispositions` as a
`debt` carrying the sweep's answer as its reason; it never blocks apply.

**A sweep finding naming both locations blocks apply from concluding.** It is the only
maintainability finding that blocks; every other stays advisory. Resolution is one of two
things: consolidate on the existing code, or the developer dismisses the finding. Re-running
the sweep does not clear it: a second `CLEAN` on an unchanged branch would launder the first
finding.

The consolidation is reviewed work, not an untasked edit: a `fix` dispatch with a scoped
`re-review`, and its files get "Added during apply" lines. Neither the sweep nor apply
dismisses a finding. A finding you believe is a false positive goes to the developer with the
reasoning; silence is not approval, because an automatic dismissal is indistinguishable from a
missed finding. On the developer's dismissal:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dup.mjs" mark --change <change> --file <introduced file> [--line <n>] --existing "<existing>" --why "<the finding's why>" --reason "<the developer's reason>" --root <root> --commit
```

It places the `DUP` marker on the introduced location, records the accepted debt, which
archive resolves as `accepted`, and commits the marked file alone. The marker stops a
later sweep re-reporting an acceptance already made; the debt record stops the acceptance being
forgotten. A format with no comment syntax is refused before anything is written: consolidate
instead, or the debt record alone carries the acceptance (`ledger.mjs debt ... --accepted`), and
a later sweep may report the pair again.

**The `DUP` marker grammar.** This instruction owns it; the review stage reads it from here, and
`lib/dup.mjs` writes it. The marker is one comment, in the file's own comment syntax, on the
line directly above the introduced location, or on its first line when the whole file is the
duplicate. Its text is:

```text
ADF DUP <existing> -- <reason>
```

`<existing>` is the finding's `existing` value, verbatim; `<reason>` is the developer's, in one
line. For example `// ADF DUP src/a.ts:12 -- the wire format differs` or `# ADF DUP
config/base.yaml:4 -- kept per environment`.

**The whole suite, once, at the end.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/suite.mjs" run --change <change> --root <root> --base-check --record --commit
```

It runs the `## Whole-suite command` of the project's planning guide, `openspec/planning.md`,
uncached, with `<root>` as the working directory, its output to a file, never to your context.
It is the whole suite, not the parts this change touched: this is the only point where a
cross-group regression shows, since two groups green in isolation can merge red. A failure
blocks unless it also fails on the change's base. `--base-check` checks that in a throwaway
worktree of the base, never by stashing, made as `workspace.mjs base-check-add --change <change>
--root <root>` makes it and removed, never forced; `preExisting` failures are named as separate
work and do not block, `newFailures` pause apply like any other implementation issue, and a
base that cannot run the command blocks until the developer rules. When the runner's names
cannot be parsed and the two failure sets only partly overlap, `comparison` says so: judge it
from the output files, and say how.

`status` `not-run` means the guide holds no command. Find one in the project's own files (its
package manifest's scripts, a build file, its continuous-integration configuration), propose it
to the developer, and on their confirmation record it and run again:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/suite.mjs" set --command "<command>" --root <root> --commit
```

On a decline, run nothing and report that the whole suite was not run; never a silent pass.

`--record` writes `openspec/changes/<change>/.apply-test-record.md`, whose `**Commit:**` line
verify reads, and `--commit` commits that file alone. Run it as apply's final commit, after
every tick and any documentation commit: verify reads the commits after this record, and a
record written earlier leaves work it does not cover.

**The execution ledger records what only the executing agent knows.**

Write it only through `ledger.mjs <kind> --change <change> --root <root>`, never by editing the
file; the script refuses a malformed record with the reason. It lives in the change worktree
whatever worktree the writer works in.

- `deviation --rule <rule> --reason <why> [--task <n>]` for every deliberate departure from an
  apply rule: a named wave not fanned out, a task meeting the split rule and not split, a
  question needing several files answered without delegating. A rule correctly judged
  inapplicable is not a deviation.
- `debt --what <compromise> --reason <why> [--task <n>] [--accepted <reason>]` for every code
  compromise; archive refuses to leave one unresolved.
- `ruling --finding <finding> --decision <what and why> [--task <n>]` for every adjudication.
- a `handoff` at a handoff, written by `apply-status.mjs handoff --change <change> --next
  "<dispatch>" --root <root>`, which takes the merged groups, the remaining items and the
  blocked groups from the state.

Dispatches, tokens, models, effort and timings are not recorded: the transcripts hold them, and
the transcript outranks the ledger on any number. Record entries at a group boundary, not one
turn per event: every orchestrator turn re-reads its whole context.

**Handoff instead of mid-apply compaction.**

At the threshold, finish the current group, record a `handoff`, and stop for a fresh session;
never mid-group or mid-dispatch, where no record describes the state. The threshold is
observable: a group boundary reached with several groups merged this session, a compaction
signal from the harness, or a dispatch returning after an anomalous number of turns; never a
self-estimate of the context size. The resumed session comes up from `apply-status.mjs` alone:
merged, running and blocked groups, the ticked and remaining items, the open debt and the last
handoff.

**If a skill invocation fails, STOP.**

Report which skill is missing and print the `install` command the Superpowers gate gives. Never
do a missing skill's work by hand: the execution discipline (test-first, subagent review,
worktree isolation) is why this flow exists, and substituting yourself for it produces a change
that looks reviewed and is not. This rule governs a missing skill only; the fallback for a
runtime without subagents stays as stated above.

When apply concludes, the next phases are verify, until no blocking issue remains, and then
review; archive refuses a change without its review record. The memory ingest happens at
archive, not here.
