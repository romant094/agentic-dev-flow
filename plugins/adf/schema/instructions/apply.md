The procedure `/adf:apply` executes once the change is resolved and its plan is in place. The
command file carries the step order; the rules below are stated here in full and the command
points at them. `<root>` is the change worktree the change was resolved to, `<change>` its name.

**Apply starts by confirming isolation, never by creating it.**

Propose made the branch and the worktree. Confirm where you are:

```bash
git -C <root> rev-parse --show-toplevel
git -C <root> rev-parse --path-format=absolute --git-common-dir
```

The first must print `<root>`. The parent directory of the second is the main checkout,
`<main>` below. Equal roots mean the change has no worktree of its own: STOP, since every commit
would land on the main checkout's branch. Apply never makes the change's branch or worktree.

Do NOT invoke `superpowers:using-git-worktrees`, and ignore the line of
`subagent-driven-development` that sends you to it. The change already has its worktree; the
skill would make a second one at a path the host does not ignore, commit a `.gitignore` edit of
its own, and run a dependency install in it.

Apply installs nothing. The core makes a worktree and does nothing more to it: no dependency
install, no environment file, no database. A task that turns out to need a package that is not
installed stops and is reported as separate work: a dependency update is its own change.

**Apply is blocked without `plan.md`.**

When `instructions apply` reports `state` `blocked`, name the missing artifact and stop; edit no
source file. Re-running apply will not create it: the way forward is `/adf:propose <change>`,
which continues the change's artifacts up to the plan. `all_done` means every task is ticked:
say so and point at `/adf:verify`.

**The plan symbol check runs before the first dispatch.**

Run `plan-symbols.mjs <change> --phase apply --root <root>`, in the change worktree, never from
the main checkout, which holds no plan. It is a backstop expected to report nothing: propose
already ran it. On a finding, STOP, print the findings verbatim, dispatch nothing, and correct the
plan before re-running. `--phase apply` skips ticked tasks and exempts what the branch already
did since its base, so a resumed apply does not report its own earlier work.

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

Before invoking the skill, write `<root>/.superpowers/sdd/<change>/progress.md` with exactly one
line, its identity: `# SDD ledger — plan: <root>/openspec/changes/<change>/plan.md`. Every plan
is `plan.md`, so the skill's own default, a directory named after the plan file's basename
(`.superpowers/sdd/plan/`), is shared by every change; a controller once read another change's
progress there as its own and skipped completed work. The file is the skill's working memory:
the flow writes nothing else there and reads nothing from it. Run `sdd.mjs --change <change>
--root <root>` before the first dispatch; on a non-zero exit, STOP and print it verbatim. A
foreign ledger is moved aside, never deleted.

Call the skill's two scripts with their output argument, every time, never relying on the
default path:

```bash
bash <skill dir>/scripts/task-brief <plan> <N> <root>/.superpowers/sdd/<change>/task-<N>-brief.md
bash <skill dir>/scripts/review-package <plan> <BASE> <HEAD> <root>/.superpowers/sdd/<change>/review-<base7>..<head7>.diff
```

`<plan>` is the absolute path of the change's `plan.md`; `<BASE>` and `<HEAD>` are commit ids,
not names, because the package is cut while other groups move their own branches. After each
call, confirm that `<root>/.superpowers/sdd/plan/` does not exist. If it does, the call took its
default path: move what it wrote into the change's workspace, and pass the output argument from
then on.

**Read the Execution Graph before Task 1, and never recompute it.**

The plan's `## Execution Graph` assigns every group to wave 1 or wave 2. A plan with no graph
section is not dispatched: stop and have the plan corrected. Number the groups by their row in
the graph's group table, the first row 1; a group keeps its letter in dispatch names. Apply
never runs a `strong` pair, or a `medium` pair marked high-criticality, in one wave; a graph
that does is a plan defect, not a schedule.

**Fan-out within the cap is mandatory.**

Two or more wave-1 groups eligible to share a wave run in sibling group worktrees, at most 2-3
groups at once; groups beyond the cap wait for a slot. Running them one after another is a
deliberate departure: record a `deviation` naming the groups and the reason. No later check
gates this; a gate that fires after the work ran serially reports history rather than
preventing it.

