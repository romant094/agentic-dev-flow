---
name: ai-code-review
description: Use to run the project's tuned AI code review over the current branch and fix what it finds, before the merge request does. Runs the same prompt GitLab CI runs, so a branch that passes here passes there. Triggers on "review my branch", "run the code review", "ai code review", "проверь ветку ревью".
---

# AI Code Review

Runs `infra/claude/review-prompt.md` — the same prompt `ai_claude_inspect` runs in CI —
over this branch's diff, then fixes the blocking findings.

**Read the prompt file. Never restate it.** It is the single copy of what the review
looks for: the Confidence Gate, the false-positive suppression list, the
SNMP/Prisma/NestJS/React CWE table and the `// review-ignore:` suppression marker
grammar. A paraphrase here would drift from what CI enforces, and the failure mode is
the worst available — passing locally and blocking on the merge request.

## Severity thresholds

CRITICAL and HIGH are blocking and start a fix round. MEDIUM and LOW are recorded and
never block. These are the prompt's own BLOCK / REQUEST CHANGES / APPROVE semantics
and the CI gate applies the same ones.

## Procedure

### 1. Collect the diff

```bash
git fetch origin develop
git diff --merge-base origin/develop HEAD -- \
  ':(exclude)*.md' \
  ':(exclude).gitlab-ci.yml' \
  ':(exclude).gitlab-ci-playbook.yml' \
  ':(exclude)package-lock.json' \
  ':(exclude)**/package-lock.json' \
  ':(exclude)**/yarn.lock' \
  ':(exclude)**/pnpm-lock.yaml' \
  ':(exclude)**/*.min.js' \
  ':(exclude)**/*.min.css' \
  ':(exclude)**/*.map' \
  ':(exclude)dist/**' \
  ':(exclude)**/dist/**' \
  ':(exclude)generated.*' \
  ':(exclude)**/generated.*' \
  ':(exclude)*.generated.*' \
  ':(exclude)**/*.generated.*' \
  ':(exclude)**/__snapshots__/**' \
  ':(exclude)coverage/**' \
  ':(exclude)**/coverage/**'
```

The exclusions are not an optimisation applied against the prompt's wishes. The prompt
orders the reviewer to skip all `.md` files and both `.gitlab-ci` files, and the rest
mirrors the filter `infra/claude/review.sh` already applies to the CI diff. Sending
them would pay for tokens the reviewer is instructed to ignore — and for an OpenSpec
change, markdown is most of the diff.

**If the diff is empty, stop.** Report that there was nothing to review. If a change
directory was given, write the record with `**Verdict**: PASS`, zero counts, and a
`## Not reviewed` section stating that the filtered diff was empty and no reviewer was
dispatched. Dispatch no reviewer.

PASS is what lets `/opsx:archive` proceed — a docs-only or config-only change is the
normal shape of this path, not an edge case, since the filter excludes all `.md` files.
Do not write a more descriptive verdict here (`NOT REVIEWED`, `N/A`, ...): `/opsx:archive`
recognises only `PASS` and `BLOCKED`, and anything else reads as a malformed record —
which permanently blocks the change, since re-running the review reproduces the same
empty diff and the same record.

### 2. Review

Dispatch **one** agent at the **highest available capability level**. This stage
exists to catch what the generic per-task reviews during apply do not, so the reviewer
is never downgraded to save tokens — the saving comes from sending less, above.

The agent's prompt is, in this order:

1. The full current contents of `infra/claude/review-prompt.md`, verbatim.
2. `Here is the MR diff:` followed by the diff from step 1.
3. This addition, and nothing else added:

   > In addition to the markdown review above, return the findings as structured
   > data: for each finding, its severity (CRITICAL / HIGH / MEDIUM / LOW), the file
   > path, the line number, a one-line title, the concrete failure scenario, and the
   > CWE identifier where the review format assigns one. Also return the four
   > severity counts and the Overall verdict.

Give the reviewer the diff and no repository tools. The prompt already says "Base
findings ONLY on what is visible in the diff", so this enforces the prompt rather than
narrowing it — and it is the difference between one review and an agent loop that
reads files across dozens of turns.

### 2a. Validate the response before acting on it

Check the reviewer's response before dispatching any fix subagent and before writing
anything:

1. It contains `### Executive Summary`.
2. Its `| Overall |` row carries one of `BLOCK`, `REQUEST CHANGES`, `APPROVE`. Read the row's
   value cell — the text between the second and third pipe — and normalise it exactly the way
   `extract_verdict` in `infra/claude/review-verdict.sh` does: upper-case it, discard every
   character outside `[A-Z ]`, trim the ends, then squeeze runs of spaces to one. Compare the
   result for equality against those three tokens; anything else fails. The normalisation is
   not optional — `infra/claude/review-prompt.md` mandates the cell as
   `🔴 BLOCK / 🟡 REQUEST CHANGES / 🟢 APPROVE`, so the real cell carries an emoji and a raw
   comparison rejects every valid review. Follow the script rather than a restatement of it:
   the two surfaces must decide the same verdict on the same input, which is the reason §2a
   exists at all.
