---
name: task
description: Use to create one Jira issue from a description — a task, a bug, a story — with the fields its type actually requires, optionally attached to an epic. Drafts the text, shows it, and creates it only after confirmation. Also drafts without creating, for when the wording needs agreeing first or there is no token. Triggers on "create a task", "raise a bug", "new issue for this". Triggers may be phrased in any language.
---

# Jira Task

Creates a single issue. For an epic with its children, use `/adf-jira:epic`.

Read `conventions.md` in the profile directory first: which fields the team fills even where
Jira treats them as optional, and how the work is organized, are recorded there.

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs"
```

`discovered.json` must exist and be fresh; the required fields per issue type come from it,
not from memory. Missing → send the developer to `/adf-jira:setup`. `profile.stale` true →
offer to refresh, since `apply-plan.mjs` refuses a stale plan anyway.

## Step 1 — draft the issue

Write the summary and description from what the developer described. Show the draft before
building anything: wording is cheap to fix now and awkward to fix in Jira.

Keep the summary a single line that states the outcome, not the activity. The description
carries the detail.

## Step 2 — the fields the type requires

Read the type's `requiredFields` from `discovered.json`, and each custom field's name from the
`fieldMap` (the map is name → id). They differ by type, and some surprise people:

| Type | Often required beyond summary, issuetype, reporter, project |
|---|---|
| Epic | `Epic Name` — a second title field, easy to miss |
| Sub-task | `parent` — the key of the issue it hangs off |
| Bug | the project's reproduction fields, such as reproduce steps and the expected result |

The profile is the authority; the table only says where to look. A type with a required
field nobody supplies fails with 400. For a bug, ask for the reproduction rather than
inventing it — a fabricated reproduction is worse than an empty field, because someone will
follow it.

**Attaching to an epic** follows the model `conventions.md` records: a `Sub-task` whose
`parent` is the epic's key, or a standard issue whose `Epic Link` field holds it. Verify the
target really is an `Epic` before setting `parent`: it accepts any standard issue, so a wrong
key produces a valid sub-task under the wrong parent, whose time then rolls up where nobody is
looking.

An issue that belongs to no epic is an ordinary `Task` with no `parent`. Not every issue
needs one.

**Never invent a value for a required field.** If the developer has not supplied it and it
cannot be read from the profile, ask.

## Step 3 — draft-only mode

When the developer wants the text without creating anything — the wording needs agreeing,
or there is no token yet — stop after Step 1 and hand over the draft. Say plainly that
nothing was created. This is a legitimate outcome, not a failure.

## Step 4 — build the plan, gate it, apply

A create row has no issue key until Jira assigns one, so the row carries `key: "(new)"` and
an explicit `project` — the allowlist gate reads that instead of parsing a key that does not
exist yet.

```json
{
  "version": 1,
  "operation": "create",
  "allowlist": ["<PROJECT>"],
  "discoveredAt": "<copied from discovered.json>",
  "rows": [
    {
      "key": "(new)",
      "project": "<PROJECT>",
      "summary": "<the summary, so the gate is readable>",
      "steps": [
        {
          "create": {
            "fields": {
              "project": { "key": "<PROJECT>" },
              "issuetype": { "name": "Task" },
              "summary": "<the summary>",
              "description": "<the description>",
              "reporter": { "name": "<JIRA_ASSIGNEE>" },
              "assignee": { "name": "<JIRA_ASSIGNEE>" },
              "parent": { "key": "<parent key — Sub-task only, omit otherwise>" }
            }
          }
        }
      ],
      "state": "pending"
    }
  ]
}
```

The row above creates a `Task`. For a child of an epic in the sub-task model, set `issuetype`
to `Sub-task` and keep `parent`; for a standalone issue, drop `parent` entirely — it is
rejected on a type that is not a sub-task. `<JIRA_ASSIGNEE>` is a placeholder the apply
process resolves from the env file; never read that file for it.

Write it under `plans.dir`, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path>
```

That prints the summary — issue type, project, and every field the new issue will carry —
and exits without creating. Apply only after the developer agrees:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path> --confirm
```

## Step 5 — report the key

The runner writes the key Jira assigned into the row as `createdKey`. Report it, and read
the issue back to confirm what actually landed: type, status, assignee, and `parent` if one
was set. For a sub-task, also read the epic's `aggregatetimeoriginalestimate` — a sub-task
that landed under the wrong parent looks entirely healthy on its own page, and the epic's
rollup is where that shows up.

The new issue starts in the workflow's initial status. Moving it on is `/adf-jira:bulk`.

## What this skill never does

- Invent a value for a required field, including a bug's reproduction.
- Hardcode a custom field id instead of reading the field map.
- Set `parent` to a key it has not confirmed is the intended parent.
- Attach to an epic by a model other than the one `conventions.md` records.
- Convert an existing issue into a sub-task: REST cannot do it.
- Create anything in draft-only mode.
- Delete an issue. The account may hold the permission; nothing here exposes it.
