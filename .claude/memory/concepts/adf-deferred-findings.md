# ADF Flow — Deferred Findings

Open findings from the ADF change workflow's own changes: things a change found, decided not
to do, and recorded. `/opsx:archive` may not close a change leaving a debt line whose only home
is a commit message, so this page is where those lines land when they are not immediately
proposed as a follow-up change.

Each entry is classified:

- **defect** — the code or the check is wrong; a follow-up change fixes it.
- **deferred wording** — a rule stated twice whose deduplication would change what a surface
  says. The relocation rule forbids doing that inside a motion diff, so it needs its own change.
- **decision** — recorded as accepted, with the condition under which it is revisited.

Current source: `adf-normative-single-source` (archived `2026-08-27`), whose `ledger.md` carried
13 debt lines (11 distinct — two were recorded twice). Everything below is unresolved unless
marked otherwise.

---

## A. `adf-metrics.mjs` — five open findings

All five are in `.claude/scripts/adf-metrics.mjs`, and **none belongs to
`adf-normative-single-source`'s own additions**; they were found by the tuned review while it
was reading the file for other reasons. A follow-up change fixing this file should take all
five at once — they are the same file and reviewing them together loses no clarity.

| # | Severity | Where | Finding | Class |
|---|---|---|---|---|
| A1 | LOW | `:658` | Fix `69163fbd`'s own safety statement is one input value too wide. `join(undefined, …)` throws as its author claimed, but `join('', …)` returns a relative path that resolves against the working directory and silently reproduces the defect the fix removed. No caller produces an empty value today — the production path derives it from `git rev-parse --show-toplevel` — so the code is correct for every input it receives; what is wrong is the argument written beside it, which the next person to add a caller will read. | defect (latent) |
| A2 | MEDIUM | `~:805` | The session transcript is split and JSON-parsed **three times per session**. | defect (performance) |
| A3 | LOW | `~:727` | `extractMetrics` duplicates its eleven-field return shape between the no-ledger early return and the real one, so a new metric added to one drifts from the other. | defect (maintainability) |
| A4 | LOW | `~:301` | `deriveVelocity` encodes "unmeasured" three ways in one object — a `.toFixed()` string, the number `0`, and `null`. | defect (maintainability) |
| A5 | LOW | `~:741` | The ledger fallback tries `projectKeys[0]` only, where the loop fifty lines below tries both, so a valid layout reports `(no sessions found)` for a ledger that is present. | defect |

**Resolved, recorded for the lesson only:** `measureNormativeBytes` resolving its paths from
the working directory (so `adf-metrics.mjs --repo <path>` reported `(no source)` for every
phase) was filed by the implementer as accepted debt and then raised HIGH by the review and
fixed in `69163fbd`. Filing something as debt is not evidence that it is not a defect — see
[Normative Surface Size](normative-surface-size-metric.md).

---

## B. Checks that ask the wrong question

| # | Where | Finding | Class |
|---|---|---|---|
| B1 | `/opsx:verify` Check 1 | The check runs `openspec validate --all`, which validates **every change in the repository**, inside a command that verifies **one** change. Seven neighbouring changes stopped at propose (`.openspec.yaml`, `brainstorm.md`, `proposal.md`, no `specs/`) correctly report "no deltas found", so the check's verdict moves with how many unrelated drafts exist and its stated bar — every item valid — cannot be met without driving every neighbouring proposal to specs. Correct scope: `openspec validate <change> --type change --strict`, optionally with a separate `--type spec` pass over the corpus. Deferred because changing what a check does is a semantic edit and that change was motion-only by its own constraint. | defect |
| B2 | `check-workflow-shape.mjs` | The artifact-row regex is scoped to **all** of `.claude/CLAUDE.md` §5, so any §5 table whose first cell is bare backticked code is misparsed. Worked around by writing the surface-map cells bold-wrapped; the script is untouched and **the trap is live for the next editor**, with no comment in §5 explaining why those cells look the way they do. | defect |
| B3 | `normative-duplication.test.mjs` | Every test fixture is synthetic, while `design.md` named "a test fixture drawn from the real repository" as the mitigation against repeating `check-workflow-shape.mjs`'s ten-false-positives history. The narrowing was in fact done by allowlisting real findings. | defect (test coverage) |

