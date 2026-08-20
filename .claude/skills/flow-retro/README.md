# flow-retro

Analyzes a past Claude Code session's execution of this repository's
`/opsx:*` change workflow for token economy and total task time. Manual
invocation only, by session ID — never triggered automatically.

## Usage

Invoke with a session ID, optionally a change name:

> Run flow-retro on session `a95c1a5e-b67f-41d6-84d2-3e80e69283fe`

## Output

A report at `.claude-reports/flow-retro/<session-id>.md`, focused on
late-caught issues, redundant context re-derivation, and premature "done"
signaling — not code correctness (see `requesting-code-review` and
`/opsx:verify` for that).

## Design

See `openspec/changes/flow-shift-left-and-retro/design.md` for the
rationale behind the skill's session-ID-driven, manually-invoked, and
workflow-re-reading design choices.