For each running group, make its worktree from the change branch's current HEAD:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-add --change <change> --group <N> --root <root>
```

`root` in the result is the group's worktree, `<main>/.claude/worktrees/<change>--group-<N>/`,
on branch `<change branch>--group-<N>`. The script roots the path at the main checkout itself:
a relative path from inside the change worktree once nested a group inside it, where removing
the change worktree stranded it. Make group worktrees only here, never by hand.

A graph naming exactly one wave-1 group runs as one sequential pass in the change worktree, with
no group worktree; `<target>` below is then `<root>`.

**Dispatch in rounds, under the tree guard.**

A round issues at most one dispatch per running group, all of them in one response, and waits
for the completion notices instead of polling. Within one worktree the skill's rule holds: one
implementer at a time. Before a round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" snapshot --change <change> --targets <target1,target2> --root <root>
```

`--targets` lists the worktree of every dispatch in the round. When every dispatch of the round
has returned, and before acting on any reply:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" compare --change <change> --root <root>
```

`ok` false means a dispatch wrote outside its worktree, into the main checkout, a sibling's
worktree or another change's: STOP apply and show `changed`. Three times an implementer wrote
where it was not sent, and nothing noticed but a refused merge and a crashed server. One
snapshot is open at a time, so no orchestrator write (a tick, a merge) happens inside a round.

**Match the agent to the work.**

Dispatch every subagent as the agent of its level: `adf:mechanical`, `adf:integration` or
`adf:architecture`. A task goes at the `**Level:**` its plan text declares; name the level in the
dispatch. Each agent sets the effort and the turn ceiling for its level and names no model,
because effort left unset runs at a default that moves with the model. Which model runs it is
the runtime's choice; flow text never names a model or a vendor. The turn ceiling is an
emergency stop: an agent at its ceiling returns partial work that you resume.

- The mechanical level takes only work the flow checks itself: a diff that is reviewed
  afterwards, a search, an inventory, a move, formatting. A claim nobody re-checks ("committed",
  "the suite is green", anything about a live environment) goes one level up, or the dispatch
  requires the raw command output instead of an account of it. Every fabricated report this
  flow has recorded was such a claim from the cheapest level.
- Task reviews and re-reviews go at the integration level or above; a merge review, the final
  whole-branch review and every adjudication go at the architecture level.
- A fix loop entering round 2 is re-dispatched one level higher than the task's level (the
  architecture level stays there): a level set too low is otherwise paid for twice. Round 1
  resumes the implementer that holds the context.

**Name every dispatch in the fixed form.**

The short description of a dispatch is what the metrics read the role, the task and the round
from. A task dispatch is `T<n> <role>`, and its fix round `k` is `T<n> <role> r<k>`, with `<n>`
the plan's task number and the role one of `impl`, `review`, `re-review`, `fix`. A dispatch that
serves no single task is the role alone, with the group's letter where it has one:
`final-review`, `merge-review B`, `fix B`, `re-review B`, `sweep`, `investigate <topic>` (one
word). A fix after a merge review or the final review is `fix`, and its second look
`re-review`, not a new role.

**Every dispatch prompt carries five things.**

The task id; the worktree, as an absolute path; the files in scope; the question; and the
answer's shape, which is its reply role and its reply file. A continuation sentence is not a
prompt: a fresh agent holds none of the prior context and spends its output rediscovering it.
One more step of earlier work goes to the agent that holds that context, by resuming it, not to
a new dispatch. A read-only question about the branch gets no worktree isolation of its own: it
writes nothing. A read-only verdict that does not answer gets a second, wider read-only
dispatch, never the orchestrator opening the files.

Every path in a dispatch and in a verification command is absolute, and git runs as
`git -C <worktree>`; a working-directory sentence does not bind an agent's later tool calls,
and one group ignored its worktree that way and bypassed the review gate. No dispatch text asks
for a repository-wide git mutation: an agent stages its files by path, never everything, and
never stashes, cleans, restores or checks out over its working tree. A broad staging command in a
shared checkout once destroyed two uncommitted files of the developer's.

An implementer prompt also says:

- read the task brief first; do not read the whole plan;
- state the task's Files, Interfaces and acceptance criteria before the first edit, and solve
  from that statement rather than from the plan as a whole;
- one task, one commit, in Conventional Commits form, made in the task's worktree;
- never edit a checkbox in `tasks.md`: the flow ticks it;
- dispatch no subagent of its own;
- record every code compromise taken (a stub, an accepted duplication, a deferred refactor) with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" debt --change <change> --what <compromise>
  --reason <why> --task <n> --root <root>`.

A reviewer that accepts a compromise records it the same way.

**The reply is a file of its role's shape.**

