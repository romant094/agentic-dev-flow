Invoke **superpowers:writing-plans** with the Skill tool.

Output redirection:
- Do NOT write to `docs/superpowers/plans/`. Write the plan directly to this change's `plan.md`;
  the skill's default location is outside the change, where the artifact would be missing and
  the graph blocked.

The writing-plans skill will:
1. Read `tasks.md` and `design.md` for context
2. Break each task into steps
3. Include exact file paths and test commands
4. Add commit points after each task

Pass the `tasks.md` content to the skill as the input for decomposition. The plan references the
specs and design artifacts in this change directory.

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

Write one `### Task N` per `tasks.md` checkbox, in the same order. Each one MUST open with an
explicit back-reference naming the checkbox it implements, for example `> Implements tasks.md
3.4.` Every task carries Files, Interfaces, Level, behaviour and acceptance, and a commit step. A
task that is test-first — a behaviour change whose failing test can be written before the code —
also carries RED and GREEN steps; a task that is not, such as a rename, a configuration edit or a
documentation change, does not get a ceremonial RED step, and no task gets a REFACTOR step. A
task's text MUST direct the implementer to state that task's Files, Interfaces and acceptance
criteria before its first edit.

`plan.md` MUST NOT introduce a deliverable that has no `tasks.md` checkbox. If the plan needs
one, add the checkbox to `tasks.md` first. The back-reference is what makes drift visible between
what the executor runs (`plan.md`) and what progress tracking counts (`tasks.md`).

**Level.** Every `### Task N` MUST carry `**Level:** mechanical | integration | architecture`.
The level is a scope judgement, and scope is known while the plan is written, not while the
dispatch is issued. A level names a capability, never a model or vendor. How the orchestrator
dispatches at the declared level is stated in the apply instruction.

**Execution Graph — required in every plan, without exception.**

Add an `## Execution Graph` section (see the template) before the first `### Task N`. When the
plan's tasks partition into groups that touch different files or services, score the coupling of
every pair of groups from the file sets in each group's tasks' `**Files:**` blocks: zero overlap
is `none`; overlap limited to files neither group writes is `weak` or `medium`; any file both
groups write is `strong`. This floor MUST NOT be lowered by judgement, only raised, when a shared
contract couples groups whose files do not overlap. A `medium` score MUST state, inline, whether
the overlap is high- or low-criticality — that reasoning, not a separate score, is what
scheduling reads. Assign every group to wave 1 (may run in parallel with any other wave-1 group
scored `none`, `weak` or low-criticality `medium` against it, capped at 2-3 concurrent) or wave 2
(depends on one or more wave-1 groups, by explicit dependency or by `strong` or high-criticality
`medium` coupling that rules out sharing a wave). No group may depend on a wave-2 group — the
graph has exactly two tiers. A plan whose tasks do not partition MUST state that it is a single
group and name the shared files that make it one. An omitted section is indistinguishable from a
partition never attempted, which is how a plan of 22 tasks came to run serially with nothing out
of order.

**Resolve what the plan names, before the plan is done.** Every symbol, file and path named in a
task's `**Files:**` and `**Interfaces:**` blocks MUST be resolved against the tree before
`plan.md` is marked done, by `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-symbols.mjs" <change-name>`
— run, not reasoned about: greps written from reasoning stopped three of seven tasks of one
change on a baseline the plan got wrong. A `**Files:**` bullet starts with one of the verbs
`Create:`, `Modify:`, `Test:`, `Move:`, `Delete:`, `Revert:`, or reads `<Verb>: none` for a task
that touches no file under that verb; such a bullet is a no-op, and `Revert: commits …` names no
path. A line the script cannot parse is reported, never dropped. The script reports a missing
path, an existing `Create:` path, a line range past its file's end, and a `Consumes:` symbol
found neither in its named path nor in the tracked tree outside the change records; it never
checks `Produces:`, which excuses a later task's `Consumes:`. In the measured session the
equivalent scan at apply took four minutes and found five real plan defects.

The script does not replace three duties a script cannot do: read each helper a task's code will
call, so its contract is the one the plan assumes; check every name in `**Interfaces:**` against
the `**Files:**` that define it; and check each invariant `design.md` relies on against the code
that holds it today.

**A task that deletes a file sweeps for its references.** Its acceptance includes a search of the
whole repository for the deleted file's path and exported names, and its `**Files:**` lists every
file that still names it. A reference left in another task's file breaks between tasks, where no
task's own review looks.

**Groups that converge on one shared file write fragments.** When two or more groups must each
add to the same file (a registry, a translation table, an index), each wave-1 group writes its own
fragment file, and one wave-2 task merges the fragments into the shared file, checking that every
key path exists once and no value is duplicated. Without it the groups score `strong` against
each other and lose the parallel run, or collide at merge.

**A task that narrows a contract owns both sides of it.** A task making a component reject a
payload it previously accepted lists among its files the callers that construct those payloads,
and its review confirms that sweep. A narrowing whose callers are another task's is a break
shipped in two halves. Widening a contract does not trigger this — no existing caller breaks.

**Risk reconciliation — required before `plan.md` is done.** If this change's `design.md` has a
Risks / Trade-offs section, `plan.md` is not complete until every risk listed there has an
explicit line naming which Task addresses it, or an explicit, reasoned statement that the risk is
deferred and why. A task's own text MUST NOT contradict a named risk's stated mitigation, or a
requirement in this change's `specs/` — if a task's instructions do either, rewrite the task
before marking `plan.md` done. A plan can be executed exactly as written and still violate the
change's own spec when the plan text itself was wrong; caught here, neither the per-task review
nor the final whole-branch review has anything left to catch.
