Create the task list that breaks down the implementation work.

Follow the template exactly. The apply phase parses the checkbox format to track progress; a task
not written as `- [ ]` is not tracked.

- Group related tasks under numbered `##` headings.
- Each task MUST be a checkbox: `- [ ] X.Y Task description`.
- Each task is small enough to complete in one session.
- Order tasks by dependency: what must be done first?

Reference the specs for what needs to be built, and `design.md`, when it exists, for how. The
design instruction states when `design.md` is written.

**Granularity — `tasks.md` answers "what", not "how".**

One checkbox is one independently reviewable deliverable, stated in domain terms. Do NOT put
source file paths or test commands in `tasks.md` — they belong in `plan.md`, and duplicated they
drift.

**Investigate before you checkbox — do not let the apply phase discover scope one fix at a time.**
Each checkbox becomes one implementer dispatch in the apply phase, one fresh subagent per task.
Splitting a domain into more checkboxes than it needs means more cold-start round trips later, so
decide checkbox boundaries with the domain's full scope in view, not just the first symptom found:

- **Cascading domains**: if a file or test suite might have more than one thing wrong with it (a
  fix to one assertion is likely to surface the next), read it in full — or, across several such
  files, dispatch read-only investigation in parallel with
  `superpowers:dispatching-parallel-agents` — before writing its checkbox. One checkbox then
  covers everything that domain needs, not the first fix found; a `plan.md` forced to grow
  mid-apply because a checkbox turned out incomplete is the sign this step was skipped.
- **Mechanical, independent items**: several small, unrelated changes (one-line configuration
  edits, single-assertion fixes) that need no isolated review attention share one checkbox
  instead of one each.
- Keep a checkbox on its own when the item is risky, large, or needs review attention isolated
  from its neighbours.

The bound in the other direction is structural, not a token number: a task whose `**Files:**`
block spans two of the host's packages (with no package map, two top-level source directories)
**and** changes a failure or rollback path is split before dispatch. Only the conjunction
triggers it. It is structural because an agent cannot reliably measure its own context at the
moment the split decision is made.
