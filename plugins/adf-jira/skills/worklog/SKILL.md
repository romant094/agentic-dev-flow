---
name: worklog
description: Use to fill Jira worklogs for a day or a date range. The method is the developer's own — where the material comes from, where the hours come from, how days are filled, how an entry reads — and it is learned from them and kept in their personal profile layer. On a first run with nothing recorded, the skill asks how they want to work rather than assuming. Triggers on "fill my worklog", "log my hours", "worklog for last week". Triggers may be phrased in any language.
---

# Jira Worklog

This skill does not know how to fill worklogs. It knows how to execute the developer's way
of filling them, how to write entries safely, and how to learn a method it has not been
told yet.

The method lives in `local.md` in the profile directory (`profile.mjs` prints its path), under a
`## Worklog practice` heading. Read that file in full first. It is the specification for the run; this document is only the
mechanics and the discipline.

**The git author comes from `profile.mjs`, not from `local.md`.** When the material is commits,
select them by the `gitAuthor` that

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" --skill worklog
```

prints (`JIRA_GIT_AUTHOR` in the env file). Do not record an author in `local.md`, and ignore
one recorded there before. When `gitAuthor` is null, ask the developer to set
`JIRA_GIT_AUTHOR` (`/adf-jira:setup` asks for it) before reading commits.

Two developers on the same project will legitimately have different practices. One works
from commits, another from a notebook, a third from a timer. One allocates hours agreed with
a client, another logs measured time. None of that is settled here.

## Step 1 — if the practice is not recorded, ask

When `local.md` has no `## Worklog practice` section, or the run hits something it does not
cover, **stop and ask**. Do not choose on the developer's behalf and do not copy another
developer's practice.

Open it plainly: how do they want their worklogs filled? Let them describe it in their own
terms and follow their lead. This is their workflow being formed, not a form being filled.

**Ask only what this run needs.** A questionnaire on the first invocation is the wrong shape
— it front-loads decisions the developer has no reason to have made yet, and most of them
will be answered better by the case that raises them. Get enough to do today's entries,
record it, and let the rest accumulate over later runs.

The topics that eventually need answers, listed so they can be recognized when they come up
rather than asked in a batch:

- **Where the material comes from.** Commits, notes the developer keeps, dictation, an
  export from another tool.
- **Where the hours come from.** An issue's estimate, measured time, a fixed daily figure,
  something else.
- **How a day is composed.** Whether a working day must reach a target, what that target is,
  what happens to a remainder, whether weekends and gaps count.
- **How an entry reads.** Length, tense, whether identifiers appear, how much detail. Record
  this as real examples the developer approves, not as adjectives — an example reproduces,
  an adjective gets reinterpreted.
- **What to do when material and hours disagree**, in both directions.

A run can proceed with only the first three answered. The others can wait for a case.

## Step 2 — if the practice is recorded, follow it

Do what `local.md` says, in the developer's own terms. Where it is silent, Step 1 applies:
ask, record, continue.

Two things to get right while following it:

- **Attribution is never guessed.** However the material arrives, an item that cannot be
  tied to an issue with confidence is a question for the developer, not a judgement call.
  Where the material already names issue keys, take them and confirm the set in aggregate —
  asking about a mapping the developer already wrote is needless friction.
- **Nothing is logged against a number the developer has not seen.** If the practice derives
  hours from something, show the derivation before applying it.

## Step 3 — reconcile, then show

Before building anything, show the arithmetic and the allocation:

```
requested − already logged − excluded = to be applied
```

Then a table: issue, date, hours, the first words of each entry. Corrections are cheap here
and expensive once the plan exists.

For each candidate issue, `timeoriginalestimate` and `timespent` are worth reading and
reporting whatever the practice is — an issue already fully logged usually should not receive
more, and a partially logged one is the common case. Whether that constrains the allocation
is the practice's business, not this document's.

## Step 4 — the mechanics, which are not negotiable

These hold regardless of anyone's method, because they are properties of the API and of the
runner rather than matters of practice.

**One row per entry.** Never put several worklog steps in one row. Per-row state means a row
that fails on its second step is retried from its first on the next run — which posts the
earlier entry a second time. One row per entry makes a duplicate impossible.

**The plan shape:**

```json
{
  "version": 1,
  "operation": "worklog",
  "jql": "<the selection, for the record>",
  "allowlist": ["<PROJECT>"],
  "discoveredAt": "<copied from discovered.json>",
  "rows": [
    {
      "key": "<PROJECT>-586",
      "summary": "8h on 2026-08-20",
      "steps": [
        {
          "worklog": {
            "timeSpent": "8h",
            "started": "2026-08-20T09:00:00.000+0300",
            "comment": "<the entry text>"
          }
        }
      ],
      "state": "pending"
    }
  ]
}
```

**`started` must be `yyyy-MM-dd'T'HH:mm:ss.SSSZ` with a numeric offset and no colon in it**
— `+0300`, not `+03:00`, and not the `Z` that `toISOString()` produces. Jira Server rejects
the other forms or misreads them. Whether the time of day carries meaning is the practice's
business; the format is not.