---

## C. The duplication allowlist, and the rules still stated twice

`KNOWN_DEFERRED_DUPLICATES` in `.claude/scripts/adf-regression/normative-duplication.mjs`
pins **ten** sentences. The check is green only because of them; emptying the allowlist
surfaces **11 genuine restatements** the corpus still carries.

| # | Finding | Class |
|---|---|---|
| C1 | Neither the allowlist nor its self-expiry has a requirement or a design decision behind it. Either `normative-text-single-source` gains one, or the rows are resolved and the allowlist is emptied. | defect (spec gap) |
| C2 | **The allowlist self-expires by comment, not by mechanism.** Nothing fails when an entry outlives the inventory row it was pinned for, so the follow-up change must actually be proposed — the allowlist will not force it. Worse: resolving a row without pruning its entry leaves the check blind to any *new*, unrelated restatement that normalises to the same text. | decision, with a known failure mode |
| C3 | `design.md:102-103` claims the flow-defining file set is "stated once in the `normative-text-single-source` capability and mirrored in the script's constant". The capability never states the set; `normative-duplication.mjs:10-30` is its sole statement. Either the capability gains the set or the design sentence is wrong. Because `openspec/specs/` is archive-only, correcting it means a change. | defect (design/spec drift) |

### C4 — Eight wording groups from the inventory (counted against the stopping rule)

These are the eight that the pre-relocation inventory classified as needing a wording change.
Eight against a threshold of ten is why the change proceeded.

| Group | Rule | Stated on | Assigned |
|---|---|---|---|
| G1 | An ambiguous or missing change name prompts the developer for the available changes | commands (4 files) | `.claude/commands/opsx/*` |
| G9 | The developer chooses the change; never guessed or auto-selected, not even at one candidate | commands (4 files) | `.claude/commands/opsx/*` |
| G17 | Delta spec format: SHALL/MUST, four-hashtag scenarios, full MODIFIED text, Reason and Migration on REMOVED | schema, templates | `schema.yaml` |
| G22 | Name the capability level, never a model or a vendor | CLAUDE.md, commands, schema | `.claude/CLAUDE.md` §5 |
| G37 | A false-positive claim is a proposal put to the developer; silence never resolves a finding | schema, templates | `schema.yaml` |
| G49 | The memory-ingest timestamp comes from `date`, never guessed | CLAUDE.md §4, commands | `.claude/CLAUDE.md` §4 — *no map surface covers it* |
| G59 | A hardware smoke pass belongs to the group that lands the write path, never a single task at the end | schema, templates | `schema.yaml` |
| G60 | A capability name is a compound noun of at least two words, never a single word | templates | `schema.yaml` |

G1, G9, G17, G37, G59 and G60 share one root cause: the map governs duplication *between*
surfaces and says nothing about duplication *within* one — `.claude/commands/opsx/*` is one
surface holding six files, and `templates/` is named by no surface at all. G49 has the mirror
problem: memory-workflow rules have no assigned surface.

### C5 — Eleven post-relocation discoveries (deliberately **not** re-counted)

Found after the stopping-rule count was taken and the `proceed` verdict recorded, so they were
kept out of that count on purpose — a verdict re-decided against a growing list is a verdict
nobody can audit. All classified **deferred wording**.

- **G13 — the `## Deviations` paragraph** (`apply.md:326`). The rest of G13 moved into
  `schema.yaml`'s `apply` instruction; this sentence could not, because inside the schema
  "this command" no longer names `apply.md`. Left byte-identical.