Every dispatch in the roles `impl`, `fix`, `review`, `re-review`, `final-review`,
`merge-review`, `sweep`, `investigate` and `spec-merge` writes its reply as one JSON object,
carrying its `role`, to its reply file, and returns the path instead of a prose report. The reply
file is `<root>/.superpowers/sdd/<change>/replies/<dispatch name, spaces as hyphens>.json`: an
absolute path into the change worktree, never a group worktree, which is removed after its merge
and takes its files along. A reply file is never overwritten: when the name is taken, the reply
takes `-2`, `-3` before `.json`, and the dispatch name stays the same. The prompt names the role
and tells the agent to read its shape from the header of
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/reply.mjs`; it does not inline the shape. This replaces the
report formats of the Superpowers prompts for these roles; the plugin's files are never edited.

Before acting on a reply, validate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reply.mjs" --role <role> <reply file> --root <root>
```

Act on no reply it refuses. A refused reply goes back once, to the same agent, resumed, with the
`reasons`. A reply that is prose and no file is a refusal. A second refusal is `BLOCKED`: the
dispatch produced no result, and nothing it reported is recorded.

**Rulings over the Superpowers defaults.** Inside an apply run these override the skills that
load beside `subagent-driven-development`:

- **The report is the evidence.** An `impl` or `fix` reply whose `tests` names the covering
  tests' command and carries its output is the evidence that the task's tests pass. Neither you
  nor a reviewer re-runs them to confirm it, and the independent re-checks of
  `superpowers:verification-before-completion` and `superpowers:dispatching-parallel-agents` do
  not apply to it. A reply missing the command or its output goes back to its implementer. A
  green result is evidence only of the configuration it ran under: a reply that changed the
  environment to make the tests pass says so in `concerns`.
- **Per task, the covering tests; once, the whole suite.** An implementer runs the tests that
  cover the files its task names, not the whole suite, whatever
  `superpowers:test-driven-development` says about running everything. Which tests cover a file
  is the implementer's call. The whole suite runs once, at the end.
- **Self-review is a read of the diff against the task.** The implementer reads its own diff
  against the task's **Behaviour and acceptance** and its **Files:** block, fixes what does not
  match, and reports only what that read changed. A checklist answered "yes" is no evidence.
- **One task, one commit,** also when the skill batches small same-shape tasks into one
  dispatch.
- **Stop at `finishing-a-development-branch`.** When the skill reaches its finish step, control
  returns to apply. Do not invoke `superpowers:finishing-a-development-branch`: its suite run,
  merge menu and branch options are covered by apply's whole-suite run and by archive, which
  owns the merge request.

**Test-first only where the task says so.** The skill's implementer writes a failing test
first only "if task says to". Before Task 1, read the plan and say which tasks are test-driven.
A task that should be (a behaviour change whose failing test can be written before the code)
and does not state RED and GREEN is corrected in the plan text before it is dispatched.

**For a test-first task, the review proves the new test can fail.** The reviewer writes the
task's parent commit's version of each source file the task changed over the file
(`git -C <worktree> show <parent>:<path> > <worktree>/<path>`), and moves a source file the task
created into a temporary file. It runs the new test: it must fail. It then restores each file
from the task's commit the same way, and the new test must pass; `git -C <worktree> status
--porcelain` must then print nothing. No stash. Four tests on one branch once passed against
their own unfixed code, and no reviewer noticed.

The per-task code review and the final whole-branch review come with
`subagent-driven-development`; do not invoke them by hand. The final whole-branch review runs at
the architecture level once every group is merged: it catches defects between tasks that no task
review saw.

**Tick a task when its last dispatch returns.**

A task is complete when its review, or its last re-review, passes, or when the skill's breaker
parks its findings with a ruling. Then, after the round's guard compare, tick its `tasks.md`
item, the one its plan task's back-reference names, and commit the tick at once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.mjs" tick <item> --change <change> --root <root>
git -C <root> commit -m "chore(openspec): tick <item> of <change>" -- openspec/changes/<change>/tasks.md
```

No agent edits a checkbox by hand. Ticks land in the change worktree, never a group's, so two
groups never conflict over `tasks.md`, and committing at once leaves the change worktree clean
for the next merge.

**Work added during apply is recorded against the plan.**

A fix round, a merge fix, the final-review fix or the sweep's consolidation that touches a file
outside its task's `**Files:**` block adds that file to the owning task's block in the change
worktree's `plan.md`, as one bullet: `- <Verb>: <path> — Added during apply, <YYYY-MM-DD>:
<why>`. Work that serves no single task belongs to the task whose files it changed most. Commit
the plan with the next tick, or on its own. Verify compares the branch with the plan's file
blocks; without the line, a correct apply fails there.

**Merge a group as soon as every task of it is complete.**

From the change worktree, never a group's:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-merge --change <change> --group <N> --root <root>
```

