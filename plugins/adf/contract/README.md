# The ADF Extension Contract

The contract is what the ADF core promises a plugin, and what it expects back. The core never
names a plugin: it reads the project registry and calls whatever the enabled plugins declare.

## Files

| File | Holds |
|---|---|
| `contract.json` | the contract version and the points it defines, each with its kind, the version that added it (`since`), its operations, and the version of each operation added after the point (`operationSince`) |
| `README.md` | the format, the calling convention, and every point's input and output |

## Points

A point is a named place in the flow where the core calls plugins. There are two kinds:

- **hook**: the core calls every enabled plugin that provides it, in registry order. Each
  plugin gets only its own items. A plugin that does not provide the hook is skipped; that is
  not an error.
- **role**: at most one enabled plugin provides it. With no provider, the core runs its own
  default, which the point's documentation states.

A plugin declares, per point, the `script` that runs it (deterministic, runs under any agent
runtime) and the `operations` it implements: every operation the point defined at the contract
version the plugin names. An operation added later is optional for it: the core treats it as not
provided.

Each point arrives with the first plugin that needs it. Version `1.0` defined none; `1.1` adds
the `forge` role; `1.2` adds its `push` operation; `1.3` adds the `knowledge` role; `1.4` adds
the `forge` operations' `ci` field and the `upstream` role; `1.5` gives `upstream` its content:
`check` takes the repository, and `file` takes the findings and the ADF debt themselves; `1.6`
adds the first hooks, `provision`, `teardown` and `verify-check`; `1.7` adds the `tracker` role
and the `forge` operation `state`, and checks a declaration against the operations of its own
contract version.

## Calling convention

The core runs `node <plugin dir>/<script> <operation>` with the working directory set to the
host root (a change's worktree, when the change has one) and writes one JSON object to stdin:

```json
{ "root": "<absolute host root>", "config": { "...": "the registry entry's config, or {}" }, "input": { } }
```

The script prints one JSON object on stdout. Its `state` is:

- `done`: the operation happened;
- `degraded`: the plugin's tool is missing or not authenticated; nothing was sent, and the
  result says what to run (`hint`, `fallback`). Exit 0: the flow continues and says so;
- `refused`: an input or a call failed; `error` says which, and what was or was not sent.
  Exit 1.

A script that prints no such object is treated as `refused`. With no provider of a role the
core gets `{ "state": "none" }` and applies the role's default. A provider written for a contract
before an operation was added, which does not declare it, is not called for it: the core gets
`{ "state": "none", "point", "operation", "reason": "not-provided", "plugin" }` and applies the
operation's default, as with no provider. A hook point has one operation,
named like the point. The core calls its providers one after another: the hook's state is
`done` when every provider is done, `degraded` when one is degraded and none refused, and
`refused` at the first provider that refuses, after which no provider is called; with no
provider it is `none`. Every extension is optional: a
registry entry whose plugin is not installed or is disabled is treated as absent. When it is
the point's only provider, the result is `none` with `absent` (`[{ id, reason }]`, `reason`
`not-installed` or `disabled`) naming it, and the report says the step was skipped.

## Points

### `forge` (role, since 1.1; `push` since 1.2; `ci` since 1.4; `state` since 1.7)

Pushes the change branch and keeps its merge request. The core never names a forge.

| Operation | Input | Result when `done` |
|---|---|---|
| `check` | `{}` | `tool: "ready"`; degraded: `tool` is `missing` or `unauthenticated`, with `hint` |
| `open` | `change`, `branch`, `base`, `title`, `draft` (default true), `protected` | the branch pushed, never forced; a merge request into `base`, reused when one is open: `number`, `url`, `reused` |
| `push` (since 1.2) | `change`, `branch`, `protected` | the branch pushed, never forced; nothing else changes |
| `finalize` | `change`, `branch`, `base`, `title`, `body`, `protected` | the description holds `body` in this change's block, other text kept; the merge request leaves draft, then the branch is pushed: `number`, `url` |
| `state` (since 1.7) | `change`, `branch`, `base`, `url` (optional: the merge request archive recorded, preferred to the branch) | the merge request's state, nothing sent: `number`, `url`, `status` (`open`, `draft`, `merged` or `closed`), and when merged `mergedAt` and `mergeCommit`; degraded as `check` |