3. The structured findings parse, and their severity counts are present.

**Any of the three failing stops the stage.** Report which check failed and what the
response carried instead. Write no `review.md`, dispatch no fix subagent, and do not
re-dispatch the reviewer.

This mirrors what `review.sh` already does — it exits non-zero on a missing Executive
Summary or an unreadable verdict — so the two surfaces refuse the same responses. Without
it the stage records a verdict it never actually read, and `/opsx:archive` trusts that
record.

No retry: a second dispatch hides an unstable reviewer behind a green stage, and the
developer never learns the first one failed. No partial record either — a record missing
its verdict is the malformed-record case `/opsx:archive` already refuses, reached by a
longer path and with a less obvious remedy than no record at all.

### 3. Fix round

Only CRITICAL and HIGH findings. For each one, dispatch a fix subagent at a capability
level matched to the fix — mechanical corrections take the cheapest level that can do
them, anything touching control flow or types takes a middle level. Never the
reviewer's level by default.

Each fix subagent receives **one finding and the file it names**. Not the review text,
not the other findings.

- Findings in different files: dispatch concurrently.
- Findings in the same file: serialise them.

Each subagent returns either a fix, or a claim that the finding is a false positive
with its reasoning.

Each fix subagent states, with its fix, what happens if the code it added fails. That statement is part of the fix's output, not a comment in the source. The fix is the only participant that knows what it assumed.

### 4. Dismissals are the developer's decision

A subagent's false-positive claim is a proposal, never an action. Put every claim to
the developer with its reasoning and wait for an answer. **Silence is not approval.**

On approval, add a marker on the line the finding named:

```ts
// review-ignore: CWE-XXX — <the reason, in English>
```

Both `review-prompt.md` and the CI review honour this marker, so a dismissal accepted
here is accepted on the merge request too. That is the point: the suppression travels
with the code, not with the session.

On rejection, the finding is fixed.

### 5. Re-review, capped at three rounds

Send the reviewer the fix diff, the findings those fixes were meant to close, and each fix's failure-mode statement:

```bash
git diff <SHA before the fixes>..HEAD -- <the same exclusions as step 1>
```

The re-review checks that stated failure mode rather than rediscovering it: two of three permitted rounds in the measured session went to defects in round one's own fix, which the fix itself was best placed to have named.

Re-reviewing the whole branch each round costs as much as the first review, to catch
regressions the CI review already catches against the full merge request diff. A
regression a fix introduces outside its own diff is therefore not caught here. That is
a deliberate trade, not an oversight.

Stop after three rounds. If a blocking finding survives the third, record BLOCKED,
name the outstanding findings, and hand it to the developer. A loop that has not
converged in three rounds is a design problem, and a fourth round will not fix it.

### 6. Write the record

Only when a change directory was given. Use
`openspec/schemas/sdd-plus-superpowers/templates/review.md` and write to
`<changeRoot>/review.md`.

This step is reached only when step 2a passed. A response that failed validation never gets
here — the stage stopped, and no record exists to be trusted.

Every finding gets a disposition row. A fixed finding points at the fix commit and a
dismissed finding is marked in the code, so neither needs its body restated here. A
finding that is neither — `recorded, non-blocking` or `accepted — <reason>` — has no
home anywhere else: write its body in `## Recorded findings`, or it is lost when the
reviewer's transcript is discarded.

**The `**Verdict**` line carries one token and nothing else** — `PASS` or `BLOCKED`.
`/opsx:archive` extracts that line and compares it for equality, so `PASS — nothing
blocked` reads as neither value and stops the archive. Reasoning goes in the findings
table. The same rule applies to `**Reviewed commit**`: the SHA, not a sentence about it.

Commit **only fixes** here. The record's commit is the calling command's job, as its
own commit touching `review.md` and nothing else — never bundled with a fix. `/opsx:archive`'s
staleness scan excludes only `review.md` from its `git log` range; if the record's commit
also touches source files, the exclusion misses them and the scan always finds a commit,
which blocks archive on every review that found and fixed something. Do not "simplify" this
by folding the record into the last fix commit.

## What this skill does not do

- It does not edit `infra/claude/review-prompt.md`. Changing what the review looks for
  is a separate change, and it belongs in that file so CI gets it too.
- It does not replace the per-task and whole-implementation reviews
  `superpowers:subagent-driven-development` runs during apply. Those are generic; this
  one is tuned to this stack.
- It does not review anything outside the branch diff.
