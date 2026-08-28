# The Four Normative Surfaces, and Where a New Rule Goes

Installed by `adf-normative-single-source` (archived `2026-08-27`,
`openspec/changes/archive/2026-08-27-adf-normative-single-source/`). Before it, the same
rule of the change workflow was written two to four times, in different words, across
`openspec/specs/`, `openspec/schemas/sdd-plus-superpowers/schema.yaml`,
`.claude/commands/opsx/*.md` and `.claude/CLAUDE.md` §5. Sixty-one distinct rule groups were
inventoried; fifty-three of them were pure duplication.

The map itself is normative in `openspec/specs/normative-text-single-source/` and restated
for the developer in `.claude/CLAUDE.md` §5. This page carries what neither of them says:
what the map costs a reader, what it does not cover, and the traps it left behind.

## The map

| Surface | Normative for | Carries |
|---|---|---|
| `openspec/specs/` | what must be true of the flow | requirements and scenarios only |
| `schema.yaml` | how a phase executes | the full procedure, per artifact and for apply |
| `.claude/commands/opsx/*` | what the operator does | the imperative, plus a pointer |
| `.claude/CLAUDE.md` §5 | invariants a developer must know | no mechanics |

A pointer is **one sentence**: the imperative, its one-line consequence, and the surface that
states it in full. Mechanics live behind the pointer; the consequence never does — an agent
that does not follow the pointer must still not do the wrong thing. A pointer that names only
a surface to read is incomplete.

The command files were chosen as the *least* durable surface deliberately: they are what
`openspec update` regenerates from upstream templates, and that command has already cost this
repository 140 measured lines (see [opsx-workflow](opsx-workflow.md)). Procedure held only
there is the procedure most easily lost. The rejected alternative — make the commands
normative and reduce the schema to an artifact graph — fails on exactly that.

## The consequence no single file states

**A command file no longer tells you the rule.** This is the invariant the change introduced
and the one that is visible in no single file:

- An agent that reads only `.claude/commands/opsx/apply.md` will act **correctly but less
  informed** — the pointer carries the imperative and its consequence, so the failure mode is
  a thinner correct action, never a wrong one. That is the designed safety property, not an
  accident.
- An agent that **edits** only `apply.md` to change a rule changes **nothing**, because the
  rule is stated in `schema.yaml`. The edit will read as a correct diff, pass review as a
  correct diff, and have no effect on how the phase executes.

Neither file says this about itself. `apply.md` carries eleven pointers into `schema.yaml`
and no statement that it is a pointer file; `schema.yaml` carries the procedure and no
statement that the commands defer to it. The only place the relationship is written down is
the map — and the map is a table about surfaces, not a warning about editing. Hence this page.

The practical rule: **before editing a workflow rule, find its owning surface first.** Grep
the sentence across all four surfaces; the surface that states it in full is the one to edit.
If two surfaces state it in full, that is a duplication finding, not a choice.

## The schema gained three top-level blocks

`schema.yaml` previously carried one instruction per artifact plus an `apply` instruction, and
nothing else — so every rule assigned to `schema.yaml` whose home was `propose.md` or
`archive.md` had no block to move into. The change added three top-level keys:

| Key | Line (at archive) | Read by |
|---|---|---|
| `resolve:` | 487 | apply, verify, archive — change/worktree selection, written once |
| `propose:` | 534 | propose |
| `archive:` | 857 | archive |

Two things follow, and both bite:

- **`openspec instructions` does not retrieve them.** That command returns the artifact
  instructions and `apply`. A pointer naming `resolve`, `propose` or `archive` names a
  *top-level block of the file* and must be read there directly. `.claude/CLAUDE.md` §5 says
  this in one sentence; nothing else does.
- **Any tool that walks the schema must handle a top-level anchor, not only `- id:`.**
  `adf-metrics.mjs`'s `extractSchemaInstructionBytes` did not, so it reported `(no source)`
  for `archive:` — a 3254-byte block that exists — and the change's own acceptance number was
  measured over the wrong scope. See
  [Normative Surface Size](normative-surface-size-metric.md).

`resolve:` is reported on its own row rather than charged to each of the three phases that
read it, on the principle that **text written once exists once**.

## The duplication check, and its allowlist

`.claude/scripts/adf-regression/normative-duplication.mjs` fails when one normalised normative
sentence appears in two files of the flow-defining set. It joins the existing regression set
(run by `/opsx:verify` as one check reporting per item) rather than becoming a new numbered
check — `flow-regression-checks` fixes that placement, and a new gate would fight
`adf-flow-improvements`'s removal pressure.

Design constraints, each with a reason that has already been paid for once:

- **Modal-only matching** (`MUST`, `SHALL`, `NEVER`, `never`, `always`, `Do NOT`, matched
  case-insensitively). `check-workflow-shape.mjs`'s own comment records that its first version
  scanned prose and produced ten findings, all false positives. An ordinary sentence appearing
  twice is not a rule.
- **Fenced code blocks and tables excluded.** A command block repeated in two files is a copy
  of an instruction, not a restatement of a rule.
- **The file set is a script constant** (19 entries), not read from `.claude/CLAUDE.local.md`.
  That file is gitignored and personal, so a check depending on it would pass or fail
  differently on each machine.

The check is **green only because ten sentences are allowlisted** in
`KNOWN_DEFERRED_DUPLICATES`. Replacing the allowlist term with `true` surfaces **11 genuine
restatements** the corpus still carries. The allowlist has no requirement and no design
decision behind it, and it **self-expires by comment, not by mechanism**: nothing fails when
an entry outlives the inventory row it was pinned for. See
[ADF Deferred Findings](adf-deferred-findings.md) for the rows and their disposition.