`open`, `push` and `finalize` take an optional `ci` (boolean, since 1.4, default `true`).
`ci: false` pushes with no CI run: the provider asks the forge to start no pipeline for each
push the operation does. A provider whose forge cannot skip CI on a push refuses (`refused`,
exit 1) with nothing sent. Skipping CI is this field only, never a marker in a title, a
description or a commit message.

A provider refuses a branch that is empty or in `protected`. `body` holds the sections of the
plugin's merge request template. Default with no provider: nothing is pushed, no merge request
exists; archive offers to merge the change into its base, and merges only on the developer's yes.
The default of `state`, with no provider or with one written before 1.7: the hand-off after the
merge decides "merged" from git ancestry, the branch tip an ancestor of the local base or of
`origin/<base>`, with nothing fetched.

### `knowledge` (role, since 1.3)

The project's knowledge base: what the core reads before it designs, and where archive puts
what a change taught. The core never names a knowledge base path; it reads them from `context`.

| Operation | Input | Result when `done` |
|---|---|---|
| `context` | `{}` | `index`: the host-relative path of the knowledge base's index; `instructions`: `{ ingest, query, lint, fix }`, absolute paths of the instructions each workflow follows; `paths`: globs relative to the host root, every path an ingest may write; `log` (optional): globs of the files only the `log` operation writes, which archive's ingest check leaves out of the pages and refuses an agent's edit to |
| `log` | `type` (`ingest`, `query`, `lint` or `task`), `title`, and either `bullets` (a list of strings) or `commit` (one or more hashes) with `reason`; `amend` (optional, boolean) | one log entry written, after the provider's own housekeeping (a rotation): `entry`, the text written; `rotated`, the months moved out of the log (`[]` when none); `amended`, whether it replaced an uncommitted entry of the same title. `amend` with no such entry is refused |
| `check` | `{}` | `findings`: a list of `{ kind, path, ... }`, the mechanical faults of the knowledge base; `[]` when none |

The provider states its own time rule; the core passes no time. Verify's out-of-plan check
allows every path `paths` names, so an ingest no plan names is not a finding. Default with no
provider: brainstorm reads no index, archive skips the ingest and says so in its report, and
no log entry is written.

### `upstream` (role, since 1.4; content since 1.5)

Where a retrospective's flow findings are filed, outside the host project: the issue tracker
of the flow itself. The core never names a tracker. The repository is the `owner/name` path of
the `repository` URL in the core's own `plugin.json`, read by the core and passed in.

| Operation | Input | Result when `done` |
|---|---|---|
| `check` | `repository`: `owner/name` | `tool: "ready"`, the repository reachable and writable; degraded: `tool` is `missing` or `unauthenticated`, with `hint`; refused: no push permission, with `error`, nothing sent |
| `file` | `repository`; `host`: the host's `origin` remote path (`owner/name`, from an https or ssh URL), else its root directory's name; `retro`: the retrospective's id; `findings`: the resolved findings, each `{ id, title, class, changes, evidence: [{ key, value }], cost: { key, value } \| null, caughtWhere, plugin, version, body }`; `debt`: the ADF debt records, each `{ id, title, plugin, pluginVersion, change, class, source, body }` | `issues`: a list of `{ item, kind, number, url, existed }`, one per item filed: `item` the finding or record id, `kind` `finding` or `debt`, `existed` true when an issue for the item was already there and was returned, not created |

The core sends the content; the provider reads no host file. The core calls `check` before
anything else and sends `file` only on a `done` check and the developer's yes. A rerun of
`file` after a failure is safe: the provider finds the issue filed before for each item and
returns it with `existed: true`. After a `done` file, the core marks each debt record filed
with its issue's URL. Default with no provider: nothing is filed, the findings stay in the
retrospective's sidecar and the ADF debt stays unfiled. No provider existed under 1.4, whose
`file` took the sidecar's path and the finding ids; a 1.4 declaration still runs, by the
minor rule, and gets the 1.5 input.

### `tracker` (role, since 1.7)

The host project's issue tracker: what propose gathers and starts, and what is handed to the
tester after the merge. The core never names a tracker, its statuses or its markup. Every
operation's `stateDir` is an absolute directory in the main checkout the core owns and git
ignores, `<main>/.superpowers/sdd/<change>/tracker/`, where the provider keeps its files and
plans, so they outlive the worktree.

