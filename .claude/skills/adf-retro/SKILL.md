---
name: adf-retro
description: Analyze a past Claude Code session's execution of the opsx (OpenSpec + Superpowers) change workflow for token economy and total task time. Manual invocation only, by change name or by session ID — never triggered automatically by /opsx:propose, /opsx:apply, /opsx:verify, or /opsx:archive. Triggers on "run adf-retro on session <id>", "run adf-retro on change <name>", "how efficient was session <id>", "analyze this session's workflow efficiency".
---

# Flow Retrospective

## Overview

Given either a change name or a single Claude Code session ID, report on how
efficiently the session(s) involved ran this repository's `/opsx:*` change
workflow — token economy and total task time, not code correctness (that is
`requesting-code-review`'s and `/opsx:verify`'s job). Looks for: issues
caught later in the pipeline than they could have been, a subagent
re-deriving context an earlier stage already had, and premature "done"
signaling followed by more fix commits.

This skill is invoked manually only. It is never hooked into
`/opsx:propose`, `/opsx:apply`, `/opsx:verify`, or `/opsx:archive`.

## Arguments

- Either a change name, e.g. `change-name=i18n-hardcoded-strings`, or a
  single session ID, e.g. `a95c1a5e-b67f-41d6-84d2-3e80e69283fe`. One of the
  two is required.
- **Change name.** Read the change's ledger, `.superpowers/sdd/<change-name>/
  progress.md`, and its `## Sessions` list (one line per session, formatted
  `<session-id> | <window> | <phase>`) for every session that touched the
  change. If the change has already been archived, that ledger path no
  longer exists — read the durable half `/opsx:archive` preserved instead,
  at `openspec/changes/archive/<date>-<change-name>/ledger.md`, whose
  `## Sessions` list has the same format.
- **Session ID.** A single session ID stays valid exactly as before; the
  change it belongs to is inferred from the change directories touched by
  commits made during the session's time window (see Step 3).
- A session named in a `## Sessions` list whose transcript cannot be
  resolved (moved, pruned, recorded from a different machine) is named as
  unresolved in the report rather than silently dropped. The report never
  presents the resolved subset of sessions as if it were the whole list.

## Steps

**1. Resolve the session ID(s) and locate each transcript**

- Invoked with a session ID: that ID is the sole session to analyze.
- Invoked with a change name: every `<session-id>` on the ledger's (or
  preserved `ledger.md`'s) `## Sessions` list is a session to analyze.

Derive the project key from the repository's absolute path the same way the
`session-list` skill does — replace `/` with `-`, strip the leading `-`:

```bash
PROJECT_KEY=$(git rev-parse --show-toplevel | sed 's|/|-|g')
TRANSCRIPT="$HOME/.claude/projects/$PROJECT_KEY/<session-id>.jsonl"
ls "$TRANSCRIPT" 2>&1
```

Do this for each session ID from above. If invoked with a single explicit
session ID and its transcript does not exist, report that the session was
not found under this project's directory and stop — do not fabricate an
analysis. If invoked with a change name, a missing transcript for one of
several sessions does not stop the run: name that session as unresolved in
the report and continue with the rest. (A session run from a different
working directory would key under a different `PROJECT_KEY`; if the
developer says a session belongs to this project but it isn't found here,
say so rather than guessing at another key.)

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

If invoked with a change name, that name is already the change — skip the
inference below for that session and go straight to Step 4.

```bash
python3 -c "
import json
with open('$TRANSCRIPT') as f:
    for line in f:
        pass  # scan for tool_use blocks referencing openspec/changes/<name>/
"
```
Extract every `openspec/changes/<name>/` path referenced anywhere in the
transcript's tool calls or tool results.

If the transcript file exists but cannot be parsed as expected (e.g. the
JSON structure of tool-use blocks has changed), degrade instead of failing:
identify the change(s) from git history alone — commits made during the
session's time window, inferred from the transcript's first/last line
timestamps, or from a developer-supplied `change-name=<name>` — and note in
the report that transcript-based analysis was degraded.

**4. Cross-reference git history, `verify.md`, and the ledger**

```bash
git log --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M' -- "openspec/changes/<name>"
```

Read the change's `verify.md` if it exists, and its `brainstorm.md` /
`design.md` / `proposal.md` / `tasks.md` / `plan.md` for what was intended.

