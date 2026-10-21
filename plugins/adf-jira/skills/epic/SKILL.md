---
name: epic
description: Use to create an epic and decompose it into sub-tasks with estimates, or to add sub-tasks to an epic that already exists. Proposes the decomposition and the estimates for the developer to confirm, and reports the epic's rollup — estimated, logged, and the gap — read from Jira's own Σ fields. Triggers on "create an epic", "decompose this epic", "add tasks to the epic". Triggers may be phrased in any language.
---

# Jira Epic

Two shapes of the same job: an epic that does not exist yet with its children, or children
added to one that does.

Read `conventions.md` in the profile directory first. How the work is structured, where the
estimate lives, and what the anchor for a day is are team decisions recorded there.

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs"
```

`discovered.json` must exist and be fresh; the required fields per issue type come from it.
Missing → `/adf-jira:setup`. `profile.stale` true → offer to refresh.

## Step 1 — the structure, which the team has decided

How a child attaches to its epic is recorded in `conventions.md` under the work structure.
Follow it; do not re-derive it from documentation. When `conventions.md` records nothing,
stop and ask, then record the answer there (`/adf-jira:setup` step 4).

The two common models:

- **Sub-tasks carrying `parent`**, where `parent` holds the epic's key. Jira's Σ time fields
  aggregate over real sub-tasks, so the epic reports its rollup (Step 6). A sub-task cannot
  have children of its own, so the one-level structure is enforced by Jira rather than by
  discipline. Some instances refuse a sub-task directly under an epic; the team's record says
  whether this one allows it.
- **Standard issues carrying `Epic Link`**, a custom field whose id is in the field map. The
  Σ fields ignore `Epic Link`, so an epic built this way reports no rollup.

An `Epic` usually also requires `Epic Name` — a second title field separate from the
summary, easy to miss and a 400 when omitted. Read the type's `requiredFields` in
`discovered.json`, and the field's id from its `fieldMap`. A `Sub-task` requires `parent`,
and usually nothing else beyond summary, issuetype, reporter and project.

## Step 2 — propose the decomposition

Break the work into children and show the list before anything is built. This is judgement,
so it is a proposal: the developer edits it, and the edited version is what gets created.

Each child gets a summary that states an outcome rather than an activity, and a description
carrying the detail. Aim for children that are independently completable — one nobody can
finish without another finishing first is usually two children or one.

## Step 3 — propose the estimates

The estimate goes on each child, never on the epic. Set it through `timetracking` as
`{ "originalEstimate": "24h" }`, when the create screen of the child's type accepts it.
The epic's own estimate field stays empty; its total comes from the Σ fields instead.

Follow `conventions.md` for the unit, the rounding and the anchor of a day. Day rounding is
a worklog concern (`/adf-jira:worklog`), never an estimating one, unless the team's record
says otherwise.

Propose at the level the conventions state and **never write an estimate the developer has
not seen**. Show the list with a total, because the total is what they will react to.

## Step 4 — the ordering constraint

A create row's `fields` are literal. The engine substitutes nothing but the login
placeholders, so a child cannot reference an epic key that does not exist when the plan is
written.

**Epic already exists** — one plan. The children carry its key (in `parent`, or in the
`Epic Link` field). Confirm the target really is an `Epic` first: `parent` accepts any
standard issue, so a typo pointing at an ordinary `Task` creates a perfectly valid sub-task
under the wrong thing, and its time then rolls up somewhere nobody is looking.

**Epic to be created too** — two plans, in order. The first creates the epic; read the key
the runner wrote back as `createdKey`; then build the second plan for the children with
that key. Do not try to express both in one plan.

## Step 5 — build, gate, apply

A create row has no key until Jira assigns one, so it carries `key: "(new)"` and an explicit
`project` — the allowlist gate reads that.

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
      "summary": "<child summary, so the gate is readable>",
      "steps": [
        {
          "create": {
            "fields": {
              "project": { "key": "<PROJECT>" },
              "issuetype": { "name": "Sub-task" },
              "parent": { "key": "<epic key>" },
              "summary": "<child summary>",
              "description": "<child description>",
              "reporter": { "name": "<JIRA_ASSIGNEE>" },
              "assignee": { "name": "<JIRA_ASSIGNEE>" },
              "timetracking": { "originalEstimate": "24h" }
            }
          }
        }
      ],
      "state": "pending"
    }
  ]
}
```

One row per child. `parent` is a system field, so there is no field id to look up; `Epic Link`
and `Epic Name` are custom fields, written by their `fieldMap` id. `<JIRA_ASSIGNEE>` is a
placeholder: `apply-plan.mjs` replaces it with the developer's login from the env file, inside
its own process. Write the plan under `plans.dir`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path>
```

Prints the summary and exits without creating. Then, once agreed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path> --confirm
```

Each row is a separate `POST /issue`, applied in order, so a plan of twelve children is
twelve requests. A failure part-way leaves the earlier ones created and the plan recording
which — re-running creates only the rest.

## Step 6 — report the rollup, which is the point of all this

List the keys the runner wrote back, then read the epic and report **estimated, logged, and
the gap.**

Read those two numbers from the epic itself:

| Field | Holds |
|---|---|
| `aggregatetimeoriginalestimate` | estimated, summed over the sub-tasks |
| `aggregatetimespent` | logged, summed over the sub-tasks |

Both are seconds; divide by 3600. **Do not compute the total by walking the children** —
Jira maintains it, and a hand-rolled sum only creates a second number that can disagree.

The Σ fields aggregate over real sub-tasks and ignore `Epic Link` entirely: an epic whose
children are linked by `Epic Link` reports nothing here. Say so rather than computing a
substitute.

The epic's own `timeoriginalestimate` and `timespent` are a different pair and stay empty.
Reading those instead of the `aggregate` ones is the easy mistake here.

Report the rollup whenever this skill touches an epic, including when it only added
children. Never write it into a field: Jira already holds it, and a copy goes stale the
moment a child changes.

A visible gap between estimated and logged is not an error to fix here — it is worklog work,
and `/adf-jira:worklog` is where it belongs. Say the number and leave it.

## What this skill never does

- Set an estimate on the epic, or write any total into any field.
- Compute the rollup by summing children when Jira's Σ fields already hold it.
- Attach children by a model other than the one `conventions.md` records.
- Write an estimate or a child the developer has not seen.
- Put a child and its not-yet-created epic in one plan.
- Set `parent` to a key it has not confirmed is an Epic.
- Convert an existing issue into a sub-task — REST cannot; when `conventions.md` records the
  UI procedure that can, point to it.
- Hardcode a custom field id instead of reading the field map.
- Delete an issue. The account may hold the permission; nothing here exposes it.