| Operation | Caller and moment | Input | Result when `done` |
|---|---|---|---|
| `check` | `scope.mjs gather`, and the hand-off after the merge, before any other tracker call | `{}` | `tool: "ready"`, `account`; degraded: `tool` is `missing`, `unauthenticated` or `unconfigured`, with `hint`; never a secret value |
| `gather` | propose, in the main checkout, before the branch | `keys` (a list) or `text`, `change`, `stateDir` | `items`: `[{ key, url, kind, title, status, open, parent, links: [{ key, relation }], branchToken, branchRank, excluded, flags, file }]`, `file` a file under `stateDir` holding the issue's description, comments and fields; `notes` |
| `start` | propose, after the branch and the worktree exist; held | `items: [{ key, state, verdict, corrections, answers }]`, `change`, `stateDir`, `apply` | without `apply`: `held: true`, `plan` (its id), `preview` (lines); with `apply: <plan id>`: `applied`, `skipped`, `failed`, each a list of keys or of `{ key, reason }` |
| `handoff` | the hand-off after the merge, and `scope.mjs retest`; held | `items: [{ key, state, fields }]`, `state` `taken`, `partial` or `not-reproduced`; `mr: { url } \| null`; `change`, `stateDir`, `apply` | as `start`. `taken` and `not-reproduced`: the comment, the hand-off status and the tester; `partial`: the comment only |

`kind` is one of `bug`, `sub-task`, `epic`, `story` or `task`, the provider's mapping of the
issue type; `bug` triggers the core's bug check, which needs a reproduction and the expected
behaviour. `branchRank` orders the items for the branch name
(the lowest names it, `branchToken` the text put in it), null for an item that never names a
branch. `excluded` is the provider's reason an item is out (a suspended or closed issue), else
null. `flags` are lines the developer is shown once.

`fields` are an agent's plain text, checked by the core (`lib/tracker.mjs`), never markup. The
provider renders its own comment from them with its own template, and adds the merge request
line only when `mr` is not null: the core passes the `url` of the forge's `state`, and `null`
with no forge.

| `state` | Fields | Word limit |
|---|---|---|
| `taken` | `done`: what the change did; `test`: how a tester checks it | `done` 80, `test` 120 |
| `partial` | `done`, `test`, and `remains`: what the change left undone | `remains` 80 |
| `not-reproduced` | `tried`: the attempts, a list of lines; and `commit`, the base commit, set by the core | `tried` 80 over all its lines |

The core refuses a missing or empty field, a field the state does not take (`remains` on a
`taken` item), a field over its limit, and a link or URL in any field: a scheme such as
`https://`, a `www.` host, or Markdown link syntax. `handoff` is called once every in-scope
issue has its fields.

Every write holds for the developer's yes: the core calls `start` and `handoff` without `apply`,
shows the preview, and calls again with `apply` only on the yes. A call again with the same
`apply` resumes from the plan's own state; an issue moved by hand meanwhile is `skipped`, not
failed. `refused` sends nothing: an input error, an issue outside what the provider may touch,
or a stale plan, which the core rebuilds by calling without `apply`.

Default with no provider: `gather` returns no item, and the scope holds only the core's own
sources, the debt store and the changes in flight; `start` and `handoff` are skipped, and the
verify key check maps no tracker key; each report says "no tracker plugin is enabled; the tracker
step was skipped". After a `degraded` check the developer may skip the tracker for one change;
the scope records it once, and every later tracker step skips and says so.

### `provision` (hook, since 1.6)

Prepares a worktree the core made, before anything runs in it. The core makes four kinds: the
change's worktree, a task group's, the throwaway worktree of the change's base that tells a
pre-existing failure from a new one (`base-check`), and the throwaway worktree of a test-first
proof (`proof`). Before the call, the core copies into the worktree the untracked files the
planning guide's `## Worktree copies` names, from the main checkout, where the worktree holds
none and git ignores the path, never through a link.

| Input | Result when `done` |
|---|---|
| `worktree`, `main` (absolute paths); `kind`: `change`, `group`, `base-check` or `proof`; `change`; `branch` (null when detached); `base`: `{ ref, commit }`; `files`: the paths the plan names; `needs`: the words of the plan's `**Needs:**` line and the developer's `--need`, for a `change` or `group` worktree, else `[]` | `actions`: `[{ op, path }]`; `notes`: lines the core shows the orchestrator |

A provider whose tool is missing is `degraded`, with `hint`: the step continues and says so.
`refused` stops the step. A provider writes only paths git ignores in the worktree, never the
main checkout: the core compares both trees' `git status --porcelain` before and after the call,
and refuses on any difference. A call is re-runnable: a second call changes nothing a first one
made. Default with no provider: the copies are made and nothing else.

