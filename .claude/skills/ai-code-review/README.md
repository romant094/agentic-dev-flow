# ai-code-review

Runs the project's tuned code-review prompt over the current branch and fixes the
blocking findings, before the merge request pipeline does.

## Why it exists

`ai_claude_inspect` runs `infra/claude/review-prompt.md` against merge requests targeting
`develop` and fails the pipeline on CRITICAL or HIGH findings. It does **not** run while a
merge request is a draft — and since `/opsx:propose` opens one as a draft and
`/opsx:archive` undrafts it only at the end, a change spends most of its life with no CI
review at all. That makes this skill the only review the work gets until then. The exact
conditions live in `.gitlab-ci.yml`'s `ai_claude_inspect` rule; do not restate them here.

Meeting that review for the first time after pushing is the slowest and most expensive way
to learn about a bug. This skill runs the same prompt while the branch is still local.

## The one rule

`infra/claude/review-prompt.md` is read at run time and never copied. Two copies drift,
and the drift shows up as a local pass followed by a CI block. Changing what the review
looks for means editing that file — which changes CI at the same time, by construction.

## How it is invoked

- Directly, by name, on any branch.
- By `/opsx:review`, as the review stage of the `sdd-plus-superpowers` flow, between
  `/opsx:verify` and `/opsx:archive`. In that mode it also writes `review.md` in the
  change directory, which `/opsx:archive` requires.

## Shape

Review the filtered branch diff at the highest available capability → **validate the
response before acting on it** → fix each CRITICAL/HIGH finding with a scoped subagent
→ put any false-positive claim to the developer → re-review only the fix diff → stop
after three rounds.

A response missing its Executive Summary, its verdict or its structured findings stops
the stage: no record is written, no fix is dispatched, and there is no retry. CI refuses
the same responses, by the same rule.

Token cost comes down by sending less, never by reviewing less carefully: the diff
excludes what the prompt orders the reviewer to skip (all `.md` files, both
`.gitlab-ci` files) and what it cannot conclude anything from (lock files, `dist/`,
minified bundles, source maps, snapshots, coverage). For an OpenSpec change that is
most of the diff. Fix subagents see one finding and one file. Later rounds see only the
fixes.

## Related

- `infra/claude/review.sh` — the CI side, same prompt.
- `infra/claude/review-verdict.sh` — the CI gate's verdict reader.
- `.claude/commands/opsx/review.md` — the flow stage.
