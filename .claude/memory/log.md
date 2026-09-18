# Log

> Rotated monthly. Entries older than the current month live in `.claude/memory/log-archive/YYYY-MM.md`. New entries prepend directly below this note.

## [2026-09-18 11:17] ingest | Ported the deferred-findings-ledger change from the origin project | Anton Romankov
- Carried the origin project's archived `deferred-findings-ledger` change into this repository:
  the review record now keeps the body of a finding that was neither fixed nor dismissed, and
  archive carries it, plus every unresolved apply-ledger `## Debt` line, into a technical debt
  ledger. Five surfaces took the change unmodified (`schema.yaml`'s `review` instruction and
  `archive` block, `templates/review.md`, `commands/opsx/review.md` and `archive.md`,
  `skills/ai-code-review/SKILL.md`), which is why the port is byte-identical to the origin
  there — those files had not drifted.
- New capability document `docs/flow-specs/technical-debt-ledger/spec.md`; `ai-review-flow-stage`
  and `apply-execution-ledger` took the narrowing and the named destination. The capability count
  went from fourteen to fifteen in README.md, `.claude/CLAUDE.md` §3 and the flow-specs README.
- `.claude/memory/tech-debt/` ships as a **scaffold**: the entry format and the block layout,
  with an empty Blocks table. The origin project's eight domain blocks and 94 entries are its
  own and were deliberately not carried. The change's own artifacts were not carried either —
  `openspec/changes/archive/` here belongs to the host project.
- Genericized against this repository's conventions: the `Jira` column is `Tracker`, the origin's
  package paths and file names are described rather than named, and the concept page keeps the
  reasoning without the migration's numbers.
- The tech-debt half was agreed with the session holding `chore/tech-debt-jira-sync` in the
  origin project before it was written. Two format changes visible in that session's history —
  several rows sharing one tracker key, and a marker for "deliberately never mirrored" — were
  proposals that got **rejected** there, so this port carries neither. What came back as new is
  in `concepts/technical-debt-ledger.md`: one key per row, and the empty-cell rule holding only
  while every open entry is mirrorable work.