### `teardown` (hook, since 1.6)

Releases what `provision` made, before the core runs `git worktree remove`, while the worktree
still exists.

| Input | Result when `done` |
|---|---|
| `worktree`, `main`, `kind`, `change`, `branch` (null when detached) | `actions`, `notes`; nothing to do is `done` |

`refused` stops the removal: the worktree stays and the refusal is reported. `degraded`
continues the removal with its hint. Default with no provider: the worktree is removed.

### `verify-check` (hook, since 1.6)

A check of the project's own that verify runs after the core's checks.

| Input | Result when `done` |
|---|---|
| `change`; `base`: `{ ref, commit }`; `head`: the commit verified; `files`: the paths `base...head` changed | `checks`: `[{ id, title, verdict, summary, text }]`, `id` kebab-case, `verdict` `pass`, `warn`, `fail` or `not-run` |

Each check is a section of the verify record, id `ext:<plugin>:<id>`, `text` its output; the
developer may rule on it like a core check. A provider that refuses, is degraded or returns a
malformed check gets a `not-run` section `ext:<plugin>:verify-check` saying so. Default with no
provider: no section.

## Versioning

The version is `major.minor`.

- Adding a point, an operation or an optional field raises the **minor** version. Existing
  plugins keep working: `contract.json` records the version of each operation added after its
  point (`operationSince`), and a plugin must implement only the operations of its own version.
- Changing the meaning of a point, or adding or changing a required field, raises the **major**
  version.

A plugin names the version it was written for. The core runs a plugin when the majors are equal
and the core's minor is at least the plugin's. Otherwise `/adf:add` and every check refuse the
plugin and name both versions.

## The registry

`.claude/adf-extensions.json` in the host project, committed:

```json
{
  "contract": "1.5",
  "branches": { "integration": "develop", "protected": ["develop", "main"] },
  "extensions": [
    { "plugin": "adf-gitlab@agentic-dev-flow", "points": ["forge"], "config": { "host": "gitlab.example.com" } },
    { "path": "plugins/local-draft", "points": [] }
  ]
}
```

An entry names an installed plugin by id (`plugin`), or a plugin directory by `path` (a plugin
in development). A `path` entry carries the contract's points only: Claude Code loads a plugin's
own hooks, commands and skills only from a plugin installed by id. An id is resolved from Claude Code's install records for the main checkout,
so it survives a plugin update and works in every worktree. The order of `extensions` is the
call order for hooks; a role has at most one provider. `points` is written by `/adf:add` from
the declaration's `provides`: it lets the core name an absent entry for the points it provides
without reading its declaration. An entry with no `points` (written before they were) is named
for no point, and the registry check still warns about it. `config` is opaque to the core and is
passed to the plugin's operations.

`metrics.pricesUrl` (optional) is the page archive fetches the model price table from, an http
or https URL; without it the core uses its default, and `/adf:init` does not ask for it:

```json
{ "metrics": { "pricesUrl": "https://platform.claude.com/docs/en/about-claude/pricing.md" } }
```

## The core's host directory

`.adf/` in the host project holds the core's own directories, committed and never ignored:

- `.adf/prices/<YYYY-MM-DD>.json`: the dated price table, one entry per change of prices
  (`metrics-format.md`), written by archive's `metrics` step.
- `.adf/retro/<id>.md` and `.json`, the id `<YYYY-MM-DD>-window`, `<YYYY-MM-DD>-period` or
  `<YYYY-MM-DD>-<change>`: each retrospective's report and its sidecar; the newest window
  sidecar on the integration branch starts the next window.

Everything else in `.adf/` is the extension plugins' local work directory, in the main
checkout and never committed: a plugin keeps its local files in a directory of its own there
(`adf-jira` in `.adf/jira/`). `/adf:init` adds `.adf/*` to `.gitignore`, followed by
`!.adf/prices/` and `!.adf/retro/`, which re-include the core's directories; a plugin refuses
to write there while git does not ignore the path.

## The declaration

`adf-extension.json` at the plugin root:

```json
{
  "name": "gitlab",
  "contract": "1.4",
  "provides": {
    "forge": { "script": "scripts/forge.mjs", "operations": ["check", "open", "push", "finalize"] }
  },
  "hostFiles": [
    { "from": "templates/merge_request.md", "to": ".gitlab/merge_request_templates/adf.md" }
  ]
}
```

`hostFiles` (optional, since 1.1) are copied into the host by `/adf:add` when missing; a host
that edited its copy keeps it.
