# OpenSpec + Superpowers Change Workflow

The mechanics of the cycle — the five commands, the eight artifacts, the branch model —
live in [`.claude/CLAUDE.md`](../CLAUDE.md) §5 and, normatively, in
`openspec/specs/change-workflow-schema/`, `change-branch-isolation/` and
`superpowers-availability-gate/`. Those are the source of truth and this page does not
restate them.

This page carries what neither the specs nor git history explain: why the surface is shaped
the way it is, and which of its parts fail silently.

## Where each thing is written

| Thing | Written by | Never written by |
|---|---|---|
| `openspec/specs/**` (permanent capabilities) | `/opsx:archive`, step 6 → step 7 | anything else, ever — not by hand, not backfilled |
| `openspec/changes/<name>/**` | the five commands, in artifact order | — |
| `.claude/commands/opsx/*.md` | humans and changes to this workflow | `openspec update` (see below) |

## `openspec update` destroys this repository's adaptations

The CLI's `update` regenerates `.claude/commands/opsx/` and `.claude/skills/openspec-*/`
from its own templates. Measured: 140 lines lost — the availability gate, the branch model,
the worktree lifecycle, the apply-time provisioning decision — and the removed
`/opsx:explore` restored. It is prohibited, and `node .claude/scripts/check-opsx-commands.mjs`
is the detector: 20 markers across 5 files, each marker chosen because it is present in the
adapted file and provably absent from the stock template. Every command runs it at step 0,
because a regeneration that happened after the last apply would otherwise surface only when
archive silently skipped the spec merge.

A marker is only worth adding if `grep -cF '<marker>' "$(npm root -g)/@fission-ai/openspec/dist/core/templates/workflows/<template>.js"` prints `0`.

## Verification's test check tests the change, not the repository

`/opsx:verify` check 6 runs only the workspace packages the change touched, derived from the
`**Files:**` blocks in its own `plan.md`, and forces a real run.

Both halves were paid for. The first version ran the whole suite, and the suite is red from
defects older than most branches — so every change verified FAIL and the verdict was
overridden by hand, twice in one session before anyone questioned the check. A gate that is
routinely stepped over is worse than no gate: it teaches everyone to scroll past the verdict,
including on the day the failure is real.

**Measured green on 2026-08-18**, which is what made the whole-suite run at apply
defensible: `npx turbo run test --force` reported `3 successful, 3 total`, `Cached: 0
cached`, 533 client tests across 51 files, in 40 seconds. The scoping argument's other half
still stands and is kept as an exception — a failure that reproduces on `origin/develop` is
recorded as pre-existing and does not block the change, because a gate that fails on work it
does not own is one that gets overridden by habit.

The scope is deliberately **not** derived from a git ref. `turbo --filter='...[origin/develop]'`
looks like the right mechanism and is wrong here, because a branch may carry work unrelated
to the change — the branch that introduced this workflow also carried a devices-routing module
move, so a git-ref filter selected the server package for a change living entirely in
`.claude/`. `/opsx:apply` already decides worktree provisioning from the same `**Files:**`
blocks, for the same reason.

**`npm test` here is `turbo run test`, and turbo answers from its cache.** The first real run
of check 6 was served `Cached: 1 cached` and reported the client package green; `--force`
revealed 11 failing tests of 478. A cached result is a replay of an earlier run against
earlier code. `--force` is mandatory and the `0 cached` line is required evidence in the
record.

Both now exist, and one of them was already there and unrecorded: `.lefthook.json` — not
`lefthook.yml`, which is why a glob for it finds nothing — carried a `pre-push` hook running
`npx turbo run test --force`, and CI has run `unit_tests` on merge requests since
`ci-unit-testing`. `mr-lifecycle-in-flow` removed the hook, because a cycle that pushes
several times per change turns it into several full uncached runs and it cannot tell a flow
push from a hand push. The whole-suite run moved to the end of `/opsx:apply` instead, where
it is one run per change with every group merged and still individually attributable.

## The cycle pushes, and it opens the merge request

It did not, and the reason recorded here was that agents in this environment held no push
permission. That expired on 2026-08-18: `glab` was installed and authenticated against
the project's GitLab instance, and the remote is SSH. `mr-lifecycle-in-flow` moved the last mile into
the flow — propose pushes and opens a Draft, apply pushes after each task group, archive
undrafts, describes and then pushes.