Two blind spots to know about:

- The check compares **normalised sentences, not meaning**. The npm-in-a-worktree exception is
  stated on `.claude/CLAUDE.md` and again in `schema.yaml` with a verbatim exception set but
  differently phrased surrounding sentences, so the check structurally cannot see the pair and
  holds no allowlist entry for it. The two copies can drift apart with nothing failing.
- Every test fixture is **synthetic**. `design.md` named "a test fixture drawn from the real
  repository" as the mitigation against repeating the false-positive history; the narrowing
  was in fact done by allowlisting real findings instead.

## What the map does not cover

The map governs duplication *between* surfaces. Three gaps, all found by the inventory:

1. **Duplication within one surface.** `.claude/commands/opsx/*` is *one* surface holding six
   files. A sentence repeated across all six — the `--store` flag paragraph, the Superpowers
   pre-flight check, the single-candidate confirmation rule — is not a map violation and has
   no stated resolution.
2. **`openspec/schemas/sdd-plus-superpowers/templates/*.md` is named by no surface**, and is
   normative in practice. A rule a template states, alone or alongside `schema.yaml`, has no
   assigned home.
3. **Memory-workflow rules have no surface.** `.claude/CLAUDE.md` §4's rules (the `date`
   timestamp rule, for instance) are duplicated by flow commands, and writing one of the four
   surface names against them would misstate the position.

## Traps left live

- **`check-workflow-shape.mjs`'s artifact-row regex is scoped to all of `.claude/CLAUDE.md`
  §5**, so any §5 table whose first cell is bare backticked code is misparsed. The surface-map
  cells are written **bold-wrapped** (`` **`schema.yaml`** ``) purely to route around it. The
  script was left untouched. An editor who "tidies" those cells back to bare backticks will
  break check 9 and will find no comment explaining why.
- **Relocation is closed on that branch, so several rules were left in two places on purpose.**
  They are not oversights; see [ADF Deferred Findings](adf-deferred-findings.md).

## Relocating text: the reviewability rule

A change that relocates normative text preserves meaning **exactly**. A rule whose wording must
change in order to be deduplicated is recorded as a finding and deferred to its own change —
never rewritten inside the relocation diff. The whole reviewability of a 2800-line motion diff
rests on the claim "nothing changed meaning, only location", and a semantic edit hidden inside
it makes that claim uncheckable.

The stopping rule that guards it: if more than ten rules need a wording change, the change
commits the map and the finding list and stops. On this inventory the count was **eight**, so
it proceeded. Eleven more wording findings surfaced *after* the count was taken; they were
deliberately **not** re-counted against the threshold, so that the recorded verdict stays the
one it was actually decided on.

## Related

- [OpenSpec + Superpowers Workflow](opsx-workflow.md) — the rest of the flow's shape
- [Normative Surface Size](normative-surface-size-metric.md) — the metric that graded this change
- [ADF Deferred Findings](adf-deferred-findings.md) — what this change left undone, and why
- `docs/flow-specs/normative-text-single-source/spec.md` — the requirements
- `openspec/changes/archive/2026-08-27-adf-normative-single-source/notes/normative-inventory.md`
  — all 61 rule groups, their current and assigned surfaces. Origin project only; that
  change directory is not carried here (see `CLAUDE.md` §3)

## The duplication check was green while two real duplications existed

`adf-maintainability-gates` (archived 2026-08-27) is the first change whose work
`normative-duplication.mjs` was built to guard, and the script passed while the whole-branch
review found two genuine duplications it structurally cannot see:

1. **A rule stated twice inside one file.** `schema.yaml`'s `apply:` block asserted "the
   duplicate finding above is the only maintainability class in this workflow that blocks" six
   lines *before* the sentence that stated it — a forward reference to a second copy. The check
   compares across files and never within one.
2. **A rule stated twice with no modal verb.** `.claude/commands/opsx/apply.md` restated the
   sweep's verdict shape in prose carrying no MUST/SHALL/NEVER/ALWAYS/Do NOT, so the matcher
   never considered the sentence at all. Caught by the task review, not the script.

Both blind spots follow directly from the two design choices recorded above — modal-only
matching, cross-file-only comparison — and both were chosen for good reasons: a modal-free scan
measured against this repository produced ten findings of which every one was a false positive.
So the fix is not "drop the modal requirement". The narrow candidate worth trying is
**intra-file matching restricted to `schema.yaml`'s `instruction:` blocks**, where the text is
dense normative prose rather than the ordinary English that generated the false positives.

The practical rule until then: a green `normative-duplication.mjs` is evidence about cross-file
modal-bearing sentences and nothing else. Duplication inside one instruction block, and
duplication phrased as description rather than obligation, are still a reviewer's job.

## `openspec/specs/` is outside the check's file list

`FILES` in `normative-duplication.mjs` lists `.claude/CLAUDE.md`, `schema.yaml`, the `opsx`
commands and the templates. It does **not** include `openspec/specs/` or
`openspec/changes/*/specs/`. So spec-to-schema duplication is invisible to it — and the corpus
already relies on that: `docs/flow-specs/ai-review-flow-stage/spec.md` restates `schema.yaml`'s
severity thresholds and its silence-is-not-approval rule, and has since it was written.

`adf-maintainability-gates` first wrote a `design.md` claiming its blocking class would be stated
in the capability and merely pointed at from the schema. What landed states it in full in both.
The correction went into the design record rather than into the schema, because the register the
corpus actually uses is: **the capability spec states the requirement and its scenarios; the
schema states the procedure in full.** That split is a convention, not a checked invariant.
