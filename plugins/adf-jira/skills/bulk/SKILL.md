---
name: bulk
description: Use to move many Jira issues at once — a status change with the fields that go with it, a field edit across a selection, or a reassignment. Solves each issue's own transition path from the discovered workflow, shows the plan, and applies it only after confirmation. Triggers on "close these issues", "move them to resolved", "reassign to the PM", "send to review", "hand over to QA", "bulk edit". Triggers may be phrased in any language.
---

# Jira Bulk

Two operations share this skill because they share a selection and a gate: moving issues
through the workflow, and editing fields across a selection.

Read `conventions.md` in the profile directory before deciding what a status change means —
which status counts as done and which `resolution` goes with it are team decisions recorded
there, not defaults to pick.

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" --skill bulk
```

`discovered.json` must exist and be fresh. Every transition id comes from it; ids belong to
one workflow scheme and change without notice. If it is missing, send the developer to
`/adf-jira:setup`; if `profile.stale` is true, offer to refresh, since `apply-plan.mjs`
refuses a stale plan anyway. The same output gives the allowlist (`config.allowlist`) and
the plan directory (`plans.dir`).

## Step 1 — the selection

Get the JQL, or build it from what the developer described.

**Insist on a project clause.** The allowlist will reject a plan whole if a foreign issue
slips in — the guard works — but a query without a project clause is a mistake worth
catching before it becomes a rejected plan. A token usually sees far more projects than
the allowlist names.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-issues.mjs" "<JQL>"
```

Report what it returned before going further: how many issues, and their current statuses
grouped. A selection that returns three times what the developer expected is the moment to
stop, not after a plan exists.

## Step 2 — the target, and each issue's own path

For a status change, establish the target status from what the developer asked and from
`conventions.md`.

**Each issue gets its own path, solved from its own current status.** A selection like
"everything not done" returns issues sitting in different statuses, and they do not share a
route. Solve each issue's route breadth first over the `workflow` graph of `discovered.json`
(status → transitions, each `{ id, name, to, requiredFields }`), as `solvePath` in the
plugin's `scripts/lib/paths.mjs` does, and handle all three of its answers:

- `path` — the hops to run. No hop means the issue is already at the target: exclude it and
  report it as excluded, do not build a no-op row.
- `unreachable` — no route exists on this workflow. Report these issues separately and do
  not include them. Do not invent a longer route.
- `unknown` — the search crossed a status in `unsampledStatuses`, whose transitions were
  never sampled because no issue sat in it at discovery time. The route may exist and may
  not. Name these issues and the unsampled statuses, and ask before including them.

A workflow often has no direct transition to the done status from a working status, so the
route runs through a review status, and reaching a closed status adds another hop.
Multi-hop is normal, not an error.

## Step 3 — the fields that ride along

Read the required fields of each hop from `discovered.json` and fill them. A resolve
transition usually **requires** `resolution`; a plan omitting it fails with 400 on every row.

A transition screen may also accept other fields — `assignee`, `fixVersions`,
`timetracking`. When the hop's screen accepts `assignee`, "move to the done status and
reassign to the PM" is **one request per issue**, not two — put `assignee` in the same step's
`fields`. Write the PM's login as the placeholder `<JIRA_PM>`: `apply-plan.mjs` replaces it
from the env file inside its own process, and its summary prints the resolved login. Never
read the env file to find the login.

When the hop's screen records no `assignee` field — a hand-off to review often does not —
reassigning to the QA is a field edit step of its own, right after the hop:
`{ "fields": { "assignee": { "name": "<JIRA_QA>" } } }`, resolved the same way.

Take allowed values from `discovered.json` rather than inventing them. If the developer
asks for a `resolution` other than the team's default, say which one `conventions.md`
records and confirm the departure.

## Step 4 — field edits without a transition

For an edit, the step carries `fields` and no `transitionId`; the runner issues
`PUT /issue/{key}`.

**Whether to set `from` depends on how the selection was built.** If the selection was
status-based — "everything in Review" — set `from` to each issue's current status, so an
issue that has since moved is skipped as drifted rather than edited when it no longer
matches the selection. If the selection had nothing to do with status, omit `from`: there is
nothing meaningful to compare, and including it would skip issues for no reason.

## Step 5 — build the plan, gate it, apply

One row per issue. The steps within a row are that issue's hops, in order.

```json
{
  "version": 1,
  "operation": "transition",
  "jql": "<the selection, verbatim>",
  "allowlist": ["<PROJECT>"],
  "discoveredAt": "<copied from discovered.json>",
  "rows": [
    {
      "key": "<PROJECT>-564",
      "summary": "<the issue summary, so the gate is readable>",
      "from": "<the issue's current status>",
      "steps": [
        { "transitionId": "<id of the first hop>", "to": "<its target status>" },
        {
          "transitionId": "<id of the second hop>",
          "to": "<the target status>",
          "fields": {
            "resolution": { "name": "<the team's done resolution>" },
            "assignee": { "name": "<JIRA_PM>" }
          }
        }
      ],
      "state": "pending"
    }
  ]
}
```

Use `operation: "edit"` for a field edit. Always read the transition ids from
`discovered.json`. The allowlist is `config.allowlist`; a plan naming another project is
refused.

Write the plan under `plans.dir`. `plans.dir` is `.adf/jira/bulk/` in the main checkout. When
`plans.ignored` is false, stop and ask the developer to run `/adf:init`, or to add `.adf/jira/`
to `.gitignore`: `apply-plan.mjs` refuses a plan git does not ignore. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path>
```

That prints the summary and exits without applying. Rows with identical step sequences and
identical field values collapse into one counted line, so a 600-issue plan stays readable
while still telling the truth about what differs. Apply only after the developer agrees:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path> --confirm
```

## Step 6 — report what actually happened

The runner prints `applied`, `skipped (done)`, `skipped (drift)` and `failed`. Read them out
and explain the non-zero ones:

- **`skipped (drift)`** — the issue's status no longer matched the plan. Somebody moved it
  by hand. This is the guard working, not a failure; the row's `error` names both statuses.
- **`failed`** — the row's `error` carries Jira's own message. A missing required field on a
  transition screen looks like this.
- **Aborted after three consecutive failures** — something systemic, usually a field the
  whole plan omits. Fix the cause and re-run the same plan; rows already `done` are skipped,
  so nothing is repeated.

A re-run is always safe and is the normal way to finish a partial run.

Then verify against Jira rather than the runner's count: read the statuses back for a sample
of the rows, or all of them for a small plan.

## What this skill never does

- Take a transition id from anywhere but a refreshed `discovered.json`.
- Build a single shared path for a selection whose issues sit in different statuses.
- Include an issue whose path came back `unreachable` or `unknown` without asking.
- Fill a required transition field with a value it chose itself.
- Read the env file for a login: a login is a placeholder the apply process resolves.
- Filter a foreign issue out of a selection — the allowlist rejects the plan whole, and that
  is the intended behavior. Fix the query.
- Delete an issue. The account may hold the permission; nothing here exposes it.