**The order at archive is undraft-then-push, and reversing it silently disables the AI
review.** Changing a merge request title starts no pipeline; only a push does. A push that
lands while the title still reads `Draft:` is evaluated by `ai_claude_inspect`'s rule as a
draft and skipped, permanently, short of a manual re-run. Draft blocks that one job only —
`unit_tests`, `buildonly_ansible` and `jira_link_mr` were indifferent to it until this change
added the shared `.mr_rules_no_draft` anchor to the first two.

**A missing `glab` degrades, it does not gate.** Unlike `superpowers-availability-gate`,
which stops the command: Superpowers is what the command is made of, a merge request is an
outcome a developer can produce by hand. The script prints the install command for the host
OS, or the `glab auth login` line, and exits 0.

## A guard is defeated by the one input it cannot observe

`mr-lifecycle-in-flow` produced this twice, from opposite directions, and the second time
the guard being defeated was the fix for the first.

The whole-branch review found that archive's merge-request step had been inserted inside the
worktree-cleanup step, which `cd`s to the main checkout and removes the worktree before it
runs — so `git rev-parse --abbrev-ref HEAD` would answer with the main checkout's branch,
normally `develop`, and the script would have run `git push --set-upstream origin develop`.
The fix was positional plus a `PROTECTED_BRANCHES` refusal inside the script.

The AI review then found that the refusal read its input from `currentBranch`, which never
checked the command's `ok` flag. The injected runner returns `{ ok: false, stdout: '' }` on
failure, so a failed `git rev-parse` resolved the branch to the empty string,
`protectedBranchRefusal('')` returned `null`, and the guard passed on the one value it was
built to stop. Detached HEAD took the same route through `'HEAD'`.

**The rule: a guard that reads its subject from a fallible call must check that call
succeeded, or it is validating a default.** Every early return and every fallback value in a
guard is a silent pass wearing the costume of a check — the same lesson this page already
records for `check-workflow-shape.mjs`'s missing anchors, arriving here through a completely
different mechanism. Look for it wherever a value crosses from "obtained" to "checked".

## Replacing inert prose with executing prose inherits a position that was never load-bearing

The archive step above was not badly written; it was dropped in as a literal replacement for
the paragraph that used to sit there — *"The branch is not pushed and no merge request is
opened…"*. That paragraph only stated something, so its position at the tail of the cleanup
step meant nothing. The replacement runs `git` and `glab`, and the position it inherited put
it after the `cd` and after the worktree removal.

No task-scoped review could see it: the task's diff showed a correct block inserted at a
plausible-looking place, and the forty lines above it were unchanged context nobody had a
reason to re-read. **When a change turns a descriptive passage into an executable one, the
position is a new decision, not an inherited one** — re-read what runs before it, not just
what it says.

## The review stage's diff range is `origin/develop`, and narrowing it breaks the guarantee

Tempting, when a branch carries previously archived changes, to scope `/opsx:review`'s diff
to the change's own first commit — this branch carried two, and the full filtered diff was
1798 lines against roughly 200 for the change alone. Do not. The stage exists so that a
branch passing locally passes in CI, and CI reviews the whole merge request diff; a narrowed
local run can approve what CI will reject.

The cost is real and should be expected rather than treated as a bug: this run's LOW findings
included one against `infra/claude/review.sh`, which belongs to `ai-review-flow-guards`,
archived the day before. Record it against its own change and move on.

Note also the asymmetry, which came up when considering whether the local review should
review `.md` while CI does not: the guarantee is one-directional. Local stricter than CI
keeps "passes here → passes there" intact. Local *looser* is what breaks it.

## Guards that look alike and are not

Four commands call `git status --porcelain`, and only one of them is narrowed:

- `propose.md`, before branch creation — `--untracked-files=no`. It guards `git worktree add`,
  which reads a commit and writes a new directory without touching the main checkout's
  working tree. An untracked file cannot be lost by it, and blocking on one protects nothing.
- `propose.md`, before its own commit; `verify.md` check 5; `archive.md` before
  `git worktree remove` — all full porcelain, correctly. `git worktree remove` **does** refuse
  on untracked files inside the worktree, which is the opposite case.

