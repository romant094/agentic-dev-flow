<!-- sources:
- plugins/adf/skills/review/**
- plugins/adf/scripts/review.mjs
- plugins/adf/scripts/lib/review.mjs
- plugins/adf/schema/instructions/review.md
-->

# /adf:review

`/adf:review` runs the project's code review over the verified branch. It fixes the blocking findings in rounds. It writes `review.md`, the record that `/adf:archive` reads.

## What it takes

The change name, optional. Without it, the command uses the change named in the conversation, or else the active change.

Run it after `/adf:verify`. The preflight refuses, and writes nothing, in these cases:

- `verify.md` has no `Verdict:` line, or the verdict is `FAIL`.
- `verify.md` is not committed.
- A commit after `verify.md` touches a file outside the change directory. The code changed since verify: run `/adf:verify` again.

The reviewer reads the diff of the branch against the base, and nothing else. It judges the diff by the project's review prompt, `openspec/review-prompt.md`, the same prompt that CI reads.

## What it does

1. Start the run. A script measures the diff and applies the exclusion list.
2. Open a round, write the reviewer's input and dispatch `ai-review r<k>`.
3. Store the reply. A script checks it and numbers the findings.
4. Fix each blocking finding with one `ai-fix F<n> r<k>` agent at a time.
5. Settle the findings that remain with you.
6. Open the next round, which re-reviews the fixes. Repeat until nothing is left to review.
7. Run the suite when a fix landed.
8. Assemble and commit the record.

A round cap of 3 applies. Past it, the command goes to you with the open findings.

## What it asks

- Whether a tool that the change adds must run on a real input first. This applies when no recorded run fed the tool a real input. You run it with the command as a verify check, then run `/adf:verify` again.
- Approval of the slices, when the diff is larger than one reviewer takes. The approval is recorded as the `review-slices` ruling.
- A ruling on each false-positive claim of a fixer. The command gives its own assessment. A dismissal needs your reason and a marker on the line, committed with `review.mjs mark --commit`.
- Whether to leave a blocking finding as it is. This is an acceptance, with your reason.
- Whether to allow a round past the cap.
- The reason for each non-blocking finding that stays unfixed. The command records it.

Only your own words make a ruling. Silence never does.

## The verdict

A script computes the verdict, `PASS` or `BLOCKED`. It is `BLOCKED` while a finding of a blocking severity is open, while a fix is not re-reviewed, or while the suite after the fixes fails without a ruling. The registry key `review.blockOn` sets the blocking severities.

| Verdict | Next step |
|---|---|
| `PASS` | `/adf:archive` |
| `BLOCKED` | Resolve the findings that the report names, then run `/adf:review` again. |

## What it writes and commits

| Where | What |
|---|---|
| `openspec/changes/<name>/review.md` | The record. |
| `.superpowers/sdd/<name>/review/` | The state of the run: inputs, replies and findings. |
| the change worktree | One commit for each fix, made by the fixer. A dismissal marker is a commit too. |

The commit of the record holds `review.md` and nothing else. Its message is `docs(openspec): review <name>`. The command pushes nothing.

With an empty filtered diff, no reviewer runs. The record is `PASS` and says that nothing was reviewed.

## How it resumes

Run `/adf:review` again.

- A committed `PASS` record stands when every later commit changes only the change directory or files that the filter excludes. The command measures nothing and names `/adf:archive` as the next step.
- A run of an earlier session that has rounds is kept. The command goes on from the stored rounds.
- `--fresh` discards a kept run and starts a new review. You must ask for it.
- A reviewer reply that fails its check goes back once to the same agent. A second invalid reply stops the stage. Only a new run with `--fresh` begins again.

Not checked: the default values of `review.blockOn` and `review.maxBytes`.

The Codex form of each command is in [the Codex page](../getting-started/codex.md).
