---
name: flow-retro
description: Analyze a past Claude Code session's execution of the opsx (OpenSpec + Superpowers) change workflow for token economy and total task time. Manual invocation only, by session ID — never triggered automatically by /opsx:propose, /opsx:apply, /opsx:verify, or /opsx:archive. Triggers on "run flow-retro on session <id>", "how efficient was session <id>", "analyze this session's workflow efficiency".
---

# Flow Retrospective

## Overview

Given a Claude Code session ID, report on how efficiently that session ran
this repository's `/opsx:*` change workflow — token economy and total task
time, not code correctness (that is `requesting-code-review`'s and
`/opsx:verify`'s job). Looks for: issues caught later in the pipeline than
they could have been, a subagent re-deriving context an earlier stage
already had, and premature "done" signaling followed by more fix commits.

This skill is invoked manually only. It is never hooked into
`/opsx:propose`, `/opsx:apply`, `/opsx:verify`, or `/opsx:archive`.

## Arguments

- Required: a session ID, e.g. `a95c1a5e-b67f-41d6-84d2-3e80e69283fe`.
- Optional: a change name, e.g. `change=i18n-hardcoded-strings`. If omitted,
  infer it from the change directories touched by commits made during the
  session's time window (see Step 3).

## Steps

**1. Locate the session transcript**

Derive the project key from the repository's absolute path the same way the
`session-list` skill does — replace `/` with `-`, strip the leading `-`:

```bash
PROJECT_KEY=$(git rev-parse --show-toplevel | sed 's|/|-|g')
TRANSCRIPT="$HOME/.claude/projects/$PROJECT_KEY/<session-id>.jsonl"
ls "$TRANSCRIPT" 2>&1
```

If the file does not exist, report that the session was not found under
this project's directory and stop — do not fabricate an analysis. (A
session run from a different working directory would key under a different
`PROJECT_KEY`; if the developer says the session belongs to this project but
it isn't found here, say so rather than guessing at another key.)

**2. Re-read the current opsx workflow shape**

Before analyzing, re-read these six files fresh — do not rely on a cached
description of what the workflow currently checks, since it has drifted
from its own documentation before (see
`.claude/memory/concepts/opsx-workflow.md`, "Adding a verify check means
touching three files, not one"):

- `openspec/schemas/sdd-plus-superpowers/schema.yaml`
- `.claude/commands/opsx/propose.md`
- `.claude/commands/opsx/apply.md`
- `.claude/commands/opsx/verify.md`
- `.claude/commands/opsx/review.md`
- `.claude/commands/opsx/archive.md`

The workflow's stable shape does not need re-deriving every time: five
commands (`propose`, `apply`, `verify`, `review`, `archive`), eight artifacts
(`brainstorm`, `design`, `proposal`, `specs`, `tasks`, `plan`, `verify`,
`review`), one branch and worktree per change. What changes over time — the exact
number and content of verify's numbered checks, the shift-left checks this
change adds — is what the fresh read is for.

**3. Identify the change(s) worked on in this session**

```bash
python3 -c "
import json
with open('$TRANSCRIPT') as f:
    for line in f:
        pass  # scan for tool_use blocks referencing openspec/changes/<name>/
"
```
Extract every `openspec/changes/<name>/` path referenced anywhere in the
transcript's tool calls or tool results. If the developer supplied
`change=<name>`, use that and cross-check it appears in the transcript; if
it does not, say so as a discrepancy rather than silently trusting either
source alone.

If the transcript file exists but cannot be parsed as expected (e.g. the
JSON structure of tool-use blocks has changed), degrade instead of failing:
identify the change(s) from git history alone — commits made during the
session's time window, inferred from the transcript's first/last line
timestamps, or from a developer-supplied `change=<name>` — and note in the
report that transcript-based analysis was degraded.

**4. Cross-reference git history and `verify.md`**

```bash
git log --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M' -- "openspec/changes/<name>"
```

Read the change's `verify.md` if it exists, and its `brainstorm.md` /
`design.md` / `proposal.md` / `tasks.md` / `plan.md` for what was intended.

**5. Analyze for token-economy and task-time findings**

For the session's activity on this change, look specifically for:

- **Late-caught issues**: a fix, correction, or "actually X was wrong" commit
  that came after an earlier commit or message signaled the work as done or
  complete. Name the round trip and where in the pipeline it could have
  been caught instead (propose-time validation, plan-authoring risk check,
  apply-time test run — the shift-left checks this repository's workflow
  has been building toward, if `schema.yaml`/`propose.md`/`apply.md` show
  them present at the time of this session).
- **Redundant context re-derivation**: a subagent or a later stage
  re-exploring/re-reading files or history that an earlier stage in the
  same session already read and reported on.
- **Premature "done" signaling**: a tracker update, commit message, or
  status report claiming completion before `/opsx:verify` (or equivalent)
  actually passed.

If none of these are present, say so plainly — do not manufacture a finding
to fill the report.

**6. Write the report**

Write to `.claude-reports/flow-retro/<session-id>.md`:

```markdown
# Flow Retrospective — <session-id>

**Change(s) analyzed:** <name(s)>
**Session time window:** <first timestamp> – <last timestamp>

## Findings

<one subsection per finding, or "No efficiency issues found" if none>

### <Finding title>
- **What happened:** <concrete evidence — commit SHAs, message excerpts>
- **Cost:** <what extra round trip / re-derivation / tokens this caused>
- **Where it could have been caught instead:** <pipeline stage>

## Summary

<2-3 sentences>
```

## Rules

- Never invoked automatically by any `/opsx:*` command.
- Never fabricate a finding — an efficient session gets a report saying so.
- Always re-read the five workflow-shape files listed in Step 2 fresh; never
  trust a memorized description of "the current checks."
- Report output only ever goes to `.claude-reports/flow-retro/` (CLAUDE.md
  §2) — never to the change's own directory, never to the repository root.
