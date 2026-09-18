# OpenSpec + Superpowers Change Workflow

The mechanics of the cycle — the five commands, the eight artifacts, the branch model —
live in [`.claude/CLAUDE.md`](../../CLAUDE.md) §5 and, in requirement form, in
`docs/flow-specs/change-workflow-schema/`, `change-branch-isolation/` and
`superpowers-availability-gate/` — historical documents, not live specs. This page does not
restate them.

This page carries what neither the specs nor git history explain: why the surface is shaped
the way it is, and which of its parts fail silently.

## Where each thing is written

| Thing | Written by | Never written by |
|---|---|---|
| `openspec/specs/**` (permanent capabilities) | `/opsx:archive`, step 6 → step 7 | anything else, ever — not by hand, not backfilled |
| `openspec/changes/<name>/**` | the five commands, in artifact order | — |
| `.claude/commands/opsx/*.md` | humans and changes to this workflow | `openspec update` (see below) |

Since `adf-normative-single-source` (archived `2026-08-27`) there is a second, sharper
question — not *who writes the file* but *which surface owns the rule*. Four surfaces, four
roles: `openspec/specs/` says what must be true, `schema.yaml` says how a phase executes and
carries the full procedure, `.claude/commands/opsx/*` carry the operator imperative plus a
pointer, and `.claude/CLAUDE.md` §5 carries invariants and no mechanics. The map, the pointer
form, the duplication check that enforces it and the traps it left behind are on their own
page: [The Four Normative Surfaces](normative-surface-map.md).

## A command file no longer tells you the rule

This is the consequence of the surface map that is stated in **no single file**, and it is the
first thing to know before editing anything under `.claude/commands/opsx/`.

`apply.md` carries eleven pointers into `openspec/schemas/sdd-plus-superpowers/schema.yaml` and
no statement anywhere in itself that it is a pointer file. `schema.yaml` carries the procedure
and no statement that the commands defer to it. So:

- An agent that **reads** only `apply.md` acts **correctly but less informed**. That is by
  design: a pointer is one sentence carrying the imperative *and* its one-line consequence, so
  an agent that does not follow the pointer still does not take the wrong action. Mechanics live
  behind the pointer; the consequence never does.
- An agent that **edits** only `apply.md` to change a rule changes **nothing** — the rule is
  stated in `schema.yaml`. The diff reads correct, reviews as correct, and has no effect on how
  the phase executes.

Practical rule: before editing a workflow rule, grep the sentence across all four surfaces and
edit the one that states it in full. If two surfaces state it in full, that is a duplication
finding rather than a choice of where to edit.

The same change gave `schema.yaml` three new **top-level** blocks — `resolve:`, `propose:` and
`archive:` — because every rule assigned to the schema whose home was `propose.md` or
`archive.md` previously had no block to move into. Two consequences bite immediately:
`openspec instructions` returns the artifact instructions and `apply` and **does not retrieve
those three**, so a pointer naming them means "read that block of the file directly"; and any
tool walking the schema must resolve a top-level anchor and not only an `- id:` anchor —
`adf-metrics.mjs` did not, and reported `(no source)` for a 3254-byte block that exists.

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
verify and archive. Mechanics live in `docs/flow-specs/ai-review-flow-stage/` and
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
as the CI parser, found on both surfaces, fixed properly on one of them
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

`adf-retro` (`.claude/skills/adf-retro/`) is a fourth, independent addition: a
manually-invoked, session-ID-driven skill that reports on a past session's token
economy and task time — never triggered automatically by any `/opsx:*` command. Its
own `SKILL.md`/`README.md` are the source of truth; nothing here duplicates them.

## The capability corpus now has a lint too — and it never blocks

`.claude/CLAUDE.md` §4 defines a **Lint Workflow** for `.claude/memory/`: contradictions, stale
claims, orphan pages, concepts lacking their own page. `openspec/specs/` has no counterpart. Its
capabilities grow monotonically through delta merges at archive, and nothing ever reads the corpus
back as a whole to ask whether it still describes one coherent system.

