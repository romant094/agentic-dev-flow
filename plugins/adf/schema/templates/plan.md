# [Feature Name] Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development
> to implement this plan task-by-task.

**Goal:** <!-- One sentence -->

**Architecture:** <!-- 2-3 sentences -->

**Tech Stack:** <!-- Key technologies -->

## Risk Reconciliation

<!-- Only when design.md lists risks: one line per risk id, naming the Task that addresses it,
     or `deferred` and why. -->
- R1 → Task <!-- N --> <!-- or: R1 → deferred: <reason> -->

## Execution Graph

<!-- Required in every plan. A plan whose tasks do not partition states that it is a single
     group and names the shared files that make it one. -->

<!-- One row per group. "Files" is the union of that group's tasks' **Files:** entries. -->

| Group | Tasks | Files | Wave |
|---|---|---|---|
| <!-- A --> | <!-- 1, 2 --> | <!-- paths --> | <!-- 1 or 2 --> |

<!-- Coupling matrix: one row per pair that is not "none" by the file-overlap floor. -->

| Group A | Group B | Coupling | Reasoning (required if medium) |
|---|---|---|---|
| <!-- A --> | <!-- B --> | <!-- none / weak / medium / strong --> | <!-- why, and criticality if medium --> |

<!-- Wave 2 dependencies, if any: -->
<!-- Group <X> (wave 2) depends on: Group <A>, Group <B> -->

---

### Task 1: <!-- what this task delivers -->

> Implements `tasks.md` <!-- N.M -->.

**Files:**
- Create: <!-- path --> — <!-- what goes in it -->
- Modify: <!-- path --> — <!-- which lines, and why -->
<!-- Each bullet starts with Create:, Modify:, Test:, Move:, Delete: or Revert:; "<Verb>: none" is a no-op. -->
<!-- A check that needs the developer at run time is placed as the project's planning guide says, in the group that lands the path it checks — never inside an implementer task. -->
<!-- A task narrowing a contract lists here the callers that construct the payloads it now rejects. -->

**Interfaces:** <!-- signatures, types or contracts this task fixes; "none" is an answer -->

**Level:** <!-- mechanical | integration | architecture -->

**Behaviour and acceptance:** <!-- what the task delivers, and how it is known to be done — no code bodies -->

<!-- Before the first edit, the implementer states this task's Files, Interfaces and acceptance criteria. -->
<!-- RED and GREEN only when the task is test-first: a behaviour change whose failing test can be written before the code. -->
- [ ] **Step 1: RED** — <!-- the test, the break it catches, and the command that runs it -->
- [ ] **Step 2: GREEN** — <!-- the behaviour that makes it pass -->
- [ ] **Step 3: Verify** — <!-- the covering tests' command, and its expected output -->
- [ ] **Step 4: Commit** — <!-- the Conventional Commits message -->

---

### Task 2: <!-- one ### Task per tasks.md checkbox, in the same order -->
