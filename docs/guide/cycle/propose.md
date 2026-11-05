<!-- sources:
- plugins/adf/skills/propose/**
- plugins/adf/scripts/propose.mjs
- plugins/adf/scripts/lib/propose.mjs
- plugins/adf/scripts/lib/mr-links.mjs
- plugins/adf/schema/instructions/propose.md
-->

# /adf:propose

`/adf:propose` starts a change. It makes the branch and the worktree, then writes every artifact up to the plan. For one change from start to end, see [Your first change](../getting-started/first-change.md).

Use it for a feature or for a change to what the system does. Make a fix that restores specified behaviour, a typo or a dependency bump directly.

## What it takes

| Input | Meaning |
|---|---|
| a change name in kebab-case | The command uses it and asks nothing about the name. |
| a description | The command asks what you want to build, then derives the name. |
| tracker keys | The change works on these issues. Optional. |

Run the command in the main checkout, with no uncommitted tracked work.

## What it asks

1. The change name, when you gave a description. This is one open question.
2. Whether to continue the change or choose another name, when a worktree for the name exists.
3. Which gathered items belong to the change. The command gathers items from the debt store and, with a tracker enabled, from the tracker. It proposes a selection. You decide.
4. The answers to questions about each item it took. One read-only agent checks each item first. The command puts all questions in one message.
5. The base branch and the branch name, in one question. The base is the integration branch or the current branch.
6. Your yes before it writes to the tracker. A tracker write is a start of an issue or a retest of a bug.

The command asks about an artifact only when the context is unclear. Otherwise it decides and continues.

## What it writes and commits

The command makes a branch and a worktree. Every later step runs in the worktree. It never runs `git checkout` or `git switch` in the main checkout.

It writes these files under `openspec/changes/<name>/`:

| File | Note |
|---|---|
| `brainstorm.md` | Written with the Superpowers brainstorming skill. |
| `proposal.md` | Holds a `## Scope sources` section when the change has a scope. |
| `design.md` | Optional. |
| `specs/**/*.md` | The delta specs. The command can skip them with a reason when no requirement changes. |
| `specs-base.json` | The main-spec text of each requirement the deltas modify, remove or rename. A script writes it. |
| `scope.json` | A copy of the scope. Present when the scope holds an item or a skipped tracker. |
| `tasks.md` and `plan.md` | The task list and the plan that `/adf:apply` runs. |

`verify.md` and `review.md` come from later commands.

Each artifact has gates. The command fixes the findings of a gate in the artifact before it goes on.

The commit holds the change directory and nothing else. Its message is `docs(openspec): propose <name>`. The commit refuses while an artifact is not done, while a gate fails, or while anything else is staged.

After the commit, the command opens a merge request through the forge plugin. Without a forge plugin, it pushes nothing and the report says that no merge request exists. When the forge refuses, the artifacts stay committed. The Draft shows the links of the scope: one line for each taken or partial item, built from `scope.json` by a script. You do not write them. A change with no scope has no links in its Draft. A forge provider written for a contract below 1.10 shows no links in the Draft.

The command also records the active change of the worktree in `.adf/active.json`. This file is local and never committed.

## How it resumes

Run `/adf:propose <name>` again with the same name.

1. The preflight finds the worktree of the change and asks whether to continue it.
2. On a yes, the command makes the change the active change in that worktree.
3. It goes on at the artifact step. A script names the next artifact that is not done.

A refusal creates nothing. The preflight refuses when the Superpowers skills are missing, when the root is not the main checkout, or when tracked files have uncommitted changes. It never stashes or commits your work.

Not checked: the stay-on-branch mode named in the resolve instruction. This page describes the worktree mode only.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
