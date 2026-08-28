# Memory Index

Catalog of the pages under `concepts/` and `entities/`, one line each. Read this first for
any query, then read only the pages it points at. Every new page gets a line here — a page
missing from this index is a page nobody will find.

See `CLAUDE.md` §1 for the ingest, query, task and lint workflows that maintain this
directory.

## Flow

- [concepts/opsx-workflow.md](concepts/opsx-workflow.md) — why the OpenSpec + Superpowers
  change workflow is shaped the way it is: the reasoning, the incidents behind each guard,
  and the decisions that were tried and dropped. Read alongside the historical flow specs
  under `docs/flow-specs/`.
- [concepts/normative-surface-map.md](concepts/normative-surface-map.md) — the four surfaces a
  flow rule can live on, which one owns a given rule, and the traps the relocation left behind.
- [concepts/normative-surface-size-metric.md](concepts/normative-surface-size-metric.md) — the
  per-phase normative-byte metric in `adf-metrics.mjs`, on probation, and the baseline error
  that made its number wrong twice.
- [concepts/code-reuse-sweep.md](concepts/code-reuse-sweep.md) — the flow's one gate with
  repository read access: what it asks, its verdict shape, and the one maintainability class
  that blocks apply.
- [concepts/adf-deferred-findings.md](concepts/adf-deferred-findings.md) — open findings from
  the flow's own changes: defects, deferred wordings and recorded decisions not yet proposed
  as follow-up work.
- [concepts/adf-cost-baseline.md](concepts/adf-cost-baseline.md) — the end-to-end token/time
  measurements of this workflow, and the pitfalls that made two of the three runs unreliable.

## Concepts

<Patterns, protocols, workflows, decisions. One line per page.>

## Entities

<Modules, components, classes, services. One line per page.>
