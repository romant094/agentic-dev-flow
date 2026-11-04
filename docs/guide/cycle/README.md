<!-- sources:
- plugins/adf/skills/propose/**
- plugins/adf/skills/apply/**
- plugins/adf/skills/verify/**
- plugins/adf/skills/review/**
- plugins/adf/skills/archive/**
- plugins/adf/scripts/propose.mjs
- plugins/adf/scripts/apply-status.mjs
- plugins/adf/scripts/verify.mjs
- plugins/adf/scripts/review.mjs
- plugins/adf/scripts/archive.mjs
- plugins/adf/scripts/lib/propose.mjs
- plugins/adf/scripts/lib/apply-status.mjs
- plugins/adf/scripts/lib/verify.mjs
- plugins/adf/scripts/lib/review.mjs
- plugins/adf/scripts/lib/archive.mjs
-->

# The main cycle

A change goes through five stages. Each stage is one command, and each command leaves a record in the project. For one change from start to end, see [Your first change](../getting-started/first-change.md). For the Codex form of each command, see [the Codex page](../getting-started/codex.md).

## The stages

```text
propose -> apply -> verify -> review -> archive
```

| Stage | Command | Result |
|---|---|---|
| propose | [/adf:propose](propose.md) | A branch, a worktree and the artifacts up to the plan. |
| apply | [/adf:apply](apply.md) | The code of the plan, in the worktree. |
| verify | [/adf:verify](verify.md) | `verify.md`: does the code match the artifacts. |
| review | [/adf:review](review.md) | `review.md`: the code review and its fixes. |
| archive | [/adf:archive](archive.md) | The specs merged, the change archived, the worktree removed. |

Each command takes the change name as an optional argument, except `/adf:propose`, which needs a name or a description. Without a name, a command uses the active change. A rerun of a command resumes where the last run stopped.

The command `/adf:land` is not part of this cycle. It follows the merge of the merge request. For the full cycle with `land`, see [the extension points](../extension-points/README.md).

The command [/adf:retro](retro.md) is apart from the cycle. It assesses the flow over archived changes.

## The artifacts

| Where | What |
|---|---|
| `openspec/changes/<name>/` | The change in flight: `brainstorm.md`, `proposal.md`, `design.md` (optional), `specs/`, `tasks.md`, `plan.md`, then `verify.md` and `review.md`. |
| `openspec/changes/archive/<date>-<name>/` | The same directory after `/adf:archive`. |
| `openspec/specs/` | The main specs. Only `/adf:archive` writes them. |
| `.claude/worktrees/` | One worktree for each change. `/adf:archive` removes it. |
| `.superpowers/sdd/<name>/` | The working state of the commands: ledger, verify and review runs, archive state. |

The flow never merges the merge request. You merge it.