## The spec validator's undocumented rule

An ADDED requirement must carry `SHALL` or `MUST` **on the first line of its body**. The
validator does not scan the rest of the paragraph. Scenarios take exactly four hashtags.

## Adding a verify check means touching three files, not one

`parallel-group-execution` (archived 2026-08-06) added check 7 ("no leftover group
worktree") to `schema.yaml`'s `verify:` instruction — and that alone was not enough.
`.claude/commands/opsx/verify.md` is a separate, hand-authored file that actually
executes the checks; it still said "six checks" and had no step for the new one, and
`openspec/schemas/sdd-plus-superpowers/templates/verify.md` had no section to record
its result in. `schema.yaml`'s prose is the spec of what verify must do — it is not
the thing that runs. This is exactly the class of drift verify's own check 4 (design/
specs coherence) is supposed to catch, and did catch it, at the final whole-branch
review stage rather than at any single task's review, because no individual task's
diff touched both `schema.yaml` and `verify.md` — the gap only became visible with
the whole branch in view. Adding or changing a numbered check requires editing
`schema.yaml` (the instruction text), `.claude/commands/opsx/verify.md` (the step that
runs it), and `templates/verify.md` (the section that records it) — three files, one
check.

**The rule applies to the producer side too, not just the consumer.**
`flow-shift-left-and-retro` (archived 2026-08-07) moved the package-test run from
`/opsx:verify` into `/opsx:apply`, with `/opsx:verify` check 6 citing an
`.apply-test-record.md` when nothing changed since. The plan's own task list named
only the consumer surfaces to update (`apply.md`, `verify.md`, `schema.yaml`'s `verify:`
block, `templates/verify.md`) — and missed that `schema.yaml`'s `apply:` block also
needed to document the new producer behavior, since it is the schema-level description
of what apply does, read independently of `apply.md`'s full prose. No task-scoped
review caught it, for the same reason as the check-7 case above: the task list was
written before the omission existed, so no task's diff could show it. Only the final
whole-branch review caught it. Lesson generalizes: when a behavior moves between two
commands, every command's *own* schema instruction needs the move reflected, not only
the command `.md` files — "three files" becomes "the schema entry for both the old and
the new home, plus every `.md` that executes either."

That same final review also caught two other cross-file issues no task-scoped review
could see: the record's staleness check was scoped to `git log ... -- <changeRoot>`,
which can never find the record's own commit outside itself (the record always commits
*inside* the change directory, so the pathspec always finds at least one commit and the
short-circuit could never fire) — fixed to scan the whole repository, excluding only
the record file and `verify.md`. And `apply.md`'s test-run block was worded as if it
ran *before* `subagent-driven-development`'s internal final review, when by the time it
executes that review has already returned — fixed to say so plainly. All three were
prose-only, one-fix-dispatch, single-re-review fixes; none needed a second implementation
pass.

**A check's own "the other N checks" count is a fourth kind of drift, separate from the
three-files rule.** `dynamic-forms-agent-tooling` (archived 2026-08-13) added check 8
("stale-skill check") correctly across all three files per the rule above — but its
final whole-branch review still found `schema.yaml` and `verify.md` both saying "the
other **six** checks report" inside check 7's own paragraph (that sentence only counts
the *other* checks from check 7's point of view — it was correct at "six" when check 7
was the last one added, and silently wrong the moment an eighth check landed next to
it). This is not the same bug as the three-files rule — all three files *were* edited
consistently for check 8 itself — it's a stale literal living inside a *different*,
unrelated check's own prose, which nothing about editing check 8 would touch or even
suggest looking at. `flow-shift-left-and-retro`'s three-files lesson above is about
where a check's *definition* must be updated; this is about a self-referential count
elsewhere in the same files that has no single owner and will drift again the next time
a ninth check is added.

**A systematic fix now exists, and it is narrower than this paragraph used to ask for.**
`ai-review-flow-guards` (archived 2026-08-18) added check 9, `check-workflow-shape.mjs`,
which derives the shape and compares it against the sites that *declare* it. It does
**not** find self-referential counts like "the other N checks" — that sentence lives
inside another check's paragraph and is not a declaration site. Check 9 caught none of
the five stale literals that change had to fix; every one was corrected by hand. So the
grep advice this paragraph used to give still applies, with one correction that cost four
separate failures to learn: **grep for it line-blind.** See the wrap section below.