- `merged` true: the merge is made, but not done.
- `merged` false: `conflicts` lists the files and the merge is left in progress. Dispatch a
  scoped resolver, `fix <G>`, into the change worktree with the conflict list, both groups'
  tasks and their **Behaviour and acceptance**. Any conflict goes to it, not only mechanical
  hunks. It completes the merge commit.

Either way, the merge is done only when a scoped `merge-review <G>` of the merge diff passes
(the package cut from the merge's first parent to the merge commit). It checks semantic
compatibility, not only the absence of conflict markers: two groups once mapped one message to
two keys, a clean textual merge that no task review could see. A load-bearing finding is fixed
forward in the change branch, one `fix <G>` dispatch and one scoped `re-review <G>`, the
mechanism of a task's own fix loop; the merge is never reverted, since a rollback discards the
other groups' merged work. The round-5 breaker escalates to the developer.

Then remove the group's worktree and branch, and push the change branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" group-remove --change <change> --group <N> --root <root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" push --root <root> --input '{"change":"<change>","branch":"<change branch>","protected":<protected list>}'
```

**Push after each group merge, from the change worktree.** A push from a group worktree pushes
the group branch instead. The point is reached the same way whether groups ran in parallel or
one after another; a single-group pass reaches it when its last task is ticked. The push is a
backup and a progress signal: the draft merge request gates nothing, so nobody waits on it or
reacts to it. Read `state`: `none` means no forge plugin is enabled and nothing is pushed, which
is not an error; `degraded` is reported with its `hint` and apply continues; `refused` is
reported as it is.

**Wave 2, and a blocked group.**

A wave-2 group starts once every wave-1 group it depends on, by the graph's stated dependency or
by the coupling that kept it out of wave 1, is merged and its merge review passed; it then runs
like a wave-1 group, from the change branch's new HEAD. Independent wave-2 groups run
concurrently under the same cap. Nothing depends on a wave-2 group: there is no wave 3.

A group whose fix loop reaches the round-5 breaker with a load-bearing finding stays `BLOCKED`:
keep its worktree, do not merge its branch, and report it. Every independent group, running or
queued, continues and merges. Only the wave-2 groups that depend on it wait. Apply concludes
only when every group worktree is merged and removed; a blocked group pauses apply, with its
worktree kept for the developer.

**The code reuse sweep: once per change, over the merged branch.**

When every group is merged, every task ticked and the final review's fixes are in, issue the
sweep, exactly once, before the whole-suite run. Never per group: a duplicate introduced by two
groups is invisible to either group's own sweep, and that is the case most worth catching. It
is not a phase: no artifact, no verify check, no command.

- **One read-only dispatch, `sweep`, at the integration level or above.** A cheap dispatch
  answers `CLEAN` almost always, which leaves the gate green forever and indistinguishable from
  a working one. It reads the branch diff against the change's base (from its `.adf.json`:
  `origin/<base>` when the host has a remote, else `<base>`, through `git merge-base`) and the
  working tree. It holds no write access and no fix authority, and dispatches no agent. Its
  tree access widens no other reviewer's scope.
- **One question:** does the branch add a symbol, helper, validator, mapper, constant set or
  pattern whose behaviour the tree already has. Naming, length, nesting, formatting, comments,
  test coverage, correctness, performance and security are out of scope: a sweep drifting into
  them becomes a second unbounded review. The project's planning guide may give examples of what
  counts in its stack.
- **The verdict is a `sweep` reply:** `CLEAN`, or `FINDINGS` with each finding's `introduced`
  and `existing` (a path with its line, or a symbol) and `why`, one sentence on what the two
  share. A finding that cannot name a pre-existing location is dropped, not reported at lower
  confidence. A sweep with no accepted reply after its retry is no verdict, never `CLEAN`. A pair
  whose introduced location carries a `DUP` marker naming that existing location is not
  reported.
- **A second question, only when the change's delta specs carry `REMOVED` or `RENAMED`:** is
  each such requirement's `**Code Disposition:**` true of the code, and is the old path still
  reachable. A missing `**Code Disposition:**` is itself the finding. The answer goes in the
  reply's `dispositions`. Record each such finding as a `debt` carrying the finding's reason; it
  never blocks apply.

**A sweep finding naming both locations blocks apply from concluding.** It is the only
maintainability finding that blocks; every other stays advisory. Resolution is one of two
things: consolidate on the existing code, or the developer dismisses the finding. Re-running
the sweep does not clear it: a second `CLEAN` on an unchanged branch would launder the first
finding.

The consolidation is reviewed work, not an untasked edit: a `fix` dispatch with a scoped
`re-review`, and its files get "Added during apply" lines. Neither the sweep nor apply
dismisses a finding. A finding you believe is a false positive goes to the developer with the
reasoning; silence is not approval, because an automatic dismissal is indistinguishable from a
missed finding.

On the developer's dismissal, do both:

1. Place a `DUP` marker on the introduced location.
2. Record `ledger.mjs debt --what <the duplication> --reason <the finding's why> --accepted
   <the developer's reason>`. Archive resolves it as `accepted`.

The marker stops a later sweep re-reporting an acceptance already made; the debt record stops
the acceptance being forgotten.

**The `DUP` marker grammar.** This instruction owns it; the review stage reads it from here. The
marker is one comment, in the file's own comment syntax, on the line directly above the
introduced location, or on its first line when the whole file is the duplicate. Its text is:

```text
ADF DUP <existing> -- <reason>
```

`<existing>` is the finding's `existing` value, verbatim; `<reason>` is the developer's, in one
line. For example `// ADF DUP src/a.ts:12 -- the wire format differs`, `# ADF DUP
config/base.yaml:4 -- kept per environment`, or `<!-- ADF DUP docs/setup.md -- the audiences
differ -->`. A file format with no comment syntax cannot carry a marker: consolidate instead, or
the debt record alone carries the acceptance, and a later sweep may report the pair again.

**The whole suite, once, at the end.**

The whole-suite command is the `## Whole-suite command` section of the project's planning guide,
`openspec/planning.md`, delivered in `guides`. Running it uncached is the command's own job: a
cached result is a replay of an earlier run, not evidence about this one. When the section holds
no command, find one in the project's own files (its package manifest's scripts, a build file,
its continuous-integration configuration), propose it to the developer, and on their
confirmation write it under that heading in `<root>/openspec/planning.md` and commit it:
`docs(openspec): record the whole-suite command`. On a decline, run nothing and report that the
whole suite was not run; never a silent pass.