The asymmetry was worth naming because the spec corpus is this flow's answer to comprehension debt —
the tracked description of what the system does, maintained by a mechanism no single change controls.
An answer nobody reads back goes stale silently, and the failure mode is exactly the one the memory
lint hunts, one level up.

**`adf-normative-single-source` closed it** (archived `2026-08-27`): `.claude/skills/spec-corpus-lint/`
reads `openspec/specs/` whole and reports three classes — contradictions between capabilities,
requirements no capability owns, and introductory prose that contradicts the requirements below it.
Its shape is `adf-retro`'s: `SKILL.md` + `README.md`, no script, **manually invoked only**, never
triggered by `/opsx:propose`, `/opsx:apply`, `/opsx:verify`, `/opsx:archive` or any CI job. It is
deliberately not a section of `adf-retro`: that skill's input is one session transcript and its
question is how one execution went; this one's input is the corpus and its question is whether it
still says one coherent thing. They share a cadence, not a subject.

**It reports and never blocks, and that is a requirement rather than a convenience.** The measured
disease of this flow is monotonic gate growth, so a coherence report that failed a phase would cost
more than the incoherence it detects. Cadence: every third to fifth archived change, and
immediately after any change that hand-edited a capability's introductory prose — that hand edit is
the event most likely to have created the incoherence.

Note the constraint any such lint works under: `openspec/specs/` is written **only** by
`/opsx:archive`, with one exception — a capability's introductory prose above `## Requirements` is
not a requirement, no delta merge can reach it, and a change may edit it by hand on its own branch,
with `verify.md` recording which capabilities and why. That prose is therefore the only part of the
corpus a lint's findings can be acted on directly; everything below `## Requirements` has to go
through a change.

## Every rule this flow makes mandatory has another site still stating the old version

Measured on `adf-flow-improvements` (archived 2026-08-26): **seven instances in one change**, and
not one was found by a check. The execution graph's optionality survived in `.claude/CLAUDE.md` §5
and again in `schema.yaml`'s own `apply` instruction after the `plan` instruction had been
corrected; the required `**Level:**` field was missing from the schema's own enumeration of task
fields and contradicted by §5's dispatch-time framing; the verification check count survived stale
in two unguarded literals; and the apply test-record ordering survived in `schema.yaml` after
`apply.md` was changed.

This generalises the page's own earlier note that adding a verify check means touching three files.
It is not specific to verify checks: **it is the shape of every rule change in this flow.** The
detector that exists — `check-workflow-shape.mjs` — compares declarations against a derived shape,
so it catches a stale *count* and nothing else. Five sites declare the check count; three are
guarded. A rule that is prose in two places and mandatory in one is invisible to it by
construction.

`adf-normative-single-source` (archived `2026-08-27`) attacked the cause rather than the symptom:
a rule is now stated in full on exactly one surface, so there is no second site to leave stale, and
`.claude/scripts/adf-regression/normative-duplication.mjs` fails when one normalised normative
sentence appears in two flow-defining files. It is not a complete answer — the check is green only
because ten sentences are allowlisted, it compares normalised text rather than meaning (so a rule
worded differently on two surfaces is invisible to it), and duplication *within* one surface is
outside the map entirely. See [The Four Normative Surfaces](normative-surface-map.md) and
[ADF Deferred Findings](adf-deferred-findings.md).

Until those gaps close, the mechanical method still applies: after making a rule mandatory, grep the
repository for the old formulation before considering the task done. Seven for seven says the prior
probability of a second site is not low, it is high.

## A tool exercised only on empty input passes every gate

Two defects in `adf-metrics.mjs` survived `/opsx:verify` and two rounds of AI review, and both were
of one kind: code implementing an assumption about real data that had never met real data.