## Parallel wave-1 groups writing one shared file need a collision-avoidance layer

`parallel-group-execution`'s coupling score is computed from file overlap: any file two
groups both write scores `strong` and the groups cannot share a wave. If every group in
a plan legitimately needs to add entries to the same shared file (e.g. `en.json`,
`config.ts`), writing to it directly forces the scheduler to serialize what should run
concurrently — defeating the point of splitting into groups at all.

`i18n-hardcoded-strings` (archived 2026-08-06) hit exactly this with 4 groups all
needing to add keys to one shared translations file. Fix: each group writes
its new entries to its own temporary fragment file
(one `_fragments/en.<group>.json` per group — none of which any other
group's tasks list, so coupling is `none`), and one wave-2 integration task (depending
on every wave-1 group) merges the fragments into the real shared file and deletes the
fragment directory. This is a reusable pattern for any future plan where independent
groups converge on one shared config/data file: fragment per group in wave 1, single
deterministic merge in wave 2.

## A collision script that only compares key *names* misses a duplicate *message* under two names

The fragment-merge pattern above needs its own collision check, and a same-key-name
check is not enough. `i18n-hardcoded-strings`'s Task 5 script correctly detected exact
key-path collisions across the four fragments — and found none — but two groups
(`pages`, working on `ProjectPage.tsx`, and `templates`, working on
`DeviceConfigLayout.tsx`) independently migrated the identical literal "Diff Checker
Mode" to two *different* keys (`projectPage.diffCheckerMode` vs
`deviceConfigLayout.diffCheckerMode`). No task-scoped review caught it — each group's
diff only showed one side of the duplicate. The plan's own text had actually
anticipated this exact case by name and told the implementer to leave both keys as-is,
which directly contradicted the change's own spec requirement that duplicated messages
share one key. Only the final whole-branch review, which sees every group's diff at
once, caught it; `/opsx:verify`'s design/specs coherence check caught that the plan
text itself (not just the code) still contradicted the spec, after the code had
already been fixed. Lesson for writing a fragment-merge integration task: a collision
check that diffs key *paths* across fragments is necessary but not sufficient — also
diff the *values* for near-duplicates under different keys before merging.

## `subagent-driven-development`'s per-plan workspace can collide across changes

`.superpowers/sdd/<plan-basename>/` is keyed only on the plan file's basename
(`sdd-workspace` does `basename "$plan" .md`), and every `sdd-plus-superpowers` change's
plan is literally `plan.md` — so two different changes' scratch workspaces both resolve
to `.superpowers/sdd/plan/`. `integrate-superpowers-workflow` (archived 2026-08-04) left
its ledger and review packages there uncleaned; `parallel-group-execution`'s apply run
found that stale, 60KB+ directory sitting in the way before dispatching Task 1 — its
ledger's first line correctly named a different plan file, per the skill's own
stale-ledger rule, but the *directory path itself* collides, which the skill's
same-basename-different-content check does not anticipate. Moved aside rather than
deleted (safety hook blocks `rm -rf` in this project regardless). Not yet fixed at the
skill level — if it recurs, the fix belongs in `sdd-workspace` (key on a hash of the
full plan path, not the basename), not in each change's apply run.

**Recurred a second time**, unprompted, in `flow-shift-left-and-retro` (archived
2026-08-07): its apply run found `parallel-group-execution`'s own already-completed
ledger and briefs sitting in the same `.superpowers/sdd/plan/` directory. Since that
prior plan's own final review was already recorded as `complete` in its ledger, its
leftover files were removed outright (not moved aside) and a fresh ledger started,
rather than treating them as protected — the earlier project's "leave it in place"
guidance is for artifacts that might still be someone's in-progress work, not for a
directory a finished plan failed to clean up per its own Finish step. Two occurrences
in three archived changes is a pattern, not a fluke — the fix belongs in
`sdd-workspace` per the note above; a hash of the full plan path (not the basename)
would remove the collision at its source instead of relying on every controller to
notice and reconcile it by hand.

