# Iteration 07 — Apply

## Goal

`/adf:apply` executes a change's plan: task groups in parallel worktrees, each task dispatched to
the agent of its capability level, reviewed, ticked and committed, without the origin's scripts.
The rules and their reasons are in `docs/lessons/apply.md`.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Contract `1.2`: the `forge` role's `push`; the GitLab plugin implements it | `roles.spec.mjs`, `registry.spec.mjs`; `plugins/gitlab/scripts/__tests__/forge.spec.mjs` |
| 2 | Change selection shared by apply, verify and archive: `changes.mjs find` over every checkout, the `resolve` block | `apply-git.spec.mjs` |
| 3 | Task group worktrees (`workspace.mjs group-add`, `group-merge`, `group-remove`, `groups`), rooted at the main checkout | `apply-git.spec.mjs`, against real git repositories |
| 4 | The dispatch guard (`guard.mjs snapshot`, `compare`) | `apply-git.spec.mjs` |
| 5 | Ticking on return (`tasks.mjs tick`) | `tasks.spec.mjs` |
| 6 | The reply check (`reply.mjs`, every role) and the SDD workspace check (`sdd.mjs`) | `reply.spec.mjs`, `sdd.spec.mjs`; `scripts/parity/origin-reply.mjs`, `origin-sdd.mjs` |
| 7 | The whole-suite command as a section of the planning guide; apply receives the guide | `changes.spec.mjs`; `plugins/adf/host/planning.md` |
| 8 | The apply instruction, `/adf:apply`, and the three capability-level agents | the lessons file's evidence; `schema.spec.mjs` (no repository-wide git mutation in dispatch-facing text) |

## Decisions

- One orchestrator: the main session runs Superpowers' subagent-driven development for every
  group and dispatches each task's implementer and reviewers into the group's worktree. The
  origin's per-group controller agent is gone; it cost about 96k tokens for four tasks and kept
  committing after it was stopped.
- The capability-level agents (`adf:mechanical`, `adf:integration`, `adf:architecture`) set
  effort and a turn ceiling per level and feed the metrics; they name no model.
- The whole-suite command lives in the planning guide. With none, apply finds it in the project's
  files, proposes it, and writes it there on the developer's confirmation; declined, the report
  says the suite was not run.
- For a test-first task the reviewer runs the new test on the parent commit's code, where it
  must fail, and on the new code, where it must pass.
- Worktree provisioning is the project stack plugin's (iteration 12); apply installs nothing.
- Push after each group merge goes through the forge role; with no forge plugin nothing is
  pushed. One task, one commit.
- Ticking happens when a dispatch returns, by a script; a dispatch round is guarded by one
  snapshot of every other checkout.
- A file added during apply is appended to its task's `**Files:**` block, dated.
- The `DUP` suppression marker is defined in the apply instruction; review points at it.
- Test counts in the implementer's reply are reconciled by verify (iteration 08); the reply roles
  stay the origin's here, for parity.

## Result

- `npm test`: 312 tests, 0 failures; `check-lessons.mjs`: every rule with a decision and
  evidence or a pending iteration; none pending on iteration 07.
- `npm run parity -- <origin>`: all nine tools PASS.
  - `origin-reply.mjs`: 1,220 replies (165 accepted, 1,055 refused); every difference is the
    output form (`json-output`).
  - `origin-sdd.mjs`: 384 cases; every difference is the output form.
  - `origin-mr.mjs`: unchanged by `push`.
- `claude plugin validate .`: passes.
- Not run: `/adf:apply` by an agent end to end, and the hook and forge on real systems. That is
  the behaviour check (iteration 14) and the live check (iteration 18).
- Open: the base-branch check of the whole-suite run makes its own detached worktree from the
  instruction; the workspace library has no operation for it yet.