Read the ledger as a second input alongside the transcript: `## Dispatches`
and `## Deviations` for what each task actually cost and where the plan and
the execution diverged. The transcript outranks the ledger — where the two
disagree about a number, the transcript is the fact — and any such
disagreement is itself reported, not silently resolved in the transcript's
favor.

**5. Run the metrics extractor**

```bash
node .claude/scripts/adf-metrics.mjs --change <change-name>
```

Every number that appears in the report — token counts, dispatch counts,
elapsed time, anything quantitative — comes from this script's output, never
from the skill reading transcripts and computing a figure in its own
context: a script cannot fabricate a number and cannot inflate the context
it is measuring, and an agent doing the same arithmetic by eye can do both.
If no metrics output exists yet for this change, run the extractor first;
do not proceed to Step 6 on numbers the skill derived itself.

**6. Analyze for token-economy and task-time findings**

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

**7. Write the report and its companion improvements file**

Write to `.claude-reports/adf-retro/<change-name-or-session-id>.md` — the
change name when one was resolved (Step 3), otherwise the single session ID
this run was invoked with:

```markdown
# Flow Retrospective — <change-name-or-session-id>

**Change(s) analyzed:** <name(s)>
**Sessions:** <session-id> | <window> | <phase> (one line per session; mark
  any unresolved session as `unresolved` in place of its window/phase)

## Token economy

| Actor | Input tokens | Output tokens | Cache read | Cache write |
|---|---|---|---|---|
| <orchestrator, or each subagent/task> | ... | ... | ... | ... |

## Velocity

| Task / group | Wall time | Dispatches | Review rounds |
|---|---|---|---|

## Findings

<one subsection per finding, or "No efficiency issues found" if none>

### <Finding title>
- **What happened:** <concrete evidence — commit SHAs, message excerpts>
- **Cost:** <what extra round trip / re-derivation / tokens this caused>
- **Where it could have been caught instead:** <pipeline stage>

## Summary

<2-3 sentences>
```

Every figure in the two tables above is taken verbatim from Step 5's
`adf-metrics.mjs` output — this report never recomputes them.

Alongside the report, write a companion
`.claude-reports/adf-retro/<change-name-or-session-id>-improvements.md`,
ordered by expected saving, highest first:

```markdown
# Flow Retrospective Improvements — <change-name-or-session-id>

1. **<what to change>** — in `<file>`. Expected effect: <what improves and
   by roughly how much, or "unquantified" if the metrics don't support a
   number>.
```

The companion file is required on every run, exactly like the report
itself: a session with nothing worth changing still gets an improvements
file, one that says plainly there is nothing to change rather than being
omitted. This extends the no-fabrication rule in `## Rules` below —
absence of a finding is itself reported, never silently skipped.

## When to run this

Nothing invokes this skill automatically — stating these triggers does not
change that; a developer still has to ask for it by name. Run it:

- Every third to fifth archived change. Fewer data points cannot separate a
  trend from noise.
- Immediately after a change that hurt: a task group left `BLOCKED`, a
  review that reached the three-round cap, a compaction inside apply, or a
  defect found by hardware or by the developer rather than by the pipeline.

## Rules

- Never invoked automatically by any `/opsx:*` command.
- Never fabricate a finding — an efficient session gets a report saying so.
- Always re-read the five workflow-shape files listed in Step 2 fresh; never
  trust a memorized description of "the current checks."
- Report output only ever goes to `.claude-reports/adf-retro/` — never to
  the change's own directory, never to the repository root.
- Every retrospective names one rule or check as a removal candidate, with
  the incident it last prevented, or states that none qualifies. A check
  whose `meta.lastFired` (see `.claude/scripts/adf-regression/index.mjs`) is
  null across several changes is saturated, and saturation is the signal —
  a check that never fires is either preventing nothing or preventing
  something nobody has attempted in a long time, and only the incident
  history tells those apart.
- The handoff threshold (`openspec/schemas/sdd-plus-superpowers/schema.yaml`'s
  `apply` instruction, "observable proxies" for pausing instead of compacting
  mid-apply) is the first removal candidate a retrospective should propose, if
  it proves not load-bearing for the current model generation.
