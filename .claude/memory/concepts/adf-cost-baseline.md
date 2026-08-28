# ADF Cost Baseline

The only end-to-end measurement of this repository's `/opsx:*` change workflow, and the number
every later flow change is compared against.

**Why this page exists at all.** The measurement lives in
`.claude-reports/adf-retro/32e5e759-d949-4fa9-8f04-d88f06c9a8d2.md` and its companion
`-improvements.md`, and `.claude-reports/` is **gitignored** (`.gitignore:53`). Those files exist on
one developer's machine and are in no commit. This page is the tracked copy of the figures the flow
now reasons from — if the reports are lost, the baseline is not.

## What was measured

Session `32e5e759-d949-4fa9-8f04-d88f06c9a8d2`, change `fix-ip-advanced-dynamic-forms-defects`
(archived `2026-08-21`). 22-task apply — 18 planned plus 4 ad hoc. Transcript 6 181 lines, 1 922
main-loop assistant turns, 61 subagents (54 at depth 1, 7 at depth 2) spread across three
capability tiers.

## By phase

| Phase | Output tokens | Cache reads |
|---|---:|---:|
| QA triage + manual UI pass | 153 k | 49 M |
| `/opsx:propose` (brainstorm → plan) | 264 k | 45 M |
| `/opsx:apply` | **2 336 k** | **890 M** |
| `/opsx:verify` | 82 k | 67 M |
| `/opsx:review` (3 rounds) | 147 k | 61 M |
| `/opsx:archive` | 36 k | 32 M |
| **Total** | **3 018 k** | **1 142 M** |

Apply is **77 %** of the output tokens and **78 %** of the cache reads. The review gate — the
obvious suspect before the measurement — cost 9 %.

## By actor

| Actor | Dispatches | Output tokens | Context read | Peak context |
|---|---:|---:|---:|---:|
| Main loop (orchestrator) | — | **1 543 k (51 %)** | **742 M (64 %)** | 769 k |
| Implementers + fixers | 38 | 1 151 k | 345 M | 336 k |
| Reviewers (per-task, re-review, branch-wide, AI review) | 16 | 260 k | — | — |
| Depth-2 lookups | 7 | 64 k | 12 M | — |

**The orchestrator is the most expensive participant and writes no production code.** Average
context on the main loop was 386 k, peak 769 k, with 295 direct `grep`/`sed`/`cat` calls and a
`/compact` between tasks 15 and 16, requested by the developer. Implementer median context was
~100 k.

Three dispatches dominated: Task 12 (168 k output, 180 tool calls, 68 min), Task 15 (101 k, 150
calls), Task 16 (90 k, 120 calls plus a fix round and two re-reviews — ≈189 k for one checkbox).

## Velocity

| Metric | Value |
|---|---|
| Active session time (gaps ≤ 15 min counted) | 14.4 h of a 45.1 h span |
| Sum of subagent wall time | 10.2 h → **average concurrency ≈ 0.7**, peak 5 |
| Output tokens per active hour | ≈ 210 k |
| Output tokens per commit (67 commits) | ≈ 45 k |
| Output tokens per inserted line (9 287 insertions) | ≈ 325 |

The concurrency figure is the finding, not the ratio: the cap is 2–3, and
`parallel-group-execution` had already specified wave fan-out. It produced nothing in this session
and nothing caught that.

## Why the numbers are trusted, and their limit

They were extracted from the session transcript by hand, once, by an agent that was not required to
produce them — the skill's mandated report format was `## Findings` and `## Summary` only. So they
are real but **n = 1**, and no comparison point exists. Any forecast built on them is a hypothesis:
that is the stated reason the proposed `adf-flow-improvements` puts the deterministic metrics
extractor first in its execution order, so the next change is measured rather than estimated.

## Related

- [OpenSpec + Superpowers Workflow](opsx-workflow.md) — why the flow is shaped as it is, including
  what the retrospective reads and what it cannot.
