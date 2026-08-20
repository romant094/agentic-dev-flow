# Flow Specifications (historical reference)

These nine documents describe how the agentic dev flow itself works. They were written by
the flow, about the flow, while it was being built in the project it grew in — each one is
the archived output of a real `propose → apply → verify → review → archive` cycle.

**They are documentation, not live specifications.** Nothing reads them at runtime. No
command, skill or script resolves a path under `docs/flow-specs/`. They were moved out of
`openspec/specs/` precisely so that adopting this flow does not drop nine foreign
capabilities into a host project's own spec directory.

## What this means for a host project

`openspec/specs/` in your repository is yours. It starts empty (it ships with only a
`.gitkeep`) and is filled, one capability at a time, by `/opsx:archive` as your own changes
are archived. Nothing in this directory is merged into it, ever.

So when a command, skill or one of the spec documents below says *"`openspec/specs/` is
written only by `/opsx:archive`"*, it is talking about that live directory in your
repository — not about these files.

## What they are good for

- Understanding what each stage of the cycle is contractually required to do, in more
  detail than `README.md` or `.claude/CLAUDE.md` carry.
- Seeing the reasoning in requirement form: every guard here exists because something went
  wrong without it. `.claude/memory/concepts/opsx-workflow.md` tells the same story as
  narrative, including the approaches that were tried and dropped.
- Deciding whether to keep, adapt or drop a guard when you adopt the flow.

Because they are historical, they can drift from what the commands actually do. Where a
document here and the behaviour of `.claude/commands/opsx/` disagree, **the commands are
right** — the reverse of the rule that applied while these were live specs.

## The nine capabilities

| Capability | What it describes |
|---|---|
| [`change-workflow-schema`](change-workflow-schema/spec.md) | The cycle, its eight artifacts, and who may write the main specs |
| [`change-branch-isolation`](change-branch-isolation/spec.md) | Branch and worktree lifecycle, one per change |
| [`merge-request-lifecycle`](merge-request-lifecycle/spec.md) | Who pushes and undrafts, and when |
| [`ci-unit-testing`](ci-unit-testing/spec.md) | Which stage runs which tests |
| [`ai-review-flow-stage`](ai-review-flow-stage/spec.md) | The local review stage, `/opsx:review` |
| [`ai-review-ci-gate`](ai-review-ci-gate/spec.md) | The merge request review gate in CI |
| [`superpowers-availability-gate`](superpowers-availability-gate/spec.md) | Why every command stops without the plugin |
| [`parallel-group-execution`](parallel-group-execution/spec.md) | Independent task groups in sibling worktrees |
| [`flow-retrospective`](flow-retrospective/spec.md) | The token/time retro over a past session |
