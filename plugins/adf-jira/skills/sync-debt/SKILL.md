---
name: sync-debt
description: Use when the ADF technical debt tree and its Jira epic need to be brought back into agreement — after entries are added, merged or reworded, or when asked to check whether the epic still mirrors the tree. Triggers on "sync the tech debt", "mirror the debt to Jira", "update the tech debt epic". Triggers may be phrased in any language.
---

# Sync the technical debt tree to Jira

The ADF core's debt tree (the registry's `debt.root`) is the source of truth. Jira mirrors it.
Nothing in this skill ever writes an entry's content from Jira — the only thing that travels
back is the issue key, into the entry's `Tracker` cell.

The tree is read and written only through the core's debt CLI, which this plugin runs for
you:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/core-debt.mjs" list --kind debt
node "${CLAUDE_PLUGIN_ROOT}/scripts/core-debt.mjs" track --id <entry id> --key <ISSUE-KEY>
```

Never edit a block index by hand: the core owns the tree's format and its check.

Read `conventions.md` in the profile directory first: the issue type, the resolution
vocabulary and the update rule are team decisions recorded there, not here.

## The epic

The registry config's `debtEpic` names it; `profile.mjs` prints it. With no `debtEpic`, stop
and ask the developer for the epic's key, and set it in the config. How children attach to
it is the model `conventions.md` records (see `/adf-jira:epic`, Step 1).

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs"
```

`discovered.json` must exist and be under 7 days old. Missing or stale → `/adf-jira:setup`.
Do not proceed on a stale profile: the field map is what the create payload is built from.

## Step 1 — read both sides

The tree: `core-debt.mjs list --kind debt`. Each entry carries `id`, `block`, `title`,
`anchors`, `class`, `source` and `tracker` (the key, or empty).

Jira, read-only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-issues.mjs" "parent = <debtEpic> ORDER BY key" <plans.dir>/epic.json
```

That script writes nothing to Jira and refuses any result outside the allowlist. Use the
JQL of the epic model `conventions.md` records (`parent = ...` for sub-tasks,
`"Epic Link" = ...` for linked issues).

## Step 2 — the decision table

Decide each entry on its own, then each epic child that no entry claims. "The initial status"
is the status a new issue starts in; `conventions.md` names it, and when it does not, ask.

| State | Action |
|---|---|
| Entry has no key | Create a child of the epic; write the returned key into the entry with `track` |
| Entry has a key, issue is in the initial status | Update summary and description from the entry, but only if they actually differ — see Step 3 |
| Entry has a key, issue has moved past the initial status | Do not edit it. Create a successor, link it `Relates` to the original, and replace the key in the entry with `track` |
| Entry has a key, issue is not a child of the epic | Nothing. An entry may legitimately mirror a standalone issue outside the epic. A reconciliation scoped to the epic's children is structurally blind to those entries, so read them from the tree, never from the epic |
| Entry has a key, issue does not exist | Stop and report it. Do not silently re-create: a key that resolves to nothing means someone deleted an issue, and that is a fact the developer needs |
| Epic child with no entry, already done | Nothing. It predates the tree or was closed by a consolidation pass |
| Epic child with no entry, still open | Nothing, and report it. It is someone's in-flight work or another branch's entry that has not merged yet. **Never close it and never backfill it into the tree** — that is the reverse direction, and this skill does not run it |

**An empty `Tracker` cell always means "not mirrored yet".** It never means "do not mirror".
Every entry in the tree is work that can be filed; an entry too vague to word as a task is
still filed, as a task to find out what it is, with a `What to find out:` line saying what
the investigation must establish. A record that is *not* work — an accepted decision, a
firmware fact — is not a debt entry at all and belongs in the project's knowledge base. If
you find one in the tree, say so; do not file it and do not invent a marker for it.

**Class does not gate mirroring.** `defect`, `debt` and `decision` are all mirrored. Do not
infer a rule from which entries happen to carry keys today.

## Step 3 — what "differs" means, and what it does not

A mirror's Jira `summary` is deliberately **not** the entry title. It is a trimmed,
backtick-free paraphrase; the full title lives in the `description`. Comparing the entry
title against the Jira summary therefore reports drift on nearly every entry, and every one
of those reports is false.

Compare the **description body** instead. An entry needs an edit when its title, anchors or
class no longer match what the description carries. If nothing but the summary differs,
there is nothing to do.

The footer names no entry id, deliberately. A collapse pass that renumbers a block would
leave every description naming the id its neighbour had just taken, and the last naming an
id that no longer exists. Nothing would catch it, because titles, anchors and classes all
still match. Two failures hide in there and they behave differently — a dangling id
announces itself to the first person who looks, a redirected one resolves to a real entry
describing different work and cannot be noticed from the issue at all. **Do not introduce an
id here.** The mapping is already stored, in the stable direction, in the entry's `Tracker`
cell: to get from an issue to its entry, search the tree for the issue key and exactly one
entry carries it — the core's check refuses a duplicate key.

The description template, used for every mirror:

```
<full entry title>

Anchors: <anchors, verbatim from the entry>
Class: <defect|debt|decision>

Mirrored from the technical debt tree: <debt.root>/<block>/index.md — the row carrying this issue key.
```

**Never overwrite a description that was not built from this template.** Some issues an
entry points at were written by hand long before the tree existed and carry acceptance
criteria, a test stand and verification steps that no entry can reproduce. Decide this on
the **shape of the body**, not on the presence of a footer: an entry's key is what makes an
issue a mirror, and an issue can be a mirror and still have been authored by a person. If the
body is not the template's shape, report it and leave it alone.

Set no `assignee`, no `priority` and no estimate. Those are planning fields, set by a human
in the tracker. The mirror does not own them and must never overwrite them.

## Step 4 — plan, show, apply

Build one plan file per operation under `plans.dir` — creates in one, edits in another,
links in a third. Render each without `--confirm` and show the developer what it would do.
Apply only what they approve:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan>.json           # render
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan>.json --confirm # apply
```

## Step 5 — write the keys back, in the same run

A create is not finished until its key is in the entry. The apply run records `createdKey`
on each row of the plan file; read them from there and write each one with
`core-debt.mjs track --id <entry id> --key <createdKey>`. Then run
`core-debt.mjs check`.

**Skipping this is the one failure that compounds.** A sync that files four children and
does not stamp their keys leaves four entries still keyless, and the next run files them
again.

Commit the tree edit. Then report: created, updated, superseded, and everything Step 2 told
you to report rather than act on.

## What this skill does not do

- It does not write entry content from Jira, in any direction, for any reason.
- It does not edit the tree except through the core's `track`.
- It does not close epic children. Closure is a developer decision and goes through
  `/adf-jira:bulk` with the resolution `conventions.md` names for that case.
- It does not renumber entry ids. Ids change only in the core's own operations.
