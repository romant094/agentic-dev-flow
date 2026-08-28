# Normative Surface Size, and the Three Numbers It Was Given

`adf-metrics.mjs` gained `measureNormativeBytes` in `adf-normative-single-source` (archived
`2026-08-27`): the byte count of normative prose each phase must read — its command file plus
the `schema.yaml` block that phase reads — rendered as a `## Normative Surface Size` section
in the metrics report. It exists because `design.md` D6 made it that change's acceptance
criterion: *a relocation that does not reduce what a phase must read has not done its job.*

Two things are worth remembering about it, and only one of them is about this metric.

## The number was recorded three times and only the third was right

| Recorded | Value | What was wrong with it |
|---|---|---|
| first | `+773` | The instrument was blind to `resolve:`, `propose:` and `archive:` — the three top-level schema blocks *this change itself created*. `extractSchemaInstructionBytes` resolved only an `- id:` anchor, so archive printed `(no source)` for a 3254-byte block that exists, and a neighbour's bytes could be charged to the wrong phase. |
| second | `+7454` | Instrument fixed; **baseline wrong**. It was taken at `51e329c2`, Task 2's commit — so two of the change's own commits (`f9e75f09`, `dbffb36c`) sat on both sides of the comparison and cancelled out. Visible symptom: `apply`'s schema instruction reads 11449 bytes at `0ebea968~1` and 12312 at `51e329c2`, and that 863-byte difference is the change's own growth counted as pre-existing. |
| third | `+8317` | Measured against `0ebea968~1`, the tree the change started from. This is the change's result. |

**Neither error was caught by any check.** Both were found by a human reading the number and
asking what it was compared against. The generalisation, which is the transferable part:

> **A measurement whose baseline is a commit inside the change it measures is a defect class
> no test in this repository detects.** State the baseline revision next to every figure, and
> check that it precedes the change's first commit.

The earlier two figures were deliberately left in the archived record rather than overwritten,
because a record that silently replaces a number teaches nothing about how the number came to
be wrong.

## The result, as measured

| Phase | Before (`0ebea968~1`) | After | Delta |
|---|---|---|---|
| propose | 24084 | 25907 | +1823 |
| apply | 35164 | 37567 | +2403 |
| verify | 32411 | 31993 | **-418** |
| review | 7472 | 7718 | +246 |
| archive | 29740 | 31715 | +1975 |
| resolve (shared) | 0 | 2288 | +2288 (new) |
| **total** | **128871** | **137188** | **+8317 (+6.5 %)** |

Command files fell **4844** bytes; schema instructions rose **13161**. Four of five phases
rose. By D6's own standard the relocation did not do its job, and the change reported that
rather than reframing it.

## The metric structurally cannot show what it was built to show

This is the more important half. The metric **sums both surfaces** — the phase's command file
*and* the schema block that phase reads — so:

- relocating a sentence from one to the other nets **zero by construction**;
- every pointer left behind is new text that scores as **growth**;
- the only way to produce a reduction is to delete duplicates outright, and this change
  allowlisted ten of them instead.

A motion-only change measured this way was almost certain to report a rise, and did. That is a
defect in how the criterion was worded — in `design.md` D6 and in the
`normative-text-single-source` requirement that grades against it — not only in the result.

It also overlaps two sections of the same report that measure better: `## Token Economy` (real
per-actor consumption) and `## Maintainability` (insertions against deletions).

**Candidate replacements**, if it is replaced: per-phase *command-file* size, which fell
honestly (-4844); or a count of the places a rule is stated in full.

## It is on probation, not accepted

The developer's recorded decision: keep the metric and watch it work rather than delete it as
a removal candidate.

**Evaluation trigger: once five changes have archived carrying a Normative Surface Size
figure.** A count of changes, not a date — one data point supports no decision, and a trend
line is this indicator's only defensible use. At that point it is judged on the trend and
either kept, reworded, or replaced by one of the candidates above.

Count so far: **1** (`adf-normative-single-source`).

## Filing something as debt is not evidence that it is not a defect

The second transferable lesson from the same change, and it is about process rather than
measurement.

`measureNormativeBytes` resolved its paths from the working directory while the file's own
`--repo` comment promised the repository root, so running the extractor from anywhere else
printed `(no source)` for files that exist. The implementer filed this as accepted debt —
"not fixed: a signature change with three tests bound to the current shape". The tuned review
raised it as **HIGH** and it was fixed test-first in `69163fbd`.

A debt line is a claim that something is not worth fixing now. It is not a finding, it is not
a review, and it does not survive contact with one. The reviewer's counter-question is the
useful one: *does the code do what the file says it does?*

The fix's own safety argument then turned out to be one input value too wide — `join(undefined,
…)` throws as its author claimed, but `join('', …)` returns a relative path and silently
reproduces the original defect. No caller produces an empty value today (the production path
derives it from `git rev-parse --show-toplevel`), so it is LOW and recorded rather than fixed
— but the next person to add a caller will read that argument. See
[ADF Deferred Findings](adf-deferred-findings.md).

## Related

- [ADF Cost Baseline](adf-cost-baseline.md) — the other measurements in the same report
- [The Four Normative Surfaces](normative-surface-map.md) — what the metric was grading
- [ADF Deferred Findings](adf-deferred-findings.md) — the open findings in `adf-metrics.mjs`
- `openspec/changes/archive/2026-08-27-adf-normative-single-source/notes/normative-inventory.md`
  §8, §11 — the before/after tables and the baseline correction, with a reproduction
  snippet. Origin project only; that change directory is not carried here (see
  `CLAUDE.md` §3)

## Second data point — `adf-maintainability-gates`, 2026-08-27

| Phase | Command file | Schema instruction | Total |
|---|---|---|---|
| propose | 13028 | 13134 | 26162 |
| apply | 20875 | 22335 | 43210 |
| verify | 23350 | 8643 | 31993 |
| review | 5339 | 2439 | 7778 |
| archive | 28461 | 3254 | 31715 |
| resolve (shared) | (no source) | 2288 | 2288 |
| **total** | | | **143146** |

**137188 → 143146, +5958 (+4.3 %).** Baseline revision: the previous change's own archive-time
figure, measured at `0ebea968~1`; this figure is measured at
`0edb481`, the archive commit of `adf-maintainability-gates`. `adf-maintainability-gates` is the
only change archived between the two, so the delta is attributable to it — but note this is a
comparison of two archive-time measurements rather than a before-and-after of one change, which
is a weaker claim than the previous entry's and is stated that way on purpose.

Growth is expected here and is not evidence against the change: this change *added* a gate and a
mandatory delta field, where the previous one only relocated text. A relocation that grows the
surface has failed; an addition that grows it has merely cost what it cost.

**Probation count: 2 of the 5 archived changes the evaluation trigger requires.** The trigger is
a count of changes carrying the figure, not a date.

One thing to check before the next entry: the same report's `## Token Economy` and `## Velocity`
sections came out `(no source)` and `0` for this change, so the figure above accumulated while
the cost data did not. See [[adf-cost-baseline]].
