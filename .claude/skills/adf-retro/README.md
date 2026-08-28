# adf-retro

Analyzes a change's execution of this repository's `/opsx:*` change
workflow — across every session that touched it — for token economy and
total task time. Manual invocation only, by change name or by a single
session ID — never triggered automatically.

## Usage

Invoke with a change name, to cover every session on its ledger, or with a
single session ID:

> Run adf-retro on change `i18n-hardcoded-strings`
> Run adf-retro on session `a95c1a5e-b67f-41d6-84d2-3e80e69283fe`

## Output

A report at `.claude-reports/adf-retro/<change-name-or-session-id>.md`,
with a token economy table, a velocity table, and findings on late-caught
issues, redundant context re-derivation, and premature "done" signaling —
not code correctness (see `requesting-code-review` and `/opsx:verify` for
that). Every number in the report comes from
`.claude/scripts/adf-metrics.mjs`, run first if no metrics output exists
yet, never from the skill reading transcripts in its own context.

Alongside the report, a companion
`.claude-reports/adf-retro/<change-name-or-session-id>-improvements.md`
names what to change, in which file, and the expected effect, ordered by
expected saving — required on every run, even one with nothing to change.

## Invocation

This skill is invoked manually only — never automatically by any `/opsx:*`
command. Run it every third to fifth archived change, or immediately after a
change that hurt (blocked tasks, repeated review rounds, or discovered
defects). Every retrospective names one workflow rule or check as a removal
candidate, with the incident it prevented, or states that none qualifies.

## Design

The rationale behind the skill's session-ID-driven, manually-invoked and
workflow-re-reading design choices was recorded in
`openspec/changes/flow-shift-left-and-retro/design.md` in the origin
project. That change directory is not carried here (see `CLAUDE.md` §3).
