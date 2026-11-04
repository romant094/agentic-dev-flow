<!-- sources:
- plugins/adf/skills/verify/**
- plugins/adf/scripts/verify.mjs
- plugins/adf/scripts/lib/verify.mjs
- plugins/adf/schema/instructions/verify.md
-->

# /adf:verify

`/adf:verify` checks that the code matches the specs, the tasks and the design of the change. It writes `verify.md`, the record that `/adf:review` reads.

## What it takes

The change name, optional. Without it, the command uses the change named in the conversation, or else the active change.

Run it after `/adf:apply`. The preflight refuses when the root is the main checkout, when the branch is unnamed or protected, or when the plan is not done. It writes nothing in that case.

## What it does

1. Run the mechanical checks with `verify.mjs run --suite`.
2. Dispatch two read-only agents in one response: `verify c4` and `verify c8`.
3. Show each proposed skill edit and ask for approval.
4. Run the checks that need you, when the plan assigns any.
5. Compute the verdict with a script.
6. Assemble and commit the record.

The mechanical checks:

| Check | What it checks |
|---|---|
| `validation` | The artifacts of the change validate strictly. |
| `tasks` | Every item of `tasks.md` is ticked. |
| `deltas` | The delta of each capability against its main spec. |
| `specs-base` | The base snapshot in `specs-base.json` matches the deltas. |
| `tree` | No uncommitted file, untracked files included. |
| `test-record` | The apply test record still describes HEAD. |
| `worktrees` | No task-group worktree of the change remains. |
| `out-of-plan` | Every changed file is named by a task's `**Files:**` block. |

The check `test-record` cites the record while no commit outside the change directory follows it. Otherwise the whole suite runs again in the same call, with a base check.

The two agents judge what a script cannot:

- `verify c4` compares the design and the specs with each other and with the code. It also lists which paths of each new mechanism a test or a run exercised.
- `verify c8` looks for stale statements in the project's own skills under `.claude/skills/`.

A plugin can add checks of its own. Each check is named `ext:<plugin>:<id>`.

## What it asks

- Whether to apply each CONFIRMED edit of a stale skill. No skill file changes without your explicit approval. A decline needs a reason and is recorded as a ruling on `c8`.
- The result of a check that needs you, such as a live environment or real hardware. You agree the verdict with the command.
- A ruling, when you accept a failing or not-run check. A ruling needs your own words and a reason. The checks `tree` and `worktrees` cannot be accepted.

## The verdict

A script computes the verdict: `PASS`, `PASS WITH WARNINGS` or `FAIL`. A failing check without a ruling makes it `FAIL`.

| Verdict | Next step |
|---|---|
| `PASS` or `PASS WITH WARNINGS` | `/adf:review` |
| `FAIL` | Fix what the failing checks name, then run `/adf:verify` again. A code fix goes through an apply round: see [/adf:apply](apply.md). |

## What it writes and commits

| Where | What |
|---|---|
| `openspec/changes/<name>/verify.md` | The record. Its last line is the verdict. |
| `.superpowers/sdd/<name>/verify/` | The raw output and the sections of each check. |
| `.claude/skills/` | An approved skill edit, in a commit of its own. |

The commit of the record holds `verify.md` and nothing else. Its message is `docs(openspec): verify <name>`. The command pushes nothing and removes no worktree.

## How it resumes

Run `/adf:verify` again, as often as needed. Each run produces every section again and overwrites `verify.md`.

A run in the same session and at the same HEAD keeps the sections. A run in another session, or at a HEAD that moved, clears them first. Commits that touch only the change directory, or files that the review filter excludes, do not move the HEAD for this rule.

When the verdict refuses, the result names the calls that fix it. Run them, then compute the verdict again.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
