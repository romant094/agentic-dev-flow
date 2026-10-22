---
name: sync-debt
description: Use when the ADF technical debt tree and its Jira epic need to be brought back into agreement — after entries are added, merged or reworded, or when asked to check whether the epic still mirrors the tree. Triggers on "sync the tech debt", "mirror the debt to Jira", "update the tech debt epic". Triggers may be phrased in any language.
---

# Sync the technical debt tree to Jira

The ADF core's debt tree (the registry's `debt.root`) is the source of truth. Jira mirrors it,
one way. **One Jira issue mirrors a group of related debt entries**, and every entry of the
group holds the issue's key in its `Tracker` cell. Nothing in this skill ever writes an entry's
content from Jira — the only thing that travels back is the issue key, into the entry's
`Tracker` cell.

Every deterministic step is `scripts/sync-debt.mjs`, one JSON result each; the tree is read and
written only through the core's debt CLI, which that script runs for you. To look at the tree
yourself, read it the same way, never by hand:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/core-debt.mjs" list --kind debt
```

Your one decision is
the grouping: which keyless entry joins which group, which entries form a new group, and which
wait. The run works from the tree alone: it does not read the epic's children.

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" --skill sync-debt
```

- `discovered.json` must exist and be under 7 days old. Missing or stale: `/adf-jira:setup`.
- `config.debtEpic` names the epic. Without it, a new group cannot be filed: ask the developer
  for the epic's key and set it in the config.
- `config.statuses.initial` names the status a new issue starts in. Without it, no group is
  edited: ask the developer, take the name from `conventions.md`, and set it in the config.
- `plans.ignored` false: stop and ask the developer to run `/adf:init`, or to add `.adf/jira/`
  to `.gitignore`.

Read `conventions.md` in the profile directory: it records the issue type of a child of the
debt epic and how a child attaches to its epic (`parent`, or the `Epic Link` field; see
`/adf-jira:epic`, Step 1). When it records neither, ask, and record the answer there.

## Step 1 — the state of the tree

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-debt.mjs" state
```

`groups` lists each key with its entries; `keyless` lists the entries not mirrored yet, each
with `related`: the groups and the other keyless entries it shares a block, a sub-block or an
anchor file with. An empty `keyless` list means the run only refreshes the groups' descriptions
(Step 3).

## Step 2 — decide the grouping

Decide each keyless entry once. Write the decision to a file under `plans.dir`:

```json
{
  "version": 1,
  "join": [{ "key": "PROJ-12", "entries": ["snmp-03"] }],
  "create": [{ "summary": "Session pool leaks connections on reconnect", "entries": ["snmp-04", "snmp-05"] }],
  "wait": [{ "entry": "ui-02", "reason": "the cause may be the grid library; its owner decides first" }]
}
```

- **Related** means one unit of work a tester checks once: the same block or sub-block, shared
  anchors or files, the same subject. `related` is a hint, never the decision: a shared block
  alone does not make two entries one piece of work.
- **Prefer joining a group over a new issue**, and a new group of several entries over one issue
  per entry.
- **Never avoid a group because its issue may have moved on.** The plan cannot see the issue's
  status; the apply run checks it. A join to an issue that left the initial status is skipped,
  and its entries wait for a new group (Step 5).
- A `summary` is a trimmed, backtick-free paraphrase of what the group fixes, at most 255
  characters. The description is not yours: the script renders it from the template.
- `wait` keeps an entry keyless this run, with the reason. An empty `Tracker` cell still means
  "not mirrored yet", never "do not mirror": use `wait` for a decision the developer must make,
  not as a way to skip filing. An entry too vague to word as a task is still filed, as a task
  to find out what it is. A record that is not work, an accepted decision or a firmware fact,
  is not a debt entry: say so, and do not file it.
- Class does not gate mirroring: `defect`, `debt` and `decision` are all filed.

Check it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-debt.mjs" check-groups --file <grouping.json>
```

`ok` false: fix each line of `errors` and check again. It refuses an unknown or already tracked
id, an entry decided twice or not at all, a join to a key no entry holds, and a malformed item.

## Step 3 — build the plans

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-debt.mjs" plan --file <grouping.json> --type <issue type> --attach parent|epic-link
```

`--type` and `--attach` come from `conventions.md`, and are needed only when the grouping files
a new group. The script writes up to two plans under `plans.dir`:

- **create**: one row per new group, a child of `debtEpic`, its description rendered from the
  template; no assignee, priority or estimate. Those are planning fields, set by a human in the
  tracker; the mirror never sets or overwrites them.
- **edit**: one row per existing group, its description rendered again from its entries and its
  joins. A row is sent only while the issue is in `statuses.initial` and its description still
  has the template's shape, and only when the description differs. An issue that left the
  initial status is never edited, and a description a person rewrote is never overwritten. A
  description of the previous one-entry template (the entry's title, its `Anchors:` and
  `Class:` lines, and the `Mirrored from the technical debt tree:` footer) is sync-debt's own
  too: the first sync renders it again as its group's list.

The description template is `templates/debt.md`; `config.debtTemplate` names a host file that
replaces it. It lists each entry with its id, title, anchors and class: since ids are never
reallocated, an id in the body can go stale but never point at other work.

## Step 4 — show, then apply on the developer's yes

Show `preview` and render each plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan>.json            # render
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan>.json --confirm  # apply
```

Apply only what the developer approves. The developer may change the grouping here, for
example file an entry as a new group now rather than join it to a group whose issue may have
moved on: then go back to Step 2.

## Step 5 — write the keys back, in the same run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-debt.mjs" track --plan <create plan> --plan <edit plan>
```

It writes the key of every applied row into its entries through the core's `track`, and runs
the core's `check`. Only applied rows count: a create writes its new key into its entries, a
join writes the group's key into the joining entries. `waiting` lists the joining entries of a
group whose row was skipped: the issue left the initial status, or its description is not the
template's. They stay keyless and wait for a new group, the next run's decision. `notApplied`
lists the rows the apply did not finish: run `apply-plan.mjs --confirm` again, then `track`
again.

**Skipping this step is the one failure that compounds**: a run that files issues and does not
write their keys files them again next time.

Commit the tree edit. Then report: created, updated, unchanged, the entries that wait and why,
and the groups left untouched and why.

## What this skill does not do

- It does not read the epic's children. To report an epic child no entry claims, read them
  as a diagnostic only, on the developer's request:
  `read-issues.mjs "parent = <debtEpic> ORDER BY key" <plans.dir>/epic.json`; never close such
  a child and never backfill it into the tree.
- It does not write entry content from Jira, in any direction, for any reason.
- It does not edit the tree except through the core's `track`, and never moves an entry from
  one key to another.
- It does not close issues. Closure is a developer decision and goes through `/adf-jira:bulk`
  with the resolution `conventions.md` names; the change workflow's `/adf:land` hands a group's
  issue to the tester once no entry of the group remains.
