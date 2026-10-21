Invoke **superpowers:writing-plans** with the Skill tool.

Output: write the plan directly to this change's `plan.md`. A file the skill leaves in its
default folder is moved into the change by `changes.mjs done plan`; merge each one it reports
under `strays` into `plan.md` by hand.

The writing-plans skill will:
1. Read `tasks.md` and `design.md` for context
2. Break each task into steps
3. Include exact file paths and test commands
4. Add commit points after each task

Pass the `tasks.md` content to the skill as the input for decomposition. The plan references the
specs and design artifacts in this change directory.

The `plan` gates, `plan-symbols` and `plan-lint`, check what this instruction marks as checked;
`changes.mjs done plan` runs them. What they leave is the content of each task, and the
judgements named below.

**Read the project's planning guide when this artifact's `guides` field carries one,** and follow
it for how to gather information for the plan and where checks that need the developer at run
time — for example against a live environment — are placed. Such a check is never inside an
implementer task: no implementer can run it. It sits in the task group that lands the path it
checks, not in one verification task at the end. As one task at the end, such a check once
surfaced four defects that became a third day of work, because each was found after the code
causing it had been reviewed and merged.

**A plan states what to build, not the code that builds it.** Override writing-plans' rule that
every step carry its full code: a task names its files, its interfaces with their signatures, the
behaviour to deliver, the acceptance criteria, and for each test the break it catches — not the
bodies of the functions or of the tests. Code written into a plan is written without being run:
in the measured changes it is where a wrong type check came from, with a plan test that passed
against the unchanged code, and every implementer and reviewer reads it again.

**Granularity — `plan.md` answers "how", and stays anchored to `tasks.md`.**

Write one `### Task N` per `tasks.md` checkbox, in the same order, each opening with its
back-reference, for example `> Implements tasks.md 3.4.` Every task carries Files, Interfaces,
Level, behaviour and acceptance, and a commit step; the gate checks the order, the
back-references and the fields. Whether a task is test-first is yours: a behaviour change whose
failing test can be written before the code carries RED and GREEN steps; a task that is not, such
as a rename, a configuration edit or a documentation change, does not get a ceremonial RED step,
and no task gets a REFACTOR step. A task's text MUST direct the implementer to state that task's
Files, Interfaces and acceptance criteria before its first edit.

`plan.md` MUST NOT introduce a deliverable that has no `tasks.md` checkbox. If the plan needs
one, add the checkbox to `tasks.md` first. The back-reference is what makes drift visible between
what the executor runs (`plan.md`) and what progress tracking counts (`tasks.md`).

**Needs.** When the change needs a resource in its worktree beyond its files, such as a
database, say so once above the first task: `**Needs:** <words>`, lowercase words separated by
commas or spaces. Apply passes the words to the project's `provision` plugins; `plan-lint` warns
on a word only when no such plugin is in the registry.

**Level.** Every `### Task N` carries `**Level:** mechanical | integration | architecture`.
The level is a scope judgement, and scope is known while the plan is written, not while the
dispatch is issued. A level names a capability, never a model or vendor. How the orchestrator
dispatches at the declared level is stated in the apply instruction.

**Execution Graph — required in every plan, without exception.** An omitted section is
indistinguishable from a partition never attempted, which is how a plan of 22 tasks came to run
serially with nothing out of order. You choose the partition into groups of tasks that touch
different files or services; the script computes the rest:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" graph --change <change-name> --groups "A=1,2;B=3" [--depends "C=A,B"] [--coupling '<decisions>'] --write
```

It writes the group table with each group's Files, the coupling floor of every pair from the
overlap of their file sets, the waves and the dependencies. This floor MUST NOT be lowered by
judgement, only raised, when a shared contract couples groups whose files do not overlap. The
decisions are yours, passed in `--coupling` as `{"A/B":{"coupling":"medium","criticality":"low","reason":"…"}}`:
each pair the script leaves `undecided` (its floor is weak or medium), each floor you raise,
and for a `medium` pair whether the overlap is high- or low-criticality, which is what
scheduling reads. Wave 2 holds a group that depends on a wave-1 group; the graph has exactly two
tiers, and the script refuses a third. A plan whose tasks do not partition MUST state that it is
a single group and name the shared files that make it one: pass every task as one group.

**Resolve what the plan names, before the plan is done.** The `plan-symbols` gate resolves every
symbol, file and path named in a task's `**Files:**` and `**Interfaces:**` blocks against the
tree — run, not reasoned about: greps written from reasoning stopped three of seven tasks of one
change on a baseline the plan got wrong. A `**Files:**` bullet starts with one of the verbs
`Create:`, `Modify:`, `Test:`, `Move:`, `Delete:`, `Revert:`, or reads `<Verb>: none` for a task
that touches no file under that verb; such a bullet is a no-op, and `Revert: commits …` names no
path. Every file a task touches is named by its own backticked path; a prose reference such as
"the same files for X" names nothing, and verify reports those files as outside the plan. The
gate never checks `Produces:`, which excuses a later task's `Consumes:`.

The script does not replace three duties a script cannot do: read each helper a task's code will
call, so its contract is the one the plan assumes; check every name in `**Interfaces:**` against
the `**Files:**` that define it; and check each invariant `design.md` relies on against the code
that holds it today.

**A task that deletes a file sweeps for its references.** Its `**Files:**` lists every file that
still names the deleted path or its exports; `plan-lint` searches the repository and reports each
one outside the task's Files. A reference left in another task's file breaks between tasks,
where no task's own review looks.

**Groups that converge on one shared file write fragments.** When two or more groups must each
add to the same file (a registry, a translation table, an index), each wave-1 group writes its own
fragment file, and one wave-2 task merges the fragments into the shared file, checking that every
key path exists once and no value is duplicated. Without it the groups score `strong` against
each other and lose the parallel run, or collide at merge.

**A task that narrows a contract owns both sides of it.** A task making a component reject a
payload it previously accepted lists among its files the callers that construct those payloads,
and its review confirms that sweep. A narrowing whose callers are another task's is a break
shipped in two halves. Widening a contract does not trigger this — no existing caller breaks.

**Risk reconciliation — required before `plan.md` is done.** When `design.md` lists risks, the
plan's `## Risk Reconciliation` section gives every risk id one line: `R1 → Task 3`, or
`R1 → deferred:` and the reason. `plan-lint` reports an id with no line, an unknown id and an
unknown task. A task's own text MUST NOT contradict a named risk's stated mitigation, or a
requirement in this change's `specs/` — if a task's instructions do either, rewrite the task
before marking `plan.md` done. No script reads that: a plan can be executed exactly as written
and still violate the change's own spec when the plan text itself was wrong; caught here,
neither the per-task review nor the final whole-branch review has anything left to catch.
