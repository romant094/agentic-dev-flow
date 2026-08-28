---
name: spec-corpus-lint
description: Read the whole `openspec/specs/` capability corpus and report incoherence between capabilities — contradictions, orphan requirements, and prose that contradicts its own requirements. Manual invocation only, never run automatically by /opsx:propose, /opsx:apply, /opsx:verify, /opsx:archive, or any CI job. Triggers on "run spec-corpus-lint", "lint the capability corpus", "check the specs for contradictions", "проверь корпус спецификаций на противоречия".
---

# Capability Corpus Coherence Lint

## Overview

`openspec/specs/` grows monotonically: each archived change merges its delta
specs in, and the corpus is never read back as a whole by anything else in
the flow. This skill is that missing whole-corpus read. It reports on
coherence — whether the capability set still says one consistent thing — not
on correctness of any single change's implementation (that is
`/opsx:verify`'s and `requesting-code-review`'s job) and not on workflow
token economy or task time (that is `adf-retro`'s job). It shares a cadence
with `adf-retro`, not a subject: `adf-retro`'s input is a session transcript
and its question is how one execution went; this skill's input is
`openspec/specs/` as a whole and its question is whether the corpus is
coherent.

This skill is invoked manually only. It is never hooked into
`/opsx:propose`, `/opsx:apply`, `/opsx:verify`, `/opsx:archive`, or any CI
job.

**This lint reports only. It never blocks a phase, and it returns no
non-zero exit that any command reads.** Its findings are input to a future
`/opsx:propose`, resolved by a human decision, never by a failing exit code.

## Arguments

None. The lint always reads the full corpus as it stands in the current
working tree — there is no partial-corpus or single-capability invocation.

## Steps

**1. Enumerate the corpus**

```bash
find openspec/specs -mindepth 2 -maxdepth 2 -name spec.md | sort
```

Each result is one capability's `spec.md`. Read every one of them in full —
this lint's whole premise is a read of the corpus as a whole, so no
capability is sampled or skipped for size.

**2. Read each capability for three things**

For each `spec.md`:

- The introductory prose above its `## Requirements` heading.
- Every `### Requirement:` heading below it, with its body and scenarios.
- The subject(s) each requirement governs (a command, a file, a check, a
  phase, an agent behavior) — this is what makes cross-capability
  contradiction detection possible in the next step.

**3. Cross-reference across capabilities for three finding classes**

- **Contradictions between capabilities**: two capabilities require
  incompatible behavior of the same subject (e.g. one requires a check to
  block a phase, another requires the same check to never block a phase).
  Report both capabilities and the incompatible requirements, quoted.
- **Requirements no capability owns**: a rule referenced as binding by one
  capability's prose or by a flow-defining file (`.claude/CLAUDE.md` §5,
  `openspec/schemas/sdd-plus-superpowers/schema.yaml`, `.claude/commands/
  opsx/*.md`) that no `### Requirement:` heading in any `spec.md` actually
  states. Report the rule as referenced, where it was referenced from, and
  that no capability owns it.
- **Introductory prose that contradicts the requirements below it**: a
  capability's prose above `## Requirements` describes behavior its own
  requirements no longer specify (typically stale prose left behind after a
  requirement was reworded or removed by a later delta merge). Report the
  capability, the contradicting prose sentence, and the requirement it now
  disagrees with.

A capability with none of the three findings is not mentioned in the report
— the report lists findings, not a clean bill of health per capability.

**4. Write the report**

Write to `.claude-reports/spec-corpus-lint/<YYYY-MM-DD>.md`:

```markdown
# Capability Corpus Coherence Lint — <YYYY-MM-DD>

**Capabilities read:** <count>

## Contradictions between capabilities

<one subsection per finding, or "None found.">

### <Capability A> vs. <Capability B>
- **Subject:** <what both requirements govern>
- **Capability A requirement:** <quoted requirement text>
- **Capability B requirement:** <quoted requirement text>
- **Resolution:** <what a reader would need to decide or edit to resolve this>

## Requirements no capability owns

<one subsection per finding, or "None found.">

### <the referenced rule, one sentence>
- **Referenced from:** <file and location>
- **Resolution:** <which capability should state it, or that a new capability is needed>

## Introductory prose contradicting its requirements

<one subsection per finding, or "None found.">

### <Capability>
- **Prose:** <quoted sentence above `## Requirements`>
- **Contradicts:** <quoted requirement text, or "requirement removed">
- **Resolution:** <what edit to the prose would resolve this>

## Summary

<2-3 sentences: total findings, whether any is severe enough to warrant an
immediate `/opsx:propose` rather than waiting for the next cadence window>
```

Every finding names the capability it is about and states a resolution a
reader can act on — a finding with no named capability or no resolution is
not actionable and does not belong in the report.

## When to run this

Nothing invokes this skill automatically — stating these triggers does not
change that; a developer still has to ask for it by name. Run it:

- Every third to fifth archived change. Fewer data points cannot separate
  drift from an isolated one-off.
- Immediately after a change that recorded a capability-prose edit in its
  `verify.md` (per `.claude/CLAUDE.md` §5's hand-edit exception) — that edit
  is the event most likely to have created the incoherence this lint exists
  to detect.

## Rules

- Never invoked automatically by any `/opsx:*` command or CI job.
- **Never blocks.** This lint MUST NOT gate `/opsx:verify`, `/opsx:archive`,
  or any other phase, and it returns no non-zero exit that any command
  reads — its findings are acted on by a human decision, through a future
  `/opsx:propose`, never by a failing exit code.
- Never fabricate a finding — a coherent corpus gets a report saying so, per
  class.
- Never act on a finding in the same run that produced it. Fixing a
  contradiction or editing capability prose is out of this skill's scope —
  `openspec/specs/` is written only by `/opsx:archive`, with the one
  hand-edit exception `.claude/CLAUDE.md` §5 already states.
- Report output only ever goes to `.claude-reports/spec-corpus-lint/` — never
  to `openspec/specs/`, never to the repository root.
