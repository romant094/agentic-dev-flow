---
description: Review a change - run the project's tuned code review, fix what blocks, and commit the record. Triggers may be phrased in any language.
argument-hint: <change-name>
effort: medium
---

Review a change: run the project's tuned code review over the verified branch, fix its blocking
findings in bounded rounds, and write `review.md`, the record archive reads. Review runs after
verify and before archive.

The rules this command follows are stated in full in the review instruction,
`${CLAUDE_PLUGIN_ROOT}/schema/instructions/review.md`: read it before step 2. Change selection
is stated in full in `${CLAUDE_PLUGIN_ROOT}/schema/instructions/resolve.md`.

Each step below is one script call, or a dispatch whose prompt one script call writes; what is
yours is the judgement on its result and the talk with the developer. A question that needs more
than one file opened goes to a read-only agent that returns a verdict, named `investigate
<topic>` with a one-word topic. Read one named file directly. The diff, the reviewer's input
and the replies stay in their files: read the scripts' verdicts, counts and refusals.

**Input:** `$ARGUMENTS` is the change name, optional. Without it, infer the change from the
conversation; if that is vague or ambiguous, the selection in step 1 asks.

1. **Select the change and run the preflight.** Follow the resolve instruction: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/changes.mjs" find`, have the developer confirm the
   change, and say `Using change: <name> in <root>`. Then run `preflight.mjs --phase review`,
   as the instruction states. On `ok: false`, stop: show `refusal`, which names the remedy, and
   write nothing. From here on, pass `--change <name> --root <root>` to every core script and
   run git with `git -C <root>`.

2. **Check that a new tool ran on a real input,** as the instruction states, before any
   reviewer is dispatched.

3. **Start the run.** `review.mjs start`. An empty filtered diff goes to step 8 with
   `--not-reviewed`. A diff over the size one reviewer takes: show the slices and their proof
   to the developer and record their approval as the `review-slices` ruling.

4. **Review the round.** `review.mjs round`, then `review.mjs input`, then dispatch
   `ai-review r<k>` from `dispatch.mjs prompt --role ai-review`, then store the reply with
   `review.mjs response`. Retry an invalid reply once, as the instruction states; a stopped
   stage ends here, reported to the developer.

5. **Fix the blocking findings.** `review.mjs fixplan`, then dispatch each wave's `ai-fix
   F<n> r<k>` in one response from `dispatch.mjs prompt --role ai-fix`, and store each reply
   with `review.mjs fix`.

6. **Settle the rest with the developer.** Put each false-positive claim to the developer with
   your assessment; record their ruling, mark a dismissed line with `review.mjs mark --commit`,
   and apply it with `review.mjs disposition`. Record each non-blocking finding left as it is
   with its body. Then step 4 again, until `round` says nothing is left to re-review or the
   cap needs the developer.

7. **Run the suite** with `suite.mjs run --section review` when any fix landed.

8. **Assemble and commit the record.** `review.mjs assemble --commit`. On `refusals`, run the
   calls they name and assemble again. Push nothing.

9. **Report.** Show the `report` that `assemble` returned. End with what is blocked on the
   developer, if anything; on `PASS` the next step is `/adf:archive`, on `BLOCKED` the outstanding
   findings the report names and then `/adf:review` again.