`deriveProjectKey` stripped a leading dash that the real `~/.claude/projects/<key>/` directory
keeps, so every session was unresolvable. `parseTokens` read `record.usage`, which the real
transcript never carries — the field is `record.message.usage`, in 506 records of 1447. The token
column, the change's headline deliverable, was structurally always zero.

Neither was reachable by any reviewer, and calling that a review miss would be wrong. The ledger
carried no session line, so the extractor correctly printed `(no sessions found)`, every gate saw
correct behaviour on an empty input, and the tests — real tests, written first — asserted against
synthetic fixtures that encoded the same wrong assumption as the code. **The empty set is a
passing input for everything.**

The defect appeared within a minute of the first real session line being written. No stage of this
flow requires a new tool to be run against a non-empty real input before it is reviewed, and that
is the gap. It cannot be made a deterministic check — "was this exercised against real data" is a
judgement — so it is recorded in `.claude/scripts/adf-regression/README.md` under the set's
non-scriptable heading, with the question a reviewer should ask instead.

## A working-directory instruction does not bind a subagent's later tool calls

A dispatch that says "work in `<path>`" is honoured for as long as the agent remembers to honour
it. Tool calls do not inherit it; each one starts from the session's own working directory. This is
not a subagent defect — the orchestrator hit it too, when a `cd` from one `Bash` call leaked into
the next and a ledger write landed nowhere.

It cost two things in `adf-flow-improvements`. One of three wave-1 groups ignored its worktree
entirely and committed to the change branch, so its work bypassed the group-branch review gate —
caught only because the compliance table compared the graph's declared groups against the worktrees
`git` actually showed. And a dispatched agent ran a repository-wide `git add -A` in the developer's
shared dirty checkout, unrecoverably destroying two uncommitted files that belonged to neither the
change nor its plan.

Two rules follow, and the second is now a regression check
(`.claude/scripts/adf-regression/dispatch-git-safety.mjs`):

- Every path in a dispatch and in a verification command is absolute. Prefer `git -C <repo>` over
  `cd` for git.
- No dispatch-facing instruction tells an agent to run an unscoped repository-wide git mutation.
  `git add -A <path>` is fine; bare `git add -A`, `git add .`, `git checkout --`, `git restore`,
  `git stash push` and `git clean` are not. `/opsx:propose` already guards its own branch
  operations by refusing a dirty tree; apply and verify dispatch dozens of writers and had no
  equivalent.

## A group controller is a third agent layer, and on a small group it costs more than the work

`adf-flow-improvements` fanned three wave-1 groups, each with its own controller agent running
`subagent-driven-development` for its slice. All three failed the same way: each stopped believing
a child was still live when that child's work was already committed. One spent ~96k tokens and 35
tool calls to land four tasks; another ~115k on a two-task group.

The controllers were collapsed mid-apply and the remaining fourteen tasks ran as direct dispatches
from the orchestrator — implementer plus an independent review per dispatch, the gate preserved and
the middle layer removed. Nothing in the flow bounds when a group deserves its own controller. A
group of one or two tasks almost certainly does not.

One caveat learned the hard way: collapsing a controller does not stop the children it already
dispatched, and a parked controller is not a stopped one. Both landed commits under later
dispatches. The sharpest single output of the three controllers was one of them noticing the
collision and declining to kill the intruding dispatch mid-edit.

## Subagent cost is measurable, and the harness is the source — never the agent

The obvious way to attribute cost per actor is to ask each dispatched agent to report its own token
usage. That is wrong twice over: an agent cannot read its own usage counters, so it would report an
estimate, and the whole premise of this flow's measurement layer is that a script cannot fabricate
a figure. Self-reporting makes the measured party its own accountant.

The deterministic source already exists in the orchestrator's transcript. When a dispatched agent
completes, the harness writes a task notification carrying
`<usage><subagent_tokens>N</subagent_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>`
into a `type: "queue-operation"` record. Three cautions, all measured:

