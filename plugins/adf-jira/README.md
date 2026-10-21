# Jira tracker for the Agentic Dev Flow

This plugin provides the `tracker` role of the ADF extension contract (version 1.7) on Jira
Server and Data Center, over REST v2. At propose, the ADF core gathers the issues a change can
take and moves the taken ones to the start status; after the merge, `/adf:land` writes one
templated comment per issue and hands it to the tester. The plugin also ships standalone Jira
skills: bulk changes, comments, epics, tasks, worklogs and the debt mirror.

Every write is two-phase: a plan is built and shown, and it is applied only after the
developer's yes. Install it in the host project, then add it to the registry:

```
/plugin install adf-jira --marketplace romant094/agentic-dev-flow
/adf:add adf-jira@agentic-dev-flow --config '{"baseUrl":"https://jira.example.com","allowlist":["PROJ"]}'
```

Then run `/adf-jira:setup` once: it discovers the project's workflow and writes the profile
every skill and operation reads.

## Configuration

The `config` object of this plugin's entry in `.claude/adf-extensions.json`. It is committed and
holds nothing secret.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `JIRA_URL` from the env file | The Jira base URL, `https://jira.example.com`. |
| `allowlist` | `JIRA_ALLOWED_PROJECTS` from the env file | The project keys the plugin may read and write. A plan touching any other project is refused whole, never filtered. An empty list is refused. |
| `profileDir` | `.claude/jira/profile` | Where the profile lives: `discovered.json` and `local.md` (personal, gitignored) and `conventions.md` (the team's, committed). |
| `debtEpic` | none | The epic the debt tree is mirrored into (`/adf-jira:sync-debt`). |
| `fields` | `[]` | Field names, as the profile's field map spells them, that `gather` reads for each issue, for example `["Reproduce steps", "Expected result"]`. |
| `statuses` | `{ "start": "In Progress", "handoff": null, "excluded": [] }` | `start`: the status `start` moves an issue to. `handoff`: the status `handoff` moves a taken issue to; required for a hand-off. `excluded`: statuses that keep an issue out of a change's scope besides the closed ones (for example a suspended status). |
| `commentTemplate` | the plugin's `templates/handoff.md` | A host file that replaces the hand-off comment template. |
| `envFile` | `.claude/.env` | The project's env file, relative to the main checkout. |

An unknown key is refused, so a typo is not silently ignored. The status names are the team's;
record them in `conventions.md` too (`/adf-jira:setup` asks for them).

## Credentials

The token and the personal logins stay in the env file, which is never committed. Copy
`env.example` to `.claude/.env` (or the config's `envFile`) and fill in `JIRA_PAT`; the other
keys are optional.

| Key | Use |
|---|---|
| `JIRA_PAT` | The personal access token, sent as a bearer token. Required. |
| `JIRA_ASSIGNEE` | The developer's login: the assignee at `start` and on created issues. Empty: the token's own account. |
| `JIRA_QA` | The tester's login: the assignee at `handoff`. Required for a hand-off. |
| `JIRA_PM` | The project manager's login, for a bulk close. |
| `JIRA_GIT_AUTHOR`, `JIRA_DEFAULT_PROJECT` | For the worklog practice and for discovery. |
| `JIRA_URL`, `JIRA_ALLOWED_PROJECTS` | Used only when the config sets no `baseUrl` or `allowlist`. |

The resolution order is the process environment, then the project's env file, then
`~/.claude/.env`; the first non-empty value wins. The env file and the profile are read from
the main checkout, so a change's worktree uses the same ones.

The agent never reads the env file. The plugin's scripts read it inside their own process, and
their diagnostics name a variable, its layer and its length, never its value. A plan names a
login only as a placeholder (`<JIRA_ASSIGNEE>`, `<JIRA_PM>`, `<JIRA_QA>`): the apply process
resolves it, the plan file keeps it, and the preview prints the resolved login, which is not a
secret.

## The role

The core runs `node <plugin>/scripts/tracker.mjs <operation>` and writes one JSON object to
stdin: `{ "root": "<host or worktree root>", "config": { ... }, "input": { ... } }`. The plugin
prints one JSON object with `state` set to `done`, `degraded` or `refused` (with `error`). The
exit code is 0 for `done` and `degraded`, 1 for `refused`.

| Operation | Input | Result when `done` |
|---|---|---|
| `check` | `{}` | `tool: "ready"`, `account` (the token's login from `/rest/api/2/myself`), `sources` (each env value's name, layer and length), `profile.discoveredAt` |
| `gather` | `keys` (issue keys) or `text`; `change`; `stateDir` (absolute) | `items` and `notes`, below; one JSON file per issue in `stateDir` |
| `start` | `items: [{ key }]`, `stateDir`; `apply` (a plan id) | without `apply`: `held: true`, `plan`, `file`, `preview`; with it: `applied` (keys), `skipped` and `failed` (`{ key, reason }`), `aborted` |
| `handoff` | `items: [{ key, state, fields }]`, `mr: { url } \| null`, `stateDir`; `apply` | as `start` |

`check` is `degraded` with `tool` and `hint`, and sends nothing past the probe:

- `missing`: no env file or no `JIRA_PAT`; the hint names the template to copy;
- `unauthenticated`: Jira answered 401 or 403 to `/myself`; the hint says to create a new token;
- `unconfigured`: no `baseUrl` or `allowlist`, no profile, or a profile more than 7 days old;
  the hint names the config to set or `/adf-jira:setup`.

`gather`, `start` and `handoff` degrade the same way when the env or the profile is not ready.
An input field the plugin does not use (`change`; an item's `state`, `corrections` or `answers`
at `start`) is accepted and ignored.

**`gather`** reads each named issue (or, for a `text`, the open issues of the allowlisted
projects whose text matches, at most 20), and one level of related issues: its parent, its
sub-tasks and its linked issues. A key outside the allowlist is named in `notes` and never
fetched. Each issue's file holds its description, all its comments, the `config.fields`
values, its parent, sub-tasks and links. Each item is `{ key, url, kind, subtask, title, status,
open, parent, subtasks, links: [{ key, relation }], named, via, branchToken, branchRank,
excluded, flags, file }`:

- `kind` is `bug` (an issue type whose name contains "bug"), `sub-task`, `epic`, `story` or
  `task`;
- `excluded` is the reason an issue is out of scope (a closed status, or one of
  `statuses.excluded`), else `null`; `flags` holds one line when an excluded issue's latest
  comment is newer than its move into its status, which may mean the status is stale;
- `branchToken` is the key; `branchRank` orders the branch key: a named sub-task first, then
  the lowest sub-task, then the lowest bug, then a named task. Equal ranks are a tie for the
  developer; an excluded issue and an epic have `null`.

**`start`** without `apply` builds a plan in `stateDir` and sends nothing: per issue, the
shortest route from its status to `statuses.start`, then the developer as assignee when the
issue is not assigned to them. An issue with no route, a route through an unsampled status,
a hop whose screen requires a field, or nothing to do is skipped with its reason. With
`apply: <plan id>` the plan runs.

**`handoff`** checks the fields first and sends nothing on an error. Per item state:

| State | Fields | The row |
|---|---|---|
| `taken` | `done`, `test` (lists); `commit` | the route to `statuses.handoff`, the tester (`JIRA_QA`) as assignee, the comment |
| `partial` | `remains`; `done`, `commit` | the comment only; the status stays |
| `not-reproduced` | `tried`, `commit`; `test` | as `taken`: the comment says the issue does not reproduce on that commit, and the tester retests it |

Each field list holds one-line texts; a text holding a link or a URL is refused, and so is a
`commit` that is not a commit hash. The core checks the wording; the plugin renders the markup.

**Held plans and resume.** A plan is `start-<UTC stamp>` or `handoff-<UTC stamp>`, a file in
`stateDir`. Before it applies, the plugin refuses a plan whose allowlist reaches past the
configured one, and a plan built against an older profile than the current one. A rerun with
the same plan id resumes from the per-row state: a row already done is not sent again. An issue
moved by hand since the plan was built is skipped as drifted, not failed. Three failures in a
row stop the run; rerun the same plan after fixing the cause.

With no `adf-jira` entry, the role is `none` and the core skips every tracker step and says so.

## The hand-off comment

The comment is rendered by script from the fields, in Jira wiki markup, with
`templates/handoff.md`. The template has one section per state, each opened by a marker line
`<!-- taken -->`, `<!-- partial -->` or `<!-- not-reproduced -->`. Inside a section, a
placeholder in double braces is replaced: `done`, `test`, `remains` and `tried` are lists, and
a line holding one repeats once per item; `commit` is the commit hash; `mr` is the merge
request URL. A line holding an empty value is dropped, and a block opened by `#name` and closed
by `/name` (each in double braces, on its own line) is kept only when the value is not empty.
The merge request line appears only when the core passes `mr`, which it does only with a forge.
Agent text is escaped, so a bracket or a brace opens no link or macro.

To change the comment, copy `templates/handoff.md` into the host, edit it, and name the copy in
`config.commentTemplate`. A template without the three sections, with an unknown placeholder or
with an unclosed block is refused. Every comment then has the host template's shape.

## Skills

| Skill | Does |
|---|---|
| `/adf-jira:setup` | Discovers the project's API facts into `discovered.json` and interviews for `conventions.md` and `local.md`. Refuses to write while git does not ignore the personal files. |
| `/adf-jira:bulk` | Status changes and field edits across a JQL selection, each issue on its own route. |
| `/adf-jira:comment` | Writes a comment, or rewrites one by id, on one issue or a selection. |
| `/adf-jira:epic` | An epic with its children and estimates, and the rollup read from Jira's Σ fields. |
| `/adf-jira:task` | One issue with the fields its type requires, drafted or created. |
| `/adf-jira:worklog` | Fills worklogs by the developer's own practice, kept in `local.md`. |
| `/adf-jira:sync-debt` | Mirrors the core's debt tree into `config.debtEpic`, one way, and writes each key back with the core's `debt.mjs track`. |

The skills run the plugin's scripts:

| Script | Does |
|---|---|
| `scripts/profile.mjs` | Prints the profile's paths, whether git ignores the personal files, the profile's age, the non-secret config and the plan directory. Reads no env file and calls nothing. |
| `scripts/discover.mjs [<KEY>]` | Writes `discovered.json`. |
| `scripts/read-issues.mjs "<JQL>" [out]` | Reads issues; a result outside the allowlist fails the read. |
| `scripts/read-comments.mjs "<KEY>" [out]` | Reads every comment of an issue, with its id; the allowlist is checked before the request. |
| `scripts/apply-plan.mjs <plan> [--confirm]` | Prints the plan's summary, or applies it with `--confirm`. |
| `scripts/core-debt.mjs <args>` | Runs the core's `scripts/debt.mjs` with the same arguments: the core beside this plugin in a checkout, else the `adf` plugin of this plugin's marketplace from Claude Code's install records. |

`read-issues.mjs` and `read-comments.mjs` print JSON on stdout when no output path is given;
`JIRA_READ_VERBOSE=1` adds the env diagnostics on stderr. The skills write their plans under
`.claude-reports/jira/`, which `profile.mjs` reports as `plans.dir`, with whether git ignores
it.

## Boundaries

The plugin never deletes an issue or a comment: there is no delete path in the engine. It never
writes outside the allowlist, never applies without the developer's yes, never takes a
transition id from anywhere but `discovered.json`, never fills a required transition field on
its own, and never logs time the developer has not confirmed.

## Tests

```bash
node --test plugins/adf-jira/scripts/__tests__/*.spec.mjs
```

The tests use a fake `fetch` and temporary directories; no test reaches Jira or the network.
