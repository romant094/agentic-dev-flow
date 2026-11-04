<!-- sources:
- plugins/adf-jira/skills/bulk/**
- plugins/adf-jira/skills/comment/**
- plugins/adf-jira/skills/epic/**
- plugins/adf-jira/skills/setup/**
- plugins/adf-jira/skills/sync-debt/**
- plugins/adf-jira/skills/task/**
- plugins/adf-jira/skills/worklog/**
- plugins/adf-jira/scripts/*.mjs
- plugins/adf-jira/scripts/lib/*.mjs
- plugins/adf-jira/adf-extension.json
- plugins/adf-jira/templates/**
- plugins/adf-jira/env.example
-->

# `adf-jira`

`adf-jira` provides the `tracker` role on Jira Server and Data Center, over REST v2. At propose, the core gathers the issues that a change can take. It moves the taken issues to the start status. After the merge, `/adf:land` writes one templated comment for each issue and hands it to the tester. See [the tracker role](../extension-points/contract/tracker.md).

The plugin also ships standalone Jira skills:

- `/adf-jira:bulk`
- `/adf-jira:comment`
- `/adf-jira:epic`
- `/adf-jira:setup`
- `/adf-jira:sync-debt`
- `/adf-jira:task`
- `/adf-jira:worklog`

Every write has two phases. The plugin builds a plan and shows it. It applies the plan only after the developer's yes.

## Install and enable

1. Install the plugin.
2. Enable it with its configuration.
3. Copy the env file template and set `JIRA_PAT` (see "Credentials").
4. Run `/adf-jira:setup` once.

```
claude plugin install adf-jira@agentic-dev-flow --scope project
/adf:add adf-jira@agentic-dev-flow '{"baseUrl":"https://jira.example.com","allowlist":["PROJ"],"statuses":{"initial":"Opened","start":"In Progress","handoff":"Review"}}'
```

The Codex form is on [the Codex page](../getting-started/codex.md).

`/adf-jira:setup` discovers the workflow of the project. It writes the profile that every skill and operation reads.

## Configure

The `config` object of the entry in `.claude/adf-extensions.json`. It is committed and holds nothing secret.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `JIRA_URL` from the env file | The Jira base URL, such as `https://jira.example.com`. |
| `allowlist` | `JIRA_ALLOWED_PROJECTS` from the env file | The project keys that the plugin may read and write. A plan that touches any other project is refused whole, never filtered. An empty list is refused. |
| `profileDir` | `.claude/jira/profile` | Where the profile lives: `discovered.json`, `local.md` (personal, ignored by git) and `conventions.md` (the team's, committed). |
| `debtEpic` | none | The epic that receives the mirror of the debt tree (`/adf-jira:sync-debt`): one child for each group of related entries. |
| `fields` | `[]` | Field names, as the field map of the profile spells them, that `gather` reads for each issue, for example `["Reproduce steps", "Expected result"]`. |
| `statuses` | `{ "initial": null, "start": "In Progress", "handoff": null, "excluded": [] }` | See the table below. |
| `commentTemplate` | `templates/handoff.md` of the plugin | A project file that replaces the hand-off comment template. |
| `correctionTemplate` | `templates/corrections.md` of the plugin | A project file that replaces the correction comment template of `start`. |
| `debtTemplate` | `templates/debt.md` of the plugin | A project file that replaces the description template of the issue of a debt group (`/adf-jira:sync-debt`). |
| `envFile` | `.claude/.env` | The env file of the project, relative to the main checkout. |

The keys of `statuses`:

| Key | Meaning |
|---|---|
| `initial` | The status where a new issue starts. `/adf-jira:sync-debt` edits the issue of a group only while it is in this status, and refuses to plan an edit without it. `handoff` routes a partial issue back to it. |
| `start` | The status where `start` moves an issue. |
| `handoff` | The status where `handoff` moves a taken issue. Required for a hand-off. |
| `excluded` | Statuses that keep an issue out of the scope of a change, besides the closed ones. An example is a suspended status. |

The plugin refuses an unknown key, so a typo does not pass silently. The status names are the team's. Record them in `conventions.md` too. `/adf-jira:setup` asks for them.

## Credentials

The token and the personal logins stay in the env file. Git never commits it. Copy `env.example` to `.claude/.env`, or to the path in `envFile`. Then fill in `JIRA_PAT`. The other keys are optional.

```
cp <adf-jira plugin dir>/env.example .claude/.env
git check-ignore -v .claude/.env
```

The second command checks that git ignores the file.

| Key | Use |
|---|---|
| `JIRA_PAT` | The personal access token, sent as a bearer token. Required. Create it in Jira: avatar, Profile, Personal Access Tokens, Create token. Give it a finite expiry. Jira Server and Data Center 8.14 and later support it. |
| `JIRA_ASSIGNEE` | The login of the developer: the assignee at `start`, and the reporter and assignee of the issues that the skills create. Empty: the account of the token. |
| `JIRA_QA` | The login of the tester: the assignee at `handoff`. Required for a hand-off. |
| `JIRA_PM` | The login of the project manager, for a bulk close. |
| `JIRA_GIT_AUTHOR` | The git author name of the developer, for a worklog built from commits. It is not secret: `profile.mjs` prints it as `gitAuthor`. |
| `JIRA_DEFAULT_PROJECT` | The project that a command uses when it names none. |
| `JIRA_URL`, `JIRA_ALLOWED_PROJECTS` | Used only when the config sets no `baseUrl` or `allowlist`. `JIRA_ALLOWED_PROJECTS` is a comma-separated list of project keys. |

The order of resolution is the process environment, then the env file of the project, then `~/.claude/.env`. The first non-empty value wins. The plugin reads the env file and the profile from the main checkout, so the worktree of a change uses the same ones.

The agent never reads the env file. The scripts of the plugin read it inside their own process. Their diagnostics name a variable, its layer and its length, never its value.

A plan names a login only as a placeholder: `<JIRA_ASSIGNEE>`, `<JIRA_PM>` or `<JIRA_QA>`. The apply process resolves it. The plan file keeps the placeholder. The preview prints the resolved login, which is not a secret.

## The tracker role

The core runs `node <plugin>/scripts/tracker.mjs <operation>` and writes one JSON object to stdin: `{ "root": "<host or worktree root>", "config": { ... }, "input": { ... } }`.

The plugin prints one JSON object. Its `state` is `done`, `degraded` or `refused`. A refusal carries `error`. The exit code is 0 for `done` and `degraded`, and 1 for `refused`.

| Operation | Input | Result when `done` |
|---|---|---|
| `check` | `{}` | `tool: "ready"`, `account` (the login of the token, from `/rest/api/2/myself`), `sources` (name, layer and length of each env value), `profile.discoveredAt` |
| `gather` | `keys` (issue keys), `text`, or both; `change`; `stateDir` (absolute) | `items` and `notes`; one JSON file for each issue in `stateDir` |
| `start` | `items: [{ key, corrections, answers }]`, `stateDir`; `apply` (a plan id) | without `apply`: `held: true`, `plan`, `file`, `preview`; with it: `applied` (keys), `skipped` and `failed` (`{ key, reason }`), `aborted` |
| `handoff` | `items: [{ key, state, fields }]`, `mr: { url } \| null`, `stateDir`; `apply` | as `start` |

The plugin accepts and ignores an input field that it does not use: `change`, and the `state` of an item at `start`.

With no `adf-jira` entry, the role is `none`. The core skips every tracker step and says so.

### When the check degrades

`check` is `degraded` with `tool` and `hint`. It sends nothing past the probe.

| `tool` | Cause |
|---|---|
| `missing` | No env file, or no `JIRA_PAT`. The hint names the template to copy. |
| `unauthenticated` | Jira answered 401 or 403 to `/myself`. The hint says to create a new token. |
| `unconfigured` | No `baseUrl` or `allowlist`, no profile, or a profile more than 7 days old. The hint names the config to set, or `/adf-jira:setup`. |

`gather`, `start` and `handoff` degrade the same way when the env or the profile is not ready.

### The gather operation

`gather` reads each issue that `keys` names. For a `text`, it reads the open issues of the allowlisted projects whose text matches, at most 20. It also reads one level of related issues: the parent, the sub-tasks and the linked issues. A key outside the allowlist goes into `notes` and is never fetched.

The file of an issue holds its description, all its comments, the `config.fields` values, and its parent, sub-tasks and links.

Each item is `{ key, url, kind, subtask, title, status, open, parent, subtasks, links: [{ key, relation }], named, via, branchToken, branchRank, excluded, flags, file }`.

- `kind` is `bug` (an issue type whose name contains "bug"), `sub-task`, `epic`, `story` or `task`.
- `excluded` is the reason an issue is out of scope: a closed status, or one of `statuses.excluded`. Otherwise it is `null`.
- `flags` holds one line when the latest comment of an excluded issue is newer than its move into its status. The status may be stale.
- `named` is true for a key in `keys`. With no `keys`, it is true for a hit of the text search.
- `branchToken` is the key.
- `branchRank` orders the branch key: a named sub-task first, then the lowest sub-task, then the lowest bug (a sub-bug too), then a named task.
- Among named issues, the first in `keys` wins. Only hits of the text search tie, and a tie is for the developer to decide.
- An excluded issue and an epic have a `null` rank.

### The start operation

`start` without `apply` builds a plan in `stateDir` and sends nothing. For each issue, the plan holds these rows:

1. The developer as assignee, when the issue is not assigned to the developer. This row comes first, because a workflow may offer the start transition to the assignee only.
2. The shortest route from the status of the issue to `statuses.start`.
3. For an item with `corrections`, the correction comment. It holds the corrections and the `answers` of the developer. The plugin renders it with `templates/corrections.md`, or with the file named by `config.correctionTemplate`. The template has one `<!-- corrected -->` section, and lists `corrections` and `answers`.

An item with no corrections gets no comment. The plan skips an issue with its reason when:

- the issue has no route;
- the route goes through an unsampled status;
- the screen of a hop requires a field;
- there is nothing to do.

With `apply: <plan id>`, the plan runs.

### The handoff operation

`handoff` checks the fields first. It sends nothing on an error. The rows depend on the state of the item:

| State | Fields | The rows |
|---|---|---|
| `taken` | `done`, `test` (lists); `commit` | the route to `statuses.handoff`, the comment, then the tester (`JIRA_QA`) as assignee; every action on the issue first, the assignee last |
| `partial` | `done`, `test`, `remains` (lists); `commit` | the route back to `statuses.initial`, never through `statuses.handoff`, then the comment; with no `statuses.initial`, or no such route, the comment only and the status stays, and `unmoved` in the plan names why |
| `not-reproduced` | `tried`, `commit`; `test` | as `taken`: the comment says the issue does not reproduce on that commit, and the tester retests it |

The required fields are the core's. The core sends every text field as a list of one-line texts. The plugin checks them again before it sends anything. It refuses a field that is not such a list, a text that holds a link or a URL, and a `commit` that is not a commit hash. The core checks the wording. The plugin renders the markup.

### Held plans and resume

A plan is `start-<UTC stamp>` or `handoff-<UTC stamp>`. It is a file in `stateDir`, with a digest of its rows. Before it applies a plan, the plugin refuses:

- a plan whose allowlist reaches past the configured one;
- a plan built against an older profile than the current one;
- a plan whose rows no longer match the digest, as after an edit by hand.

For a refused plan, run `start` or `handoff` again without `apply` to get a new plan.

Each write of an issue is its own row. The `step` is `transition`, `assignee` or `comment`. Each row checks the status it expects before it runs. The comment of a partial hand-off checks none.

A rerun with the same plan id resumes from the state of each row. A row that is done is not sent again. So a hand-off that failed after its transition posts only the comment. A comment row also reads the comments of the issue. It posts nothing when a comment with the same body is there. An issue that someone moved by hand since the plan was built is skipped as drifted, not failed.

The result names each issue once: `applied` when every row of it is done, `failed` when a row failed, else `skipped`. A reason starts with the step of the row. Three failures in a row stop the run. Fix the cause, then rerun the same plan.

## The hand-off comment

The script renders the comment from the fields, in Jira wiki markup, with `templates/handoff.md`. The template has one section for each state. A marker line opens each section: `<!-- taken -->`, `<!-- partial -->` or `<!-- not-reproduced -->`.

Inside a section, the plugin replaces a placeholder in double braces.

- `done`, `test`, `remains` and `tried` are lists. A line that holds one repeats once for each item.
- `commit` is the commit hash.
- `mr` is the merge request URL. Its line appears only when the core passes `mr`. The core does it only with a forge.
- A line that holds an empty value is dropped.
- A block opened by `#name` and closed by `/name`, each in double braces on its own line, stays only when the value is not empty.

The plugin escapes agent text, so a bracket or a brace opens no link or macro.

To change the comment:

1. Copy `templates/handoff.md` into the project.
2. Edit the copy.
3. Name the copy in `config.commentTemplate`.

The plugin refuses a template without the three sections, with an unknown placeholder, or with an unclosed block. Every comment then has the shape of the template of the project.

## Skills

| Skill | Does |
|---|---|
| `/adf-jira:setup` | Discovers the API facts of the project into `discovered.json`. It samples each pair of issue type and status, and recommends statuses from that record. It interviews for `conventions.md` and `local.md`, and offers to import an existing personal layer (`profile.importLocal`) instead. It refuses to write while git does not ignore the personal files. |
| `/adf-jira:bulk` | Status changes and field edits across a JQL selection. Each issue goes on its own route. |
| `/adf-jira:comment` | Writes a comment, or rewrites one by id, on one issue or on a selection. |
| `/adf-jira:epic` | An epic with its children and estimates, and the rollup read from the sum fields of Jira. |
| `/adf-jira:task` | One issue with the fields that its type requires, drafted or created. |
| `/adf-jira:worklog` | Fills worklogs by the own practice of the developer, kept in `local.md`. |
| `/adf-jira:sync-debt` | Mirrors the debt tree of the core into `config.debtEpic`, in one direction. It makes one issue for each group of related entries. The agent decides only the grouping. It writes each key back with `debt.mjs track` of the core. |

## Scripts

The skills run the scripts of the plugin:

| Script | Does |
|---|---|
| `scripts/profile.mjs [--skill <name>]` | Prints the paths of the profile, whether git ignores the personal files, the age of the profile, the non-secret config, `gitAuthor` (`JIRA_GIT_AUTHOR`, `null` when unset) and `profile.importLocal` (an existing personal layer outside the profile directory, or `null`). With `--skill`, it prints the plan directory of that skill. It reads the env file for that one value, prints no other, and calls nothing. |
| `scripts/discover.mjs [<KEY>]` | Writes `discovered.json`: for each issue type, the transitions from each status. It reads them with a GET on one issue for each pair of type and status, and prefers one assigned to the account. It keeps the transitions that the API marks conditional or unavailable. It also writes `workflow`, their union keyed by status, for the route solver. It prints the record of each type. |
| `scripts/read-issues.mjs "<JQL>" [out]` | Reads issues. A result outside the allowlist fails the read. It refuses an output path that git does not ignore, before the read. |
| `scripts/read-comments.mjs "<KEY>" [out]` | Reads every comment of an issue, with its id. It checks the allowlist before the request. |
| `scripts/apply-plan.mjs <plan> [--confirm]` | Prints the summary of the plan and records a digest of its rows. With `--confirm`, it applies the plan. It refuses a plan that git does not ignore. With `--confirm`, it also refuses a plan whose summary was never printed, or whose rows changed since. Print the summary again and show it to the developer. |
| `scripts/sync-debt.mjs state\|check-groups\|plan\|track` | The steps of `/adf-jira:sync-debt`: the groups of the tree and its keyless entries, the checked grouping, the create and edit plans, and the write-back of the keys of the applied rows. It calls no Jira. |
| `scripts/core-debt.mjs <args>` | Runs `scripts/debt.mjs` of the core with the same arguments. The core is beside this plugin in a checkout. Otherwise it is the `adf` plugin of this marketplace, found in the install records of Claude Code. |

`read-issues.mjs` and `read-comments.mjs` print JSON on stdout when you give no output path. `JIRA_READ_VERBOSE=1` adds the env diagnostics on stderr.

Each skill writes its plans under `.adf/jira/<skill>/` in the main checkout, like the env file and the profile. So the plans of `bulk`, `comment`, `epic`, `sync-debt`, `task` and `worklog` stay apart. `profile.mjs --skill <skill>` reports the directory as `plans.dir`, and reports whether git ignores it as `plans.ignored`. A plan is local and never committed. `apply-plan.mjs` refuses a plan that git does not ignore.

`/adf:init` makes git ignore `.adf/`. In a project set up before it did, add `.adf/jira/` to `.gitignore`. The plans of the tracker role stay in the state directory of the core.

## Boundaries

The plugin never deletes an issue or a comment. The engine has no delete path. The plugin:

- never writes outside the allowlist;
- never applies without the developer's yes;
- never takes a transition id from anywhere but `discovered.json`;
- never fills a required transition field on its own;
- never logs time that the developer has not confirmed.

## Points it provides

- [`tracker`](../extension-points/contract/tracker.md): the operations `check`, `gather`, `start` and `handoff`.