- The same notification is written into more than one queue operation (`enqueue` and `remove`). A
  naive sum over-counts by **22 %**. Deduplicate on task id plus the figures.
- The same text also appears in `user`, `attachment` and `assistant` records. Restricting the scan
  to `queue-operation` is a safety property, not tidiness: an agent that pastes a `<usage>` block
  into its own prose must not be able to inject a number into a measurement.
- `subagent_tokens` is a **total**, not an output count. The harness does not split it, so reporting
  it in an output column mislabels it.

`isSidechain` is useless for this: it occurs zero times in a real orchestrator transcript, because
subagent turns are not in that transcript at all.

## `/opsx:review` reviews a schema-only change — the filter excludes `.md`, not "docs"

Predicted wrong, then measured, during `adf-maintainability-gates` (2026-08-27). The reasoning
was: this change is normative prose, the review stage excludes documentation, therefore the stage
will record "nothing to review" and complete without dispatching. It did not. The filter excludes
`*.md`, `.gitlab-ci*.yml` and the generated/vendored paths — and `schema.yaml` is YAML. Of
sixteen touched files exactly one reached the reviewer, at 8157 bytes of diff, and the tuned
review returned `REQUEST CHANGES` on it.

So the rule is about file extensions, not about whether text is documentation:

- A change touching `openspec/schemas/**/*.yaml`, `.lefthook.json` or any non-`.md` config **is**
  reviewed by this stage.
- A change touching only `.claude/commands/opsx/*.md`, `openspec/specs/**/*.md`, `.claude/CLAUDE.md`
  or the change's own artifacts is **not** — the diff is empty and the record is a `PASS` with a
  `## Not reviewed` section.

The consequence worth holding: for a flow change, `/opsx:review` covers the schema and nothing
else. The edit with the widest blast radius in `adf-maintainability-gates` —
`infra/claude/review-prompt.md`, the prompt every merge request in this repository runs — was
never seen by this stage at all. It was covered twice elsewhere, by its own task review and by the
whole-branch review, and that is the only reason the gap did not matter.

## A finding against a YAML file cannot be dismissed durably

The suppression marker is `// review-ignore: <key> — reason`, honoured by both the prompt and the
CI review, and its whole point is that a dismissal travels with the code rather than with the
session. It is a C-style comment. No YAML or markdown surface can carry it.

`adf-maintainability-gates` hit this for real: the tuned review's single HIGH was raised against
`schema.yaml`. Had it been dismissed rather than fixed, the reasoning could only have lived in
`review.md`, and the CI review would have raised it again on the merge request — the
local-pass-then-CI-block drift the no-local-copy rule exists to prevent, arriving by the other
door. It was fixed instead, which sidestepped the question rather than answering it.

That change widened the marker's permitted key set (`DUP` beside `CWE-XXX`). It did not widen the
comment syntaxes the marker can live in, and nothing in the flow currently can.

## The flow now has exactly one blocking maintainability class, and it is local

Added by `adf-maintainability-gates`. A confirmed duplicate found by the code reuse sweep stops
apply from concluding; every other maintainability finding keeps the advisory standing
`review-prompt.md` gives it, and the merge-request gate's thresholds did not move. The full shape,
the invariant that no single file states, and the four requirements nothing has yet exercised are
on [[code-reuse-sweep]].

## Related

- [The Four Normative Surfaces](normative-surface-map.md) — which surface owns which rule, the
  pointer form, the duplication check and its allowlist
- [Normative Surface Size](normative-surface-size-metric.md) — the per-phase byte metric, on
  probation, and the baseline error that made its number wrong twice
- [ADF Deferred Findings](adf-deferred-findings.md) — open defects, deferred wordings and recorded
  decisions this flow's own changes left behind
