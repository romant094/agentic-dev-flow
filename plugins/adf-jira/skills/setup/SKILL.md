---
name: setup
description: Use to create or refresh the Jira project profile that every other adf-jira skill reads — discovers API facts from the live instance and interviews the developer for team and personal conventions. Run it once per project, and again after a Jira admin changes the workflow. Triggers on "set up jira", "refresh the jira profile", "jira setup". Triggers may be phrased in any language.
---

# Jira Setup

Writes the three-layer project profile. Every other `adf-jira` skill refuses to guess and
sends the developer here when the profile is missing or stale.

Where the profile lives is the registry config's `profileDir` (default `.claude/jira/profile`).
Print it, with the rest of the plugin's non-secret configuration:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs"
```

| Layer | File | Committed | Source |
|---|---|---|---|
| API facts | `<profileDir>/discovered.json` | no, gitignored | `scripts/discover.mjs` |
| Team agreements | `<profileDir>/conventions.md` | yes | interview |
| Personal preferences | `<profileDir>/local.md` | no, gitignored | interview |

The layers are separate because they go stale for different reasons: an admin editing a
workflow invalidates the facts but not the agreements, and a team changing its process
does the opposite.

The facts layer is also **personal**, which is why it is not committed. Only part of it is
instance-wide — the project, the issue types and the field map. The rest is the schema
projected onto whoever ran the discovery: which transitions that account may take, which
fields each transition requires of it, and what it is permitted to do. A committed file
would let one developer's role decide another developer's plan, and the mismatch would
only surface as a refusal at apply time.

## Step 1 — check the configuration and the credentials

**Never read, `cat`, `grep` or open the env file, and never ask for a token in chat.**
Credentials are loaded inside the script process and must not enter the conversation.

The Jira URL and the project allowlist are the registry config's `baseUrl` and `allowlist`
(`.claude/adf-extensions.json`, set with `/adf:add adf-jira@agentic-dev-flow --config '<json>'`).
`profile.mjs` prints them. If either is missing, ask the developer for the value and set it.

The token and the personal logins are in the env file (`.claude/.env`, or the config's
`envFile`). If the developer has no env file yet, tell them to copy
`${CLAUDE_PLUGIN_ROOT}/env.example` to it and fill in `JIRA_PAT`, then stop and wait. The PAT is
created in Jira under avatar → Profile → Personal Access Tokens.

## Step 2 — make sure the personal files stay out of git

`profile.mjs` prints `profile.ignored` for `discovered.json` and `local.md`. When either is
`false`, stop: add the file to `.gitignore` and run the check again until both are `true`.
`discover.mjs` refuses to write the profile until they are.

## Step 3 — discover the API facts

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" <PROJECT-KEY>
```

The script prints which variables resolved, from which layer, and their length — never
their content. If a variable is missing or looks truncated, that table is the diagnosis;
do not open the file to investigate.

Report to the developer: instance version and deployment type, the issue types found, how
many statuses the workflow has, and the path written.

Re-running is safe and silent: `discovered.json` is regenerated, and `conventions.md` and
`local.md` are never touched by the script.

## Step 4 — interview for the team agreements

Ask only what the API cannot answer, one question at a time, and skip anything
`conventions.md` already records. Read the existing file first if it is there.

Ask about:

1. **Work structure.** Are issues organized under epics, and how does a child attach to its
   epic: a `Sub-task` carrying `parent`, or a standard issue carrying `Epic Link`? Jira's Σ
   time fields aggregate over sub-tasks only, so the choice decides whether an epic reports a
   rollup. Record the decision and the reason.
2. **Estimation.** Which field carries the estimate, and what does a one-day task look
   like in this project? Record the anchor, so estimates stay consistent between runs
   rather than being re-invented.
3. **Definition of done.** Which status counts as done, and which `resolution` value
   means it. Take the allowed values from `discovered.json` rather than inventing them.
4. **Conventional fields.** Which fields the team always fills even where Jira treats
   them as optional.
5. **Start of work and hand-off.** Which status an issue takes when work starts, which
   status hands it to the tester, and which statuses keep an issue out of a change's scope.
   These are also the registry config's `statuses` (`start`, `handoff`, `excluded`), which the
   flow's tracker steps read: set them there too.

Write the answers to `conventions.md` as prose with a short table for the field and status
decisions. Never overwrite an existing answer without showing it and asking.

## Step 5 — interview for the personal preferences

These must not go into `conventions.md`: they are one developer's, and committing them
imposes them on the team.

Ask about:

1. **Day capacity and remainder policy** — how many hours a working day holds, and what
   happens to a remainder.
2. **Worklog voice** — how an entry reads: tense, length, whether identifiers appear.
3. **Default assignee and git author** — confirm `JIRA_ASSIGNEE` and `JIRA_GIT_AUTHOR`
   resolved, by name only, from the table in step 3.

Record the voice as an explicit example rather than an adjective, so a later run
reproduces it instead of reinterpreting it.

Write the answers to `local.md` only after step 2 showed it ignored.

## Step 6 — report

Tell the developer what was written, which layer each answer landed in, and what remains
undecided. An unanswered question is recorded as an open item in the relevant file, not
guessed.

## The profile grows by asking

When any `adf-jira` skill meets a situation the profile does not cover, it stops, asks, and
records the answer in the right layer — so the same question is never asked twice, and
nothing is ever guessed silently. Two questions are often left open, and are worth naming
when they are:

- what to do when the agreed hours exceed the material available in commits;
- whether every issue type runs the same workflow scheme as the types verified during
  discovery. The graph is keyed by status name alone, so a type with its own scheme is a
  correctness risk until its transitions are confirmed.

## Staleness

`discovered.json` carries `discoveredAt`. Other skills warn past 7 days and suggest
re-running step 3. Transition ids belong to the workflow scheme and change without
notice, so a stale file is a correctness risk, not a cosmetic one.
