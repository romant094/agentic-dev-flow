---
name: "OPSX: Archive"
description: Archive a completed change in the experimental workflow
category: Workflow
tags: [workflow, archive, experimental]
---

Archive a completed change in the experimental workflow.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name after `/opsx:archive` (e.g., `/opsx:archive add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Pre-flight — Superpowers must be available**

   ```bash
   node .claude/scripts/check-superpowers.mjs
   node .claude/scripts/check-opsx-commands.mjs
   ```

   If either exits non-zero, STOP. Print the output verbatim and archive nothing.

   Archive is the command that must not run degraded. It moves the change directory, it
   writes the main specs and it removes the worktree — and it runs last, so a
   regeneration that happened after the last `/opsx:apply` has gone undetected until
   now. A regenerated `archive.md` has lost the worktree entry, the `openspec/specs`
   commit, the memory ingest and the worktree removal, and would report an archive
   complete that left every one of them undone. Do not restore the files yourself.

2. **Select the change — from the worktrees, before any `openspec` call**

   If a change name was given, use it.

   Otherwise build the candidate list from two sources, because neither one is complete
   on its own: read either alone and the list is short by exactly the change you are
   looking for. Stated in full in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s
   `resolve` instruction.

   Run both:

   ```bash
   git worktree list
   openspec list --json
   ```

   Every `.claude/worktrees/<TASK-ID>` entry is a change in flight, named provisionally by
   its branch. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `resolve` instruction.

   Then list what that worktree actually holds:

   ```bash
   git -C <worktree path> ls-tree --name-only HEAD openspec/changes/ \
     | sed 's|.*/||' | grep -v '^archive$'
   ```

   Each remaining line is a change name; `openspec/changes/archive/` is excluded because it
   holds past changes rather than being one, and offering it would let a past change be
   selected as a live one. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `resolve` instruction.

   If that returns exactly one name, offer it — it is authoritative and the branch name is
   not. If it returns several, offer them all for that worktree. If it returns nothing, or
   the command fails, still offer the worktree, labelled with its branch and
   `change name unresolved`; step 3 resolves it from inside.

   Offer the union of both sources with the **AskUserQuestion tool**, showing for each
   candidate its change name, its branch, and its worktree path where it has one. A change
   that appears in both sources is one candidate, not two.

   If exactly one candidate exists in total, do not take it silently: name it and ask for
   confirmation.

   If both sources come back empty, STOP: say that no change is reachable from here, say
   which branch you are on, and ask the user to name the change or the branch it lives on.

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose. Do not
   auto-select because only one candidate exists — a count taken from the wrong repository
   root means nothing.

3. **Enter the worktree**

   Every later step runs inside the change's worktree. The archive commit and the
   ingest commit both have to land on this change's branch, and that branch is
   checked out nowhere else.

   ```bash
   git worktree list
   ```

   Use the worktree path step 2 already showed beside the candidate the developer chose —
   step 2 offered each candidate with its change name, its branch and its worktree path, and
   that path is the answer. Do not re-derive it from the branch name: step 2 established that
   a branch name is a guess, and a renamed branch matches no change while its worktree still
   holds one. Then:

   ```bash
   cd <that path>
   git rev-parse --show-toplevel
   ```

   The second command must print the worktree path. If it prints the main checkout,
   STOP — from there `<changeRoot>` does not exist on the checked-out branch, `mv`
   has nothing to move, and `git commit` would write this change's archive onto
   whatever branch the main checkout holds, which may be `develop`.

   If step 2 offered this candidate with its change name unresolved, resolve it here —
   the change directory is visible now, and it was not before:

   ```bash
   openspec list --json
   ```

   Take the change this workspace holds; if it holds more than one, ask which with the
   **AskUserQuestion tool**. Announce `Using change: <name>` before the first
   `openspec status --change` call. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `resolve` instruction.

   If `git worktree list` shows no worktree for this change, it was authored in place
   on the current branch (the stay-on-the-current-branch case). Check which branch that
   is before you move anything:

   ```bash
   git branch --show-current
   ```

   If it is `develop`, STOP. Do not archive here: this command commits the archive move
   and the memory ingest on the branch you are standing on — from `develop` that is two
   direct commits to `develop`, bypassing the merge request every change is integrated
   through. Stated in full in `.claude/CLAUDE.md` §5. Say so plainly and ask the developer
   to check out the change's branch, or to name the worktree it lives in.

   Otherwise say which branch you are on, by name, so the choice is on the record, and
   continue here; step 12 then has nothing to remove.

4. **Check artifact completion status**

   Run `openspec status --change "<name>" --json` to check artifact completion.

   Parse the JSON to understand:
   - `schemaName`: The workflow being used
   - `planningHome`, `changeRoot`, `artifactPaths`, and `actionContext`: path and scope context
   - `artifacts`: List of artifacts with their status (`done` or other)

   **If any artifacts are not `done`:**
   - Display warning listing incomplete artifacts
   - Prompt user for confirmation to continue
   - Proceed if user confirms

5. **Check task completion status**

   Read the tasks file (typically `tasks.md`) to check for incomplete tasks.

   Count tasks marked with `- [ ]` (incomplete) vs `- [x]` (complete).

   **If incomplete tasks found:**
   - Display warning showing count of incomplete tasks
   - Prompt user for confirmation to continue
   - Proceed if user confirms

   **If no tasks file exists:** Proceed without task-related warning.

6. **Check the code review record**

   Read `<changeRoot>/review.md`.

   **If it does not exist:** STOP. Name `/opsx:review` as the remedy and archive
   nothing. A change in flight when the review stage was introduced has no record; that
   is a reason to review it, not to skip the gate.

   **Read the verdict field before branching on it.** Extract it as an exact token —
   do not judge by eye whether the line "mentions" a verdict:

   ```bash
   verdict="$(grep -m1 -E '^\*\*Verdict[:*]' <changeRoot>/review.md \
     | sed -E 's/^[^:]*:[[:space:]]*//; s/[`*[:space:]]//g' \
     | tr '[:lower:]' '[:upper:]')"
   ```

   The record is malformed unless `verdict` is exactly `PASS` or exactly `BLOCKED`. If it
   is anything else — including empty — treat it as no record at all: STOP and require
   `/opsx:review` to be re-run.

   Exact comparison, not a search for a mentioned token, and the distinction is
   load-bearing in both directions:

   - The template's own line is `` **Verdict**: `PASS` | `BLOCKED` ``, so an unfilled
     record carries both. Extraction yields `PASS|BLOCKED`, which equals neither, and the
     unfilled record is caught. A rule that took the *first* token instead would read an
     untouched template as a pass — the worst possible failure of this gate.
   - A filled record whose line reads `` **Verdict**: PASS — nothing blocked `` yields
     `PASS—NOTHINGBLOCKED`, which also equals neither, so it stops. That is deliberate:
     asking whether a line "names both PASS and BLOCKED" makes prose decide the verdict,
     and whether `blocked` in a sentence counts then depends on who is reading. The same
     class of defect was found and fixed in `infra/claude/review-verdict.sh`, where a
     substring match let the word `blocking` outvote an `APPROVE` beside it. The verdict
     line carries the token and nothing else; commentary belongs in the findings table.

   The `[:*]` in the grep and the `[`*[:space:]]` strip make this tolerant of where the
   colon sits — `**Verdict**:` and `**Verdict:**` both read correctly — because that
   placement is invisible to whoever writes the record and has already been got wrong once
   in this workflow.

   **If `verdict` is `BLOCKED`:** STOP, unless its
   `## Developer overrides` section records a decision with reasoning for every
   outstanding finding. An override with no reasoning is not an override, and silence
   resolves nothing — the same rule verify's check 8 applies to stale-skill findings.
   If every outstanding finding is covered, this record is allowed to proceed — continue
   to the staleness check below, the same as a PASS record.

   **If `verdict` is `PASS`**, this record is allowed to proceed —
   continue to the staleness check below.

   **Staleness check — runs for any record allowed to proceed, PASS or
   overridden-BLOCKED alike.** Archive refuses a change with no record whose verdict is
   allowed to proceed and whose commit is still HEAD. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `review` instruction. A record
   that names neither case above never reaches this point, because both branches above
   already stopped. The check itself does not care which case let it through: reviewing a
   clean branch and then committing three more times before archiving must be caught
   regardless of the verdict on record.

   Extract the reviewed commit first, and check it before running anything that depends
   on it:

   ```bash
   recorded="$(grep -m1 -E '^\*\*Reviewed commit[:*]' <changeRoot>/review.md | grep -oE '[0-9a-f]{7,40}')"
   ```

   If `recorded` is empty, the record is malformed — treat it as no record at all: STOP
   and require the review to be re-run, before running any `git log`, because a range with
   an empty left side prints nothing and would misread as "review covers HEAD". Stated in
   full in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction.

   Only once `recorded` is confirmed non-empty, scan for commits since it, anchored to
   the repository root rather than the current working directory — a subagent's working
   directory resets on every bash call, the same reason step 8 anchors its own `git add`
   calls with `repo_root`:

   ```bash
   repo_root="$(git rev-parse --show-toplevel)"
   head="$(git -C "$repo_root" rev-parse HEAD)"
   git -C "$repo_root" log --oneline "$recorded..$head" -- . ':(exclude)<changeRoot>/review.md'
   ```

   If that log is empty, the review covered the code being archived and this check
   passes. If it names any commit, STOP: code landed after the review, and the record
   describes something else. Require `/opsx:review` to be re-run.

   The scan covers the whole repository and excludes only `review.md` itself — scoping it
   to `<changeRoot>` can never short-circuit, and running it with `git -C "$repo_root"`
   rather than a bare `git log` is what keeps it repository-wide in fact. Stated in full
   in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction.

   Unlike the artifact-completion and task-completion warnings in the previous two
   steps, this one is **not** dismissible by user confirmation. Those two guard against
   an incomplete change; this one guards against an unreviewed one, and the whole point
   of the stage is that it cannot be waved through. The sanctioned way past a wrong
   finding is an override recorded in `review.md`, where it stays visible.

7. **Assess delta spec sync state**

   Use `artifactPaths.specs.existingOutputPaths` from status JSON to check for delta specs. If none exist, proceed without sync prompt.

   **If delta specs exist:**
   - Compare each delta spec with its corresponding main spec at `openspec/specs/<capability>/spec.md`
   - Determine what changes would be applied (adds, modifications, removals, renames)
   - Show a combined summary before prompting

   **Prompt options:**
   - If changes needed: "Sync now (recommended)", "Archive without syncing"
   - If already synced: "Archive now", "Sync anyway", "Cancel"

   If the user chooses sync, dispatch the merge and state the capability level in the
   dispatch itself. Run it at the **highest capability level available**: the merge is an
   adjudication, not a mechanical edit — it decides requirement by requirement how this
   change's delta folds into a main spec other changes may also have edited — and its
   output is the permanent specifications, which no later step re-derives and no test
   covers. Name the level; never name a model or a vendor.

   Use Task tool (subagent_type: "general-purpose", prompt: "Run at the highest
   capability level available. Work in <the
   absolute path this command's step 3 confirmed with `git rev-parse --show-toplevel`>.
   Your bash calls do NOT inherit this session's working directory — `cd` there first in
   every call and confirm with `git rev-parse --show-toplevel` before writing anything.
   Use Skill tool to invoke openspec-sync-specs for change '<name>'. This dispatch is that
   skill's only sanctioned entry point: it refuses any invocation that does not carry the
   change name, this workspace path and the delta spec summary. Delta spec analysis:
   <include the analyzed delta spec summary>"). Proceed to archive regardless of choice.

   The path is not optional. A subagent thread's working directory resets to the
   session root on every bash call, so a sync dispatched without it resolves
   `openspec/specs/<capability>/spec.md` in the main checkout and writes this change's
   requirements onto whatever branch the main checkout holds. Step 8 would then commit
   the worktree's untouched copy and report the specs as archived.

8. **Perform the archive**

   Create an `archive` directory under `planningHome.changesDir` if it doesn't exist:
   ```bash
   mkdir -p "<planningHome.changesDir>/archive"
   ```

   Generate target name using current date: `YYYY-MM-DD-<change-name>`

   **Check if target already exists:**
   - If yes: Fail with error, suggest renaming existing archive or using different date
   - If no: Move `changeRoot` to the archive directory

   **Preserve the ledger's durable half.** The ledger is untracked scratch under
   `.superpowers/` and the worktree is about to be removed. Write
   `openspec/changes/<change-name>/ledger.md` carrying the ledger's `## Sessions` list and
   every **unresolved** `## Debt` line, and commit it with the archive move so it travels
   into `openspec/changes/archive/<date>-<change-name>/ledger.md`.

   Do not preserve the per-dispatch or deviation lines: `adf-metrics.mjs` has already
   reduced them to tables while the worktree existed, and committing them puts turn-count
   noise into the permanent record of every change.

   `ledger.md` is **not** a schema artifact. It gets no `- id:` entry in `schema.yaml`, no
   row in `.claude/CLAUDE.md` §5's table, and no `openspec instructions` support. The
   artifact count stays eight.

   **Run the metrics extractor now, before the move below**, because it reads
   `openspec/changes/<change-name>/plan.md` at its pre-archive path — once `mv` runs that
   path is gone and the extractor's compliance table comes out empty:

   ```bash
   node .claude/scripts/adf-metrics.mjs --change <change-name>
   ```

   This is a script run, not an agent dispatch. It costs no agent tokens, cannot fabricate a
   figure, and cannot inflate the context it is measuring. The numbers accumulate whether or
   not a retrospective is ever run — five iterations of this flow produced one measurement,
   and that one was unrequested.

   ```bash
   mv "<changeRoot>" "<planningHome.changesDir>/archive/YYYY-MM-DD-<name>"
   ```

   Commit the move immediately — the worktree must be clean before step 12 can
   remove it, and an uncommitted archive is a half-done archive.

   `openspec/specs/` holds what step 7's `openspec-sync-specs` just wrote. It
   is the command's own output, not the developer's work, and archive is the
   only step sanctioned to commit it. Anchor it to the repository root rather
   than the current working directory, since later steps of this command run
   from the main checkout while earlier steps may run inside the change's
   worktree:

   ```bash
   repo_root="$(git rev-parse --show-toplevel)"
   git add -A "<planningHome.changesDir>"
   if [ -d "$repo_root/openspec/specs" ]; then
     git add -A "$repo_root/openspec/specs"
   fi
   git commit -m "docs(openspec): archive <change-name>"
   ```

   `openspec/specs/` may not exist — no capability has been archived yet, or the
   developer chose "Archive without syncing" at step 7. `git add` on an absent path
   fails with "pathspec did not match any files" and would abort the commit, leaving
   the change directory moved but uncommitted. The guard above is why the archive
   still completes in a repository that has never archived anything.

   If `git status --porcelain` still reports anything outside
   `<planningHome.changesDir>` and `openspec/specs/` after this, STOP and show it.
   That is the developer's work and it is not yours to commit.

9. **Display summary**

   **State the interval.** Print one line naming how many changes have been archived since
   the last retrospective report under `.claude-reports/adf-retro/`, excluding every
   `-metrics.md` file from the count — archive writes one on every run, so counting it
   would always report zero. This is a reminder and MUST NOT invoke `adf-retro`. Stated in
   full in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction.

   Show archive completion summary including:
   - Change name
   - Schema that was used
   - Archive location
   - Spec sync status (synced / sync skipped / no delta specs)
   - Note about any warnings (incomplete artifacts/tasks)

10. **Ingest what was learned**

   Follow the Ingest Workflow in `.claude/CLAUDE.md` §4: write or update the
   relevant pages under `.claude/memory/entities/` and `.claude/memory/concepts/`,
   update `index.md` if a page was created, then prepend an `ingest` entry to
   `.claude/memory/log.md`.

   Run `date '+%Y-%m-%d %H:%M'` for the timestamp — never guess it.

   This replaces the per-change retrospective. If nothing was learned that the
   code and git history do not already carry, say so and write nothing — an
   empty ingest is worse than none.

   The ingest additionally answers two fixed questions: (a) the invariant this change
   introduced that is not visible in any single file, and (b) what a future implementer
   would most plausibly get wrong. "Write or update the relevant pages" recovers neither,
   and these two answers are the whole content of comprehension debt — in the measured
   change, 61 subagents produced 9 287 insertions and no participant saw the whole, while
   review.md carries a disposition per finding rather than a narrative of the branch.

   Carry every entry of `review.md`'s `## Recorded findings` section and every unresolved
   `## Debt` line into the store that `schema.yaml`'s `archive` block names for it, or into a
   follow-up change, before archiving — a change closed with either of them living only in a
   commit message loses it, and that block states in full which store takes which item, the
   anchor rule and the accepted case.

   Commit what the ingest wrote:

   ```bash
   git add -A .claude/memory
   git commit -m "docs(memory): ingest what <change-name> taught"
   ```

   `.claude/memory/` is tracked, not ignored, so an uncommitted ingest leaves modified
   tracked files behind — and step 12's `git worktree remove` refuses on a dirty tree.
   Without this commit every archive ends in a half-done state that only `--force`
   could clear, and `--force` is forbidden.

   If the ingest wrote nothing, `git status --porcelain` is already clean and there is
   nothing to commit. Say so and move on; do not create an empty commit.

11. **Take the merge request out of draft and describe it**

   This runs here, and not later, for one reason: it must run **inside the change's
   worktree, on the change branch**. Step 12 leaves for the main checkout and removes the
   worktree, and from there `git rev-parse --abbrev-ref HEAD` answers with the main
   checkout's branch — normally `develop`. `mr.mjs` refuses a protected branch outright,
   so the mistake fails loudly rather than pushing to `develop`; keeping this step ahead of
   the cleanup is what keeps it from happening at all.

   It also runs before step 12's three exits — authored in place, worktree already removed,
   worktree dirty. Steps 8 and 10 have committed everything this command generates, so the
   merge request describes the finished work whether or not the worktree can be cleaned up
   afterwards.

   Assemble the description using the three sections of
   `.gitlab/merge_request_templates/opsx.md`. `## What` comes from `tasks.md`, `## Why`
   from `proposal.md`, and `## QA` from the `#### Scenario` blocks in this change's
   `specs/**/*.md` together with what `verify.md` records as actually run. All four now
   live under the archive path step 8 moved them to, not under `<changeRoot>`. Write
   English, and keep each section short — three to six bullets, two to three sentences, and
   numbered steps a tester can follow without reading the code.

   Write the body outside the repository. Anything written inside it is an untracked file,
   and step 12's `git worktree remove` refuses on one:

   ```bash
   mr_body="$(mktemp -t opsx-mr-body.XXXXXX)"
   # write the three sections into "$mr_body"
   mr_output="$(node .claude/scripts/mr.mjs finalize --change "<name>" --body-file "$mr_body")"
   echo "$mr_output"
   if [[ "$mr_output" == *"no merge request was touched"* ]]; then
     echo "Body kept at $mr_body — the printed command above still needs it."
   else
     rm -f "$mr_body"
   fi
   ```

   `mktemp -t` needs a template ending in at least three `X`s: GNU coreutils rejects a bare
   prefix, even though BSD/macOS accepts one.

   The script leaves draft and sets the description **before** it pushes, and that order is
   not incidental: changing a merge request title starts no pipeline, so a push that lands
   while the title still reads `Draft:` runs `ai_claude_inspect`'s rule against a draft and
   skips the AI review for that commit permanently. Do not reorder it.

   The script exits 0 both when the merge request was updated and when `glab` is missing or
   unauthenticated, so the exit code alone cannot tell success from the degraded path — that
   is why the shell checks the printed message instead of the exit code. On the degraded
   path it prints the branch and a command to run later that references `$mr_body` by path;
   report that in the summary instead of claiming the merge request is ready, and do not
   delete the file the printed command depends on.

   The merge request is not merged and no reviewer is assigned: integration is the
   developer's action. Close by naming the merge request and saying it is ready to merge.

12. **Clean up the worktree**

   This runs last, and it runs from the main checkout — a worktree cannot remove the
   ground it stands on. Find both roots first:

   ```bash
   git rev-parse --show-toplevel                                    # this worktree
   git rev-parse --path-format=absolute --git-common-dir            # main checkout's .git
   ```

   If the two point at the same repository root, the change was authored in place with
   no worktree (the stay-on-the-current-branch case) — skip this step.

   Confirm `ledger.md` was written in step 8 before removing the worktree — the ledger is
   deleted with it.

   Otherwise `cd` to the main checkout and remove the worktree by the path
   `git worktree list` reports for it — a path rebuilt from a task ID you were never
   given can name a worktree that is not this change's. Stated in full in
   `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction.

   Run:

   ```bash
   cd "$(git rev-parse --path-format=absolute --git-common-dir)/.."
   git worktree list
   git worktree remove <the .claude/worktrees/... path from that listing>
   ```

   If the listing no longer shows it, it was already removed. Say so and stop; there is
   nothing left to do.

   Symlinks are removed as symlinks; their targets in the main checkout are untouched.

   If the worktree is still dirty, `git worktree remove` refuses. That is correct —
   report the refusal, show `git status --porcelain`, and stop. Never pass `--force` and
   never delete the directory by hand, or uncommitted work is destroyed. Stated in full
   in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction. Steps 8
   and 10 committed everything this command generates, so anything left is the developer's
   to resolve. Every commit is on
   the branch and the branch is untouched by this step, so stopping here loses nothing.
   Step 11 has already undrafted and described the merge request and pushed the final
   commit, so a refusal here leaves the merge request ready all the same.

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced to main specs

All artifacts complete. All tasks complete.
```

**Output On Success (No Delta Specs)**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** No delta specs

All artifacts complete. All tasks complete.
```

**Output On Success With Warnings**

```
## Archive Complete (with warnings)

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/
**Specs:** Sync skipped (user chose to skip)

**Warnings:**
- Archived with 2 incomplete artifacts
- Archived with 3 incomplete tasks
- Delta spec sync was skipped (user chose to skip)

Review the archive if this was not intentional.
```

**Output On Error (Archive Exists)**

```
## Archive Failed

**Change:** <change-name>
**Target:** the archive path derived from `planningHome.changesDir`/YYYY-MM-DD-<name>/

Target archive directory already exists.

**Options:**
1. Rename the existing archive
2. Delete the existing archive if it's a duplicate
3. Wait until a different date to archive
```

**Guardrails**
- Always prompt for change selection if not provided
- Use artifact graph (openspec status --json) for completion checking
- Don't block archive on warnings - just inform and confirm
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If sync is requested, use the Skill tool to invoke `openspec-sync-specs` (agent-driven)
- If delta specs exist, always run the sync assessment and show the combined summary before
  prompting — a prompt offered without it asks the developer to choose blind. Stated in
  full in `openspec/schemas/sdd-plus-superpowers/schema.yaml`'s `archive` instruction.