- **G47 — the archive-commit guard** (`archive.md:367-369`). References `archive.md`'s own
  "step 7" and "the guard above"; neither referent survives relocation. Left whole.
- **G5-partial — the task-grouping cascading/mechanical criteria.** `.claude/CLAUDE.md` §5 and
  `schema.yaml`'s `tasks` instruction state it in **independently authored** wording — §5
  carries the stale-mock anecdote, the schema carries its own example, neither is a subset of
  the other. Left in both places.
- **D1 — the `--store` flag paragraph** ("Other commands do not take the flag."), in all six
  command files. **Out of scope**: CLI usage guidance, necessarily repeated because each
  command file is an independent entry point.
- **D2 — the Superpowers pre-flight check**, in `archive.md`, `propose.md`, `review.md`,
  `verify.md`. A real relocation candidate, but it has no canonical home to point at yet.
- **D3 — the degraded-command-surface reaction** ("Do not restore the files yourself…"),
  `apply.md:33` and `propose.md:43`. Same shape as D2.
- **D4 — the single-candidate confirmation rule**, `apply.md`/`archive.md`/`verify.md`. No
  equivalent in `schema.yaml`'s `resolve` instruction to point at.
- **D5 — the single-candidate auto-select rule**, same three files. Sits beside G9 but is not
  part of G9's recorded text.
- **D6 — the worktree-path-not-rederived rule**, same three files, step 3. `resolve` covers
  step 2's candidate selection, not step 3's entry.