**Recurred a third time** in `ai-code-review-gate` (2026-08-14): its apply run found
`dynamic-forms-agent-tooling`'s ledger, briefs and review packages in the same
directory. Moved aside to `.superpowers/sdd/plan--stale-<name>/` rather than deleted,
because the developer was still working with that change's history at the time.

### The rule: name the workspace yourself, before the first dispatch

The two earlier entries above both concluded the fix belongs in `sdd-workspace`. That
conclusion was incomplete, and acting on it costs more than it needs to: `sdd-workspace`
lives in the plugin cache
(`~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/subagent-driven-development/scripts/`),
which is not tracked by this repository, is shared with every other project on the
machine, and is replaced wholesale by a plugin upgrade — the directory is version-pinned,
so an upgrade silently reverts any edit. It is the wrong place for this project to hold a
rule.

It is also unnecessary. **Both helper scripts take an explicit output path as an optional
last argument**, and consult `sdd-workspace` only when it is omitted:

- `task-brief PLAN_FILE TASK_NUMBER [OUTFILE]`
- `review-package PLAN_FILE BASE HEAD [OUTFILE]`

So the collision is avoidable entirely from inside a run, with no plugin edit. At the
start of `subagent-driven-development`, before dispatching Task 1, create the workspace
explicitly and name it after the change:

```bash
ws="$(git rev-parse --show-toplevel)/.superpowers/sdd/<change-name>"
mkdir -p "$ws"
```

Then put the ledger at `$ws/progress.md` and pass `$ws/...` as the explicit OUTFILE on
every `task-brief` and `review-package` call. Nothing resolves through the basename slug,
so two changes can never share a directory — and because the name is the change name, a
directory found later is immediately attributable.

`sdd-workspace` itself is then never invoked, and the stale-ledger reconciliation the
three incidents above each performed by hand does not arise. It is still worth a glance
at `.superpowers/sdd/plan/` when starting: a directory there is the residue of a run that
predates this rule, and it belongs to whichever change its `progress.md` first line names.
Move it aside rather than deleting it unless that change is archived and its ledger
records its own final review as complete.

A guard script under `.claude/scripts/` that enforces this the way
`check-opsx-commands.mjs` enforces the command surface is worth having, and is its own
change — not something to fold into whatever change happens to notice the problem.

## The review stage (added by `ai-code-review-gate`, archived 2026-08-17)

The cycle is five commands and eight artifacts: `/opsx:review` and `review.md` sit between
verify and archive. Mechanics live in `openspec/specs/ai-review-flow-stage/` and
`.claude/CLAUDE.md` §5; this section carries what those cannot.

**The staleness anchor is the stage's whole value, and it will re-run the review.** The record
names the commit it reviewed, and archive refuses if anything landed since. During this change
it fired four times and each re-run found a real defect — twice a regression introduced by the
previous fix. The cost is real (a fix means another review round); the alternative is a record
that describes code nobody looked at.

**A record commit must touch `review.md` and nothing else.** Archive's scan excludes exactly
that one path, so a record bundled into a fix commit makes the scan non-empty and archive
refuses a branch that was just reviewed — deadlocking precisely when the review found
something. `SKILL.md` said "commit the record together with the fixes" while the command said
the opposite; both came from `plan.md`, and each task's reviewer saw only its half. Only the
whole-branch review could see it.

**The verdict field is compared for equality, never searched.** Asking whether a line "names
PASS or BLOCKED" makes prose decide it, and whether `blocked` in a sentence counts depends on
who is reading. Equality also catches the unfilled template, whose line carries both tokens —
a rule taking the *first* token would read an untouched template as a pass. Same defect class
as the CI parser (see [Infra](infra.md)), found on both surfaces, fixed properly on one of them
an hour before the other.

**The stage cannot review markdown.** The filter drops all `.md` because the prompt orders the
reviewer to skip it, so a change made of agent-facing prose — skills, commands, schema
instructions — gets no review from this stage at all. That is most of what this workflow
produces. During apply, prose is covered by `subagent-driven-development`'s whole-branch
review, which is what caught the record-commit contradiction above. Nothing covers it at the
review stage. Unresolved.

