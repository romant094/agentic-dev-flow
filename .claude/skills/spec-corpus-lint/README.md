# spec-corpus-lint

Reads the whole `openspec/specs/` capability corpus and reports incoherence
between capabilities: contradictions, requirements no capability owns, and
introductory prose that contradicts the requirements below it. Manual
invocation only — never triggered automatically.

## Usage

Invoke by name, with no arguments — it always reads the full corpus as the
working tree holds it:

> Run spec-corpus-lint
> Lint the capability corpus for contradictions

## Output

A report at `.claude-reports/spec-corpus-lint/<YYYY-MM-DD>.md`, with one
section per finding class — contradictions between capabilities,
requirements no capability owns, and introductory prose that contradicts its
own requirements. Each finding names the capability it is about and states a
resolution a reader can act on. A corpus with no findings in a class still
gets that section, saying so.

**This lint reports only. It never blocks a phase, and it returns no
non-zero exit that any command reads.** Findings are input to a future
`/opsx:propose`, resolved by a human decision.

## Invocation

Manual only — never automatically by any `/opsx:*` command or CI job. Run
it every third to fifth archived change, or immediately after a change that
recorded a capability-prose hand edit in its `verify.md`.

## Design

Why this is its own skill (same shape and cadence as `adf-retro`, a
different subject) rather than a section of `adf-retro` or a new gate was
decided as D4 in `openspec/changes/adf-normative-single-source/design.md`
in the origin project. That change directory is not carried here (see
`CLAUDE.md` §3).