- `infra/claude/review-prompt.md` — the review prompt's severity model and what it
  structurally cannot find.
- [Normative Surface Size](normative-surface-size-metric.md) — the fourth indicator in the same
  `adf-metrics.mjs` report, added by `adf-normative-single-source`. It is **on probation** rather
  than accepted: it sums both normative surfaces, so a relocation nets zero by construction, and it
  overlaps `## Token Economy` and `## Maintainability` while measuring worse than both. The page
  also carries the baseline error that made its number wrong twice — the transferable lesson for
  every figure on this page: **state the baseline revision next to the number, and check that it
  precedes the change's first commit.**
- [ADF Deferred Findings](adf-deferred-findings.md) — the open findings in `adf-metrics.mjs` itself
  (five, none blocking), and what a follow-up change would have to take on.

## Second measurement — `adf-flow-improvements`, 2026-08-26

The first measurement was produced by hand, by an agent reading a transcript. This one came from
`.claude/scripts/adf-metrics.mjs`, run from `/opsx:archive`, and every figure was reproduced by an
independent one-liner over the same transcript before being recorded here.

| Actor | Output tokens | Total tokens | Context reads |
|---|---|---|---|
| orchestrator | 795 720 | 165 116 575 (mostly cache read) | 196 |
| subagents | no source | 2 496 811 | no source |

- Dispatches completed: **30**, measured from harness notifications rather than from the ledger's
  hand-written lines.
- Tool uses across measured dispatches: **864**.
- Subagent wall clock, summed: **172 minutes**. Average per dispatch: **5.7 minutes**.
- Session span: **570 minutes** — one session did propose, apply, verify, review and archive.
- Wave-1 fan-out: declared 3 groups, **performed no** — a true positive, recorded as a deviation.

Two figures are deliberately absent rather than zero. The harness reports `subagent_tokens` as a
total and does not split it, so the subagents' output/input/cache cells read `(no source)`. A `0`
there would be a fabricated measurement, which is the one thing this layer exists not to do.

**Comparison with `32e5e759` is limited to the orchestrator.** The first measurement's headline was
that the orchestrator took 51 % of output tokens; that ratio cannot be recomputed here, because
subagent *output* is not separable from subagent *total* in the harness's own data. What is
comparable is the absolute figure: 795 720 orchestrator output tokens across 570 minutes and 30
dispatches. Whether the context-discipline rules this change installed reduced that share is not
answerable from two points, and the second point was itself produced by a session that was
building the instrument — atypically expensive by construction.

The cache-read figure, 160 848 933, is worth stating plainly because it dwarfs everything else and
is easy to misread as waste. It is the cost of a long single session re-reading its own context on
every turn, which is what the handoff threshold this change introduced exists to bound.

## Third run — `adf-maintainability-gates`, 2026-08-27: the extractor produced no cost data

`adf-metrics.mjs --change adf-maintainability-gates` ran at archive, as the flow requires, and
wrote its report. The maintainability and normative-byte sections computed fine. The two sections
this page exists for did not:

- `## Token Economy` — every cell `(no source)` for both the orchestrator and the subagents rows.
- `## Velocity` — session count 0, measured windows 0, total minutes 0.
- `## Dispatches` — completed dispatches `(no source)`.

So the third iteration of this flow contributed **nothing** to the cost dataset, and did so
silently: the report was written, the archive step reported success, and only reading the report
shows the columns are empty. The measured session that produced this page's first entry was
found by hand-reading a transcript; the second was script-produced; the third produced a
well-formed report with no numbers in it.

Worth knowing before the next retrospective: a `-metrics.md` file existing is not evidence that
cost was measured. Check for `(no source)` before treating a report as a data point. Why the
transcript was not found was not diagnosed at archive time — that is the first question for
whoever next touches `adf-metrics.mjs`, and it is filed on [[adf-deferred-findings]].