**`timeSpent` uses Jira duration syntax** — `8h`, `4h 30m`, `1d`. Note that Jira renders `8h`
back as `1d` when the instance is configured at 8h per day; that is display, not a different
value.

**The gate.** Write the plan under `plans.dir` (from `profile.mjs`). `plans.dir` is
`.adf/jira/worklog/` in the main checkout. When `plans.ignored` is false, stop and ask the
developer to run `/adf:init`, or to add `.adf/jira/` to `.gitignore`: `apply-plan.mjs` refuses
a plan git does not ignore. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path>
```

That prints the summary and exits without applying. Apply only after the developer agrees:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path> --confirm
```

**Verify against Jira afterwards**, not against the runner's count. Read each issue's
`timespent` and report it. A run reporting `applied: 3` beside an issue that still shows a
shortfall is exactly the failure worth catching, and the runner cannot catch it itself.

**A re-run is safe.** Rows already `done` are skipped, so finishing a partial run is just
running it again.

## Step 5 — learn, narrowly

Every answer the developer gives to a question this skill could not answer goes into
`local.md` under `## Worklog practice`. Over time that section becomes their own guide, and
the questions stop.

The discipline that keeps it usable:

**Record only what the developer said.** Never record a rule you inferred, generalized or
thought was implied. A file mixing their decisions with your deductions is worse than no
file, because later they cannot be told apart and the developer will trust both.

**Mark where each entry came from**, using the three labels the file defines:

- **stated** — the developer said it. Quote them where the wording matters.
- **derived** — worked out from something they said or wrote, and not contradicted. Usable,
  but say so out loud when it decides an outcome.
- **inferred, unconfirmed** — it came from data or from a default and nobody confirmed it.
  **Ask before letting it decide anything.** Once answered, re-mark it as stated.

Something can only be written as **derived** if you can name what it was derived from, in
the entry. If you cannot, it is inferred, and it is marked that way even when you are
confident. This is what keeps the file's authority honest as it grows: an unmarked rule gets
trusted exactly as much as a decided one.

**Propose your own conclusions — do not enact them.** When a run makes you notice a rule the
developer has not stated, say it out loud as a proposal: what you noticed, what you would
write, and what it would decide. If they agree, record it as **stated** with that date; if
they do not, drop it and do not carry it as an assumption for the rest of the run.

This is the useful half of the discipline. A conclusion you keep to yourself gets applied
anyway, invisibly. A conclusion offered as a proposal either becomes the developer's rule or
disappears — and either outcome is better than an unexamined default.

**Record the case, not only the rule.** Name the situation that produced it — the issue or
epic, the dates, what was ambiguous. A bare rule with no case behind it cannot be applied
safely to a situation that only looks similar.

**Rules go in the file; run data does not.** "Which issue this line belongs to" is data for
one run. "When an item names no issue, ask rather than infer" is a rule. Only the second
belongs in `local.md`; the first would bury it in one-off mappings within a month.

**A new rule that contradicts an old one replaces it.** Show the developer both, ask which
holds, and edit the old entry out. Two contradictory rules side by side make the file
unusable exactly when it matters.

**When a rule nearly fits but not quite, ask.** Do not stretch it. Record the distinction
that was drawn — it is usually worth more than either rule alone.

**Keep the entry-format answers as approved examples.** Beyond reproducing them faithfully,
this is what would make a later comparison across developers possible, if the team ever
decides to converge on one description format. That decision is the team's; this skill does
not make it and promotes nothing to `conventions.md`.

## Step 6 — keep the file small

`local.md` is read in full on every run, so its length is a cost paid every time. It is a
rule list, not a record of the conversations that produced it. Write entries terse from the
start: one or two lines, a label, a date, the case in brackets. Rationale, teaching and
anything addressed to a future maintainer belong in this document, not in the developer's
file.

**Check the size on every run.** Past roughly 60 lines, or when two entries cover the same
topic, propose a sanitising pass. Do not perform one silently — it is the developer's file.

A sanitising pass does four things and nothing else:

1. **Merges entries on one topic** into a single rule, keeping the earliest date and the case
   that best explains it.
2. **Drops the narrative from a settled rule**, keeping the rule and its label. A case earns
   its place while the rule is still ambiguous; once the rule has applied cleanly a few
   times, the story is ballast.
3. **Deletes superseded entries outright.** A rule that was replaced is not history worth
   keeping — it is a second answer to a question that has one.
4. **Moves misfiled content out**: rationale into this document, team-wide agreements into
   `conventions.md` — but only the ones the developer says are team-wide.

Show the result as a before-and-after diff and get approval. **Never drop a rule, only its
supporting narrative**, and never drop an entry whose label is `inferred` — an unconfirmed
rule is precisely the one still needing its case.

If a pass would remove something the developer might still want, leave it and say why. A
file that is slightly too long stays useful; one that lost a rule silently does not.

## What this skill never does

- Assume a method, or carry one developer's practice over to another.
- Log time the developer has not confirmed.
- Guess which issue an item belongs to.
- Put more than one worklog step in a row.
- Write a rule into `local.md` that the developer did not state.