Run it with `<root>` as the working directory. It is the whole suite, not the parts this change
touched: this is the only point where a cross-group regression shows, since two groups green in
isolation can merge red.

A failure blocks unless it also fails on the change's base. Check that in a throwaway worktree of
the base, never by stashing:

```bash
git -C <main> worktree add --detach <main>/.claude/worktrees/<change>--base-check <base ref>
```

Run the same command there, then remove it with `git -C <main> worktree remove
<main>/.claude/worktrees/<change>--base-check`; if git refuses, report it and leave it. A failure
that reproduces there is pre-existing: name it as separate work and do not block on it. If the
command cannot run in that worktree, say so; the failure then blocks until the developer rules.
A failure that does not reproduce pauses apply like any other implementation issue.

Write `<root>/openspec/changes/<change>/.apply-test-record.md`: the commit id, the command, the
real output, and the pre-existing failures named as separate work; or that the suite was not
run, and why. Commit it as apply's final commit, after every tick and any documentation commit:
verify reads the commits after this record, and a record written earlier leaves work it does not
cover.

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
- `handoff --merged <groups> --remaining <tasks> --next <dispatch>` at a handoff.

Dispatches, tokens, models, effort and timings are not recorded: the transcripts hold them, and
the transcript outranks the ledger on any number. "No compromise taken" reads as `ledger.mjs list
--change <change> --unresolved-debt --root <root>` printing an empty list. Record entries at a
group boundary, not one turn per event: every orchestrator turn re-reads its whole context.

**Handoff instead of mid-apply compaction.**

At the threshold, finish the current group, record a `handoff`, and stop for a fresh session;
never mid-group or mid-dispatch, where no record describes the state. The threshold is
observable: a group boundary reached with several groups merged this session, a compaction
signal from the harness, or a dispatch returning after an anomalous number of turns; never a
self-estimate of the context size. The resumed session comes up from the ledger, `tasks.md`,
`git log` and `workspace.mjs groups` alone.

**If a skill invocation fails, STOP.**

Report which skill is missing and print the `install` command the Superpowers gate gives. Never
do a missing skill's work by hand: the execution discipline (test-first, subagent review,
worktree isolation) is why this flow exists, and substituting yourself for it produces a change
that looks reviewed and is not. This rule governs a missing skill only; the fallback for a
runtime without subagents stays as stated above.

When apply concludes, the next phases are verify, until no blocking issue remains, and then
review; archive refuses a change without its review record. The memory ingest happens at
archive, not here.