- **D7 — the worktree sanity-check rule** ("The second command must print the worktree
  path."), same three files, same block.
- **D8 — the npm-in-a-worktree exception.** Stated on `.claude/CLAUDE.md:135-138` (which also
  carries a pointer) and again at `schema.yaml:617-621`. The exception set is verbatim on both
  surfaces but the surrounding sentences are phrased differently, so
  `normative-duplication.mjs` — which compares normalised sentences, not meaning —
  **structurally cannot see the pair** and holds no allowlist entry for it. The two copies can
  drift apart with nothing failing. This is the one worth fixing first.

D2 through D7 all resolve the same way and are the natural content of one follow-up change:
each needs *new canonical text authored* in `schema.yaml`, not an existing statement trimmed.
D1 resolves by being declared out of scope. G13, G47 and G5-partial need a wording decision.

---

## D. Decisions recorded as accepted

| # | Decision | Revisit when |
|---|---|---|
| D-a | **The Normative Surface Size metric is on probation.** It sums both surfaces, so relocating a sentence nets zero while every pointer left behind scores as growth; it made a motion-only change almost certain to report a rise, and it did (+8317, +6.5 %). It also overlaps `## Token Economy` and `## Maintainability` and measures worse than both. Kept rather than deleted, to be watched. Candidate replacements: per-phase command-file size, or a count of the places a rule is stated in full. This is also a defect in how `design.md` D6 and the `normative-text-single-source` requirement were worded, not only in the result. | Five archived changes carry a Normative Surface Size figure. Count so far: **1**. See [Normative Surface Size](normative-surface-size-metric.md). |
| D-b | **`schema.yaml` grows and the command files read less well standalone.** Accepted at design time: it is the surface the flow already treats as authoritative and the one `openspec update` cannot rewrite. Measured: commands -4844, schema +13161. | Not scheduled. The consequence — a command file no longer states its rules — is in [The Four Normative Surfaces](normative-surface-map.md). |

---

## Carried forward from `adf-flow-improvements` (archived `2026-08-26`)

Still open, recorded here so there is one list rather than two:

- A test asserting `unparsed === 1` pins a defect: a markdown table header counted as an
  unparsed dispatch line.
- `parseSessions` misreads a table-formatted session row.
- Both regression checks report `ok: true` if their scan roots resolve to nothing — the exact
  failure mode they exist to prevent.
- No bound exists on when a task group deserves its own controller agent.

## E. Gaps found by the branch audit, unclosed at import

Two structural gaps recorded by the read-only audit of the `adf-improvements` branch
(2026-08-27, origin project) that no change has closed and that are still live in this
repository. Both are about how the flow's own rules reach an executor, not about a
particular change.

| # | Where | Finding | Class |
|---|---|---|---|
| E1 | `infra/claude/review-prompt.md:11` | `Skip ALL .md files entirely`. The flow's normative surface *is* markdown — `.claude/CLAUDE.md`, `.claude/commands/opsx/*.md`, the templates — so on a change to the flow itself the tuned review sees almost nothing, and an edit to `review-prompt.md` is reviewed by no reviewer at all. The rule is right for product code and wrong for this repository. Minimum viable fix: an exception for `openspec/**` and `.claude/commands/**`. | defect |
| E2 | `.claude/scripts/adf-regression/` | The check set has no executable entry point. Its only caller is the inline `node --input-type=module -e` one-liner inside a prose step of `.claude/commands/opsx/verify.md:357`. It is not in `.lefthook.json` (which runs `check-english.mjs` only) and not in CI. `index.mjs`'s own header condemns exactly this shape: a defect caught by prose is caught only if an agent reads and honours the paragraph. | defect |

---

## Related

- [The Four Normative Surfaces](normative-surface-map.md)
- [Normative Surface Size](normative-surface-size-metric.md)
- [OpenSpec + Superpowers Workflow](opsx-workflow.md)

## Carried forward from `adf-maintainability-gates` (archived `2026-08-27`)

Five items. None blocks; each is classified defect / deferred wording / decision.

| # | Item | Class |
|---|---|---|
| 1 | The removal-accounting finding has no named verifier — the sweep is issued once per change and cannot re-check a `**Code Disposition:**` corrected after apply concludes. Recorded LOW in that change's `review.md`. | defect |
| 2 | `schema.yaml`'s removal paragraph says the debt line carries "its reason" where every neighbouring ledger line carries *the developer's* reason, leaving an executing agent to guess whose. | deferred wording |
| 3 | The suppression marker's grammar is a C-style comment, so no YAML or markdown surface can carry it. A finding against `schema.yaml` has no durable dismissal path — the reasoning can only live in `review.md`, and CI raises it again on the merge request. | defect |
| 4 | `adf-metrics.mjs` wrote a well-formed report whose Token Economy, Velocity and Dispatches sections are all `(no source)` / `0`. The cost dataset did not accumulate and nothing said so. Why the transcript was not found was never diagnosed. | defect |
| 5 | `.claude/memory/log.md` is out-of-plan by construction on every change: `.claude/CLAUDE.md` §4 mandates the propose-time entry before `plan.md` exists, and verify check 10's allowlist has no entry for it. Two consecutive changes have recorded the identical warning. Adding the allowlist entry needs a requirement behind it — see section C. | deferred wording |

Two more, both about checks rather than about the change:

- **Verify check 1 fails on every change, for reasons belonging to no change.** It runs
  `openspec validate --all`, so its verdict moves with how many undeveloped drafts exist — six at
  this archive. Two consecutive changes have talked their way past it on precedent. This is the
  same shape `ai-review-ci-gate` argues against for MEDIUM findings: a gate that fires on
  something the developer cannot act on teaches them to step over the verdict. Candidate fix:
  make `openspec validate <change> --strict` the blocking part and the corpus-wide run an
  advisory line. Classified **defect**, in section B's family.
- **`normative-duplication.mjs` passed while two real duplications existed** in the very change it
  was built to guard. Blind spots and the narrow candidate fix are on
  [[normative-surface-map]]. Classified **defect**.

One decision, recorded as accepted:

- **The removal-accounting finding never blocks**, though the change's own argument is that an
  advisory class accumulates. Accepted knowingly in that change's `design.md` D-8: it differs
  from the accumulating case in producing a ledger debt line `/opsx:archive` must resolve rather
  than a note in a review comment. If it accumulates anyway, the evidence will be in the ledgers.