**Ask the reviewer to disbelieve the previous verdict.** Rounds 3 and 5 each contradicted an
APPROVE that the previous round had given, and each dispatch said explicitly that the newest
fix was the least-reviewed code in the diff and the prior verdict was not settled. A round told
only "this passed before" tends to agree.

## A checklist of surfaces is complete only against itself

`design.md` listed seven surfaces that must agree about the cycle's shape; `plan.md`'s risk
reconciliation cited that list as the mitigation for the risk "surfaces must agree". The
mitigation was executed faithfully and was still incomplete, because at least eleven surfaces
needed the edit. Five were found by the whole-branch review, one by verify's check 8, two more
during the archive's spec merge.

A mechanical sweep finds them all in one call and does not depend on an author remembering:

```bash
grep -rn -e "four commands" -e "seven artifacts" -e "Seven artifacts" \
  --include="*.md" --include="*.yaml" . \
  | grep -v -e "^./openspec/changes/archive/" -e "^./.superpowers/"
```

This is the fifth recurrence of the self-referential-literal class already recorded above, and
the first time a *checklist written to prevent it* was itself the thing that was incomplete.
Promoting the sweep to a verify check is the obvious fix and is its own change.

**That change happened, and the sweep it promoted is not the one written above.**
`ai-review-flow-guards` built the prose sweep first, ran it against this repository, and
measured it: **ten findings, all ten false positives.** A count beside `artifact`, `command`
or `check` almost always counts a *subset* in English — "four commands call `git status
--porcelain`", "three checks moved earlier in the pipeline", "the five artifacts most likely
to quote it" are all true sentences the rule flags. One finding was a quotation of a
historical state. Three flagged the grep command written into this very page to hunt the
drift. The enumerative variant fared no better: the artifact ids are ordinary English words —
`plan`, `tasks`, `specs`, `design`, `review` — so any sentence naming three of them trips it.
No exclusion list survives that.

The rule that replaced it: **do not decide from prose; parse the structured place.** Check 9
compares the derived shape against the handful of sites that *declare* it and scans nothing
else. What that gives up is stated in the spec rather than discovered later — it catches the
declaration sites and nothing more. A check whose findings are all noise gets switched off,
which leaves less protection than none; this page already records that happening to
verification's test check.

**Renumbering a command's steps means sweeping `.claude/skills/` too.** Inserting archive's
step 6 shifted the spec-merge step from 6 to 7, and `openspec-sync-specs` named "step 6" in
five places including its `description` — the field an agent selects the skill by. The task's
renumbering grep covered `.claude/commands/opsx/`, `schema.yaml` and `.claude/CLAUDE.md`, and
not the skills. Verify's check 8 caught it. Also grep case-insensitively: a sentence-initial
`Step 7` survives `grep -nE 'step [0-9]+'`.

## A line wrap defeats a line-based match, and the same method has the same blind spot no matter who runs it

`ai-review-flow-guards` (archived 2026-08-18) hit this **four times in one change**, and the
fourth is the one worth remembering.

1. The prose-scan implementation could not see `schema.yaml`'s "the other seven checks" —
   the number and the noun sat on either side of a markdown line break.
2. The replacement parser was written to span wraps *because* of (1), and it works: the
   `verify.md` sentence it matches really is split across lines.
3. A fix round was dispatched to sweep every stale count literal. Its sweep was line-based
   anyway. Two of five literals survived.
4. **The controller then verified that fix independently — with the same line-based grep —
   and missed the same two.** The reviewer found them.

An independent check that reuses the method it is checking is not independent. It reproduces
the blind spot exactly, and the second clean result reads as confirmation while proving
nothing. Vary the *method*, not just the agent: flatten whitespace before matching.

```bash
# finds counts split across a newline; a line-based grep cannot
perl -0777 -ne 's/\s+/ /g; while (/((?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:checks?|artifacts?|commands?|sections?))/gi) { print "$ARGV: $1\n" }' <files>
```

Python `pathlib.read_text()` plus `re.sub(r'\s+', ' ', t)` does the same. Whichever you pick,
pick a *different* one than the check you are auditing used — and expect the sweep to have
standing false positives (a command block that quotes the pattern, a marker describing a
rejected draft); confirm them once by reading, then treat them as expected rather than as
regressions.

## A drift detector that returns nothing when its anchor is missing switches itself off

Every declaration site in the first `check-workflow-shape.mjs` was guarded by "if I cannot
find my anchor, report nothing." The final review probed it: renaming CLAUDE.md's section-8
heading, changing the `Cycle:` label, or rewording the `N artifacts, in this order` phrase each
produced a **clean exit 0** — and the third case meant a stale count went unreported.

The reachability argument that makes this look acceptable is exactly backwards. The person most
likely to reword one of those anchors is the person changing the workflow's shape, which is the
one moment the check exists for. Fixed by making a missing anchor a finding in its own right
(`site: '<name>-missing'`).

Generalizes to any check of this kind: **read every early return, and confirm each one is either
reported or provably unreachable.** An `if (!match) return []` is a silent pass wearing the
costume of a guard. `schema-description-sequence` had it right from the start — it reported
`expected … got (empty)`.

## Fixing the deliverable is not fixing the document that specifies it

The same change hit this **three times in three different tasks**, and it is the reason a
verbatim-block check now exists.

`plan.md` quotes text it instructs an implementer to insert into a real file. When a review
round fixes the real file, the plan's copy becomes a specification of the bug that was just
removed. Concretely: `SKILL.md` §2a's verdict rule was corrected to include the emoji-stripping
normalisation, and `plan.md` still told the next implementer to write the un-normalised version
— which stops the review stage on every valid review. Two more instances: an `apply.md` block
quoted without the conditional comment a fix had added, and two full copies of delivered
`.mjs` files that had each drifted once.

Three reviewers and two fix rounds each caught *some* of these and none caught all of them. What
caught the rest was a script over **every** fenced block in the file, checking each against its
target:

```python
# for each fenced block preceded by a `path/to/file` mention: assert block content is a
# substring of that file, or that the block is explicitly marked superseded
```

Two rules came out of it. **Verify duplicated text mechanically, never by reading** — the
failure is invisible to attention and trivial to a substring check. And when a full copy of a
delivered file sits inside a plan, **replace it with a pointer, not a resynchronised copy**: it
had already drifted once, and a second copy is a new drift surface, which is the class the
whole change existed to remove.

## `git stash push` on an unmodified file creates nothing, and the next `pop` takes someone else's

Used during this change to test a RED case against a previous implementation: `git stash push
<path>` on a file with no working-tree changes stashes nothing and reports nothing useful, so
the paired `git stash pop` popped the developer's own top-of-stack stash and conflicted it into
the tree. Nothing was lost — git keeps the entry when a pop conflicts — but the recovery cost
more than the test.

Use `git show <sha>:<path>` into a temporary file to compare against an older implementation.
It reads history without touching the working tree or the stash stack at all.

## Shift-left checks (added by `flow-shift-left-and-retro`, archived 2026-08-07)

Three checks moved earlier in the pipeline, each traced to a specific archived
change that paid for catching it late instead:

- **(a) Structural validation at propose time** — `openspec validate --all --json`
  now runs in `propose.md` right after `specs` is written, not only at verify. Traces
  to the undocumented first-line-`SHALL`/`MUST` rule above; `i18n-hardcoded-strings`
  hit it only at verify.
- **(b) Plan-authoring risk reconciliation gate** — `schema.yaml`'s `plan` artifact
  instruction now requires every `design.md` Risks/Trade-offs entry to have an
  explicit reconciliation line in `plan.md` before the artifact is done. Traces to
  `i18n-hardcoded-strings`'s duplicate-key incident two sections above: the
  contradiction was in the plan's own *text*, not the code, and only the final
  whole-branch review caught it.
- **(c) Apply-time test run with a verify short-circuit** — see the "producer side"
  note above.

`flow-retro` (`.claude/skills/flow-retro/`) is a fourth, independent addition: a
manually-invoked, session-ID-driven skill that reports on a past session's token
economy and task time — never triggered automatically by any `/opsx:*` command. Its
own `SKILL.md`/`README.md` are the source of truth; nothing here duplicates them.

## Related

- [Guidelines](../guidelines.md)
- [Tech Stack](tech-stack.md) — the workspace packages check 6 maps paths onto
- [Infra](infra.md) — the CI half of the same review: the verdict gate, the transport/content
  exit split, and the `set -e` exit-status lesson the local stage shares
