---
name: comment
description: Use to write a comment on a Jira issue, or to correct one already written — one issue or a selection. Drafts the text, shows it, and posts it only after confirmation. Also drafts without posting, for when the wording needs agreeing first. Triggers on "comment on this issue", "add a note to the ticket", "fix my last comment". Triggers may be phrased in any language.
---

# Jira Comment

Adds a comment to an issue, or rewrites one that is already there. Moving an issue's status
is `/adf-jira:bulk`; a comment that should accompany a status change is described at the end
of this file and belongs in that plan, not in a second one.

Read `conventions.md` in the profile directory first: what the team expects a comment to
carry, and in whose voice, is recorded there.

## Step 0 — preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs"
```

`discovered.json` must exist and be fresh. Missing → send the developer to `/adf-jira:setup`.
`profile.stale` true → offer to refresh, since `apply-plan.mjs` refuses a stale plan anyway.

## Step 1 — draft the text

Write the comment from what the developer described and show it before building anything.
Wording is cheap to fix now and public the moment it is applied — a comment notifies every
watcher, and editing it afterwards leaves the notification already sent.

The body is Jira wiki markup, not Markdown: `{code}` blocks, `*bold*`, `# numbered`. A
Markdown fence pasted into it renders as literal backticks.

Write what the reader of the issue needs, not what the developer already knows. A comment
that says "done" tells the next person nothing; one that names what was changed and what
was verified tells them everything.

## Step 2 — correcting an existing comment

An edit addresses a comment by id, and ids are not guessable. Read them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-comments.mjs" "<ISSUE-KEY>"
```

That writes nothing to Jira. It prints each comment's id, author, timestamps and body, and
refuses a key outside the allowlist before the request goes out.

Show the developer the candidates with their authors and dates, and let them pick. Never
infer which comment they meant from the body alone — two comments on the same issue often
say nearly the same thing, and rewriting the wrong one destroys text nobody kept a copy of.

An edit replaces the whole body; Jira keeps no version history the plugin can read. Show
the old text and the new text side by side before applying.

## Step 3 — draft-only mode

When the developer wants the text without posting it — the wording needs agreeing, or there
is no token yet — stop after Step 1 and hand over the draft. Say plainly that nothing was
posted. This is a legitimate outcome, not a failure.

## Step 4 — build the plan, gate it, apply

```json
{
  "version": 1,
  "operation": "comment",
  "allowlist": ["<PROJECT>"],
  "discoveredAt": "<copied from discovered.json>",
  "rows": [
    {
      "key": "<PROJECT>-586",
      "summary": "<the issue summary, so the gate is readable>",
      "steps": [{ "comment": { "action": "add", "body": "<the body, in wiki markup>" } }],
      "state": "pending"
    }
  ]
}
```

A correction carries the id instead:

```json
{ "comment": { "action": "edit", "id": "45678", "body": "<the replacement body>" } }
```

Write it under `plans.dir` (from `profile.mjs`), then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path>
```

That prints the summary — the shape of each row and the body it will write, truncated —
and exits without posting. Apply only after the developer agrees:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.mjs" <plan-path> --confirm
```

## Commenting a whole selection

One row per issue, same as any other plan. Say in the summary line how many issues are in
it: a comment is a notification to every watcher of every one of them, so twenty rows is
twenty times the noise, and the developer should see that number before confirming.

Where the same text goes on every issue, the report collapses the rows into one counted
line — twenty identical bodies read as `20 × comment`, not as twenty blocks to scan.

## Commenting as part of a status change

A comment is a step, so a row that transitions an issue can carry one:

```json
{
  "key": "<PROJECT>-586",
  "summary": "…",
  "from": "<the issue's current status>",
  "steps": [
    { "transitionId": "<hop id>", "to": "<target status>" },
    { "comment": { "action": "add", "body": "Ready for review." } }
  ],
  "state": "pending"
}
```

That belongs in the `/adf-jira:bulk` plan that does the transition, not in a separate comment
plan — one row, one confirmation, and the comment is skipped along with the transition if
the issue drifted. Do this when the developer asks for it. Do not offer it on every status
change: most closures need no comment, and a prompt for one each time trains people to
ignore the prompt.

The flow's own hand-off comment after a merge is not written here: the core's land step
sends its fields to the tracker role, which renders the plugin's template.

## What this skill never does

- Post a comment the developer has not seen in full.
- Edit a comment without showing which one, by id and author, and what it said before.
- Delete a comment. The plugin has no delete path at all — an unwanted comment is edited
  or left alone.
- Guess which comment an edit means from its body.
- Write a comment on an issue outside the allowlist — the gate refuses the whole plan rather
  than filtering it.