- [ADF Cost Baseline](adf-cost-baseline.md) — the end-to-end cost measurements of this workflow
- `infra/claude/` — the CI half of the same review: the verdict gate, the transport/content
  exit split, and the `set -e` exit-status lesson the local stage shares

## Three of seven tasks stopped on a baseline number the plan got wrong

Same change (`adf-maintainability-gates`). Each task's RED step recorded a measurement before
editing, and three of the seven had a literal that did not match the tree: a suppression-marker
key count in `review-prompt.md` was off by one; a field-name grep across `openspec/` and
`.claude/` returned far more hits than expected, because the change's own planning artifacts
name the field; and a verify step used a CLI flag the installed CLI does not have (the name is
positional, not a flag).

Two of the three implementers stopped and reported rather than editing, which is what the dispatch
asked of them and it was right both times. But the cause is one thing: **the plan's greps were
written from reasoning rather than from execution.** `schema.yaml`'s `plan` instruction already
requires every symbol, file and path a task names to be resolved against the tree before the plan
is done. It does not extend that to command output. Extending it — if a RED step states an
expected number, that number came from running the command while writing the plan — is the
narrowest fix and is filed on [[adf-deferred-findings]].

## A markdown-only change cannot exercise the mechanism it defines

From `deferred-findings-ledger` (2026-09-17). The empty-input lesson above has a second form,
and this change hit it in a way no gate reported.

The change defined a new `## Recorded findings` section that `/opsx:review` fills and
`/opsx:archive` drains into the technical debt ledger. Exercising it needs a review that
produces a finding. But `.claude/skills/ai-code-review/SKILL.md` excludes `*.md` from the diff
the tuned review reads — correctly, since `infra/claude/review-prompt.md` orders the reviewer
to skip markdown — and this change is markdown: the ledger, the memory pages, the command
files, the record template and the skill itself. Forty of its forty-two files were filtered
out. The two survivors were YAML carrying prose. The review returned APPROVE with zero findings
at every severity, which is a true statement about what it could see and no statement at all
about the change.

**So a change to the flow cannot be reviewed by the flow's own tuned gate, and a mechanism
defined by such a change cannot be given a non-empty input by it.** The archive-side half was
proven instead, on a real pre-existing defect found while running the change. That is the
honest half-measure; the alternative — constructing a fake finding to claim the path ran — is
the behaviour the empty-input lesson exists to prevent, so it was refused and the gap recorded
in `verify.md` and in the review record rather than papered over.

The detector gap itself is on [[adf-deferred-findings]]. The rule that follows for any future
flow change: **state in `verify.md` which halves of a new mechanism were exercised and which
were not, and never let "the gate was green" stand in for "the path ran".**

## The whole-branch review is where between-task defects surface

Same change. Eight per-task reviews ran, five of them produced fix rounds, and every one was
scoped to its own task's diff. The whole-branch review that `subagent-driven-development` runs
at the end found what none of them could: a capability spec carried a requirement whose scope
clause named a memory file one task had deleted, and the next task's repoint sweep never
reached it, because that sweep was scoped to `.claude/memory/`. One task saw the deletion,
another saw the memory tree, and the broken reference lived in neither.

It could not be fixed by hand either — everything below a capability's `## Requirements`
heading is written only by `/opsx:archive` — so it needed a fourth delta spec added after
apply had already concluded. **A change that deletes a file should sweep the whole repository
for references to it, not the subtree the deletion happened in.**

## A flattened sweep dies on locale, silently

Same change. The wrapping-tolerant sweep this flow prescribes — flattening each file with `tr`
before matching, so a sentence broken across two lines is still found — aborts with
`Illegal byte sequence` on roughly 150 files of the origin repository under the default locale,
and says nothing. It skips them. `LC_ALL=C` is the fix, and that change's plan carries it on
all three pipeline stages. It hid nothing that time; a sweep that stops reading part of the
tree without saying so is exactly the failure the sweep exists to catch.
