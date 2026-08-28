---
name: "OPSX: Review"
description: Run the tuned AI code review over a change's implementation and fix what it finds
category: Workflow
tags: [workflow, review, experimental]
---

Run the AI code review over a completed, verified change, fix its blocking findings, and
record the verdict `/opsx:archive` requires.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name after `/opsx:review`. If omitted, infer it from conversation context; if ambiguous, prompt with the available changes.

**Steps**

1. **Pre-flight — Superpowers must be available**

   ```bash
   node .claude/scripts/check-superpowers.mjs
   node .claude/scripts/check-opsx-commands.mjs
   ```

   If either exits non-zero, STOP. Print the output verbatim, review nothing and write
   nothing. A regenerated command surface has lost the gate and the worktree model, and
   a review recorded from a degraded surface would unblock archive on no evidence.

2. **Enter the change's workspace**

   ```bash
   git rev-parse --show-toplevel
   git rev-parse --path-format=absolute --git-common-dir
   ```

   Two different roots mean you are in the change's worktree, which is where the review
   belongs. Equal roots mean the change was authored in place, which is also allowed.
   Say which case you are in.

   Then check the branch:

   ```bash
   git branch --show-current
   ```

   If it is `develop`, STOP. This command commits `review.md` and any fixes, and from
   `develop` that is a direct commit to the integration branch, bypassing the merge
   request every change is integrated through. Stated in full in `.claude/CLAUDE.md` §5.

3. **Confirm the change was verified**

   ```bash
   openspec status --change "<name>" --json
   ```

   The `verify` artifact must be `done`. If it is not, STOP and name `/opsx:verify` as
   the step to run first. Reviewing an unverified change wastes a review on an
   implementation that may still change.

4. **Get the review instruction and the template**

   ```bash
   openspec instructions review --change "<name>" --json
   ```

   Note `changeRoot` and `resolvedOutputPath`. The template is
   `openspec/schemas/sdd-plus-superpowers/templates/review.md`.

5. **Record the commit under review**

   ```bash
   git rev-parse HEAD
   ```

   This SHA goes into the record's `Reviewed commit` field. `/opsx:archive` compares it
   against HEAD, so it must be captured from the commit that was actually reviewed. If
   fixes land during the review, re-capture it after the last fix commit — the record
   must name the commit the final round approved, not the one the first round saw.

6. **Run the review**

   Use the Skill tool to invoke **ai-code-review**, passing `changeRoot` from step 4 as
   the change directory so it writes the record — not `resolvedOutputPath`, which names
   the record file itself, not the directory the skill needs.

   The skill owns the procedure: the diff filter, the reviewer dispatch at the highest
   available capability level, the scoped fix subagents, the developer decision on every
   claimed false positive, the fix-diff-only re-review, and the three-round cap. Do not
   restate it here and do not perform it by hand.

7. **Write and commit the record**

   The skill writes `<changeRoot>/review.md` from the template. Check that
   `Reviewed commit` names the current HEAD before committing — if fixes landed after
   the SHA was captured, correct it.

   The skill commits its fixes as it applies them, each its own commit touching only the
   file the finding named. This step's commit is separate and comes after: it stages and
   commits `review.md` alone, containing nothing but the record.

   ```bash
   node .claude/scripts/check-english.mjs <changeRoot>/review.md
   git add <changeRoot>/review.md
   git commit -m "docs(openspec): record ai code review for <name>"
   ```

   `git status --porcelain` should show nothing but `review.md` staged before this commit
   runs. If a fix is still uncommitted at this point, that is a bug in the skill — stop and
   commit the fix separately first, never mixed into this one, because a record commit that
   also touches source files blocks every future archive of this change. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `review` instruction.

8. **Report**

   State the verdict, the counts, how many rounds ran, and what each blocking finding's
   disposition was.

   - **PASS** → name `/opsx:archive` as the next step.
   - **BLOCKED** → name the outstanding findings and stop. Do not suggest archiving. The
     developer either fixes them or records an override in `review.md` with reasoning.

**Output**

The transcript summarises; `<changeRoot>/review.md` is the record, and it is the one
`/opsx:archive` reads.
