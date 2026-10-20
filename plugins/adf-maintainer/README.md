# ADF maintainer upstream

This plugin provides the `upstream` role of the ADF extension contract (version 1.5) on
GitHub, through the [`gh`](https://cli.github.com) CLI. A retrospective files its flow findings
and the open ADF debt as issues in the flow's own GitHub repository. The ADF core calls it; you
do not run it by hand.

Only the flow's maintainer installs this plugin. Every other host has no `upstream` provider,
and its retrospective skips the step: the findings stay in the retrospective's sidecar.

## What it does

| Operation | Does |
|---|---|
| `check` | Reports whether `gh` is installed and logged in, with the install or login command when it is not. Reads the repository (`gh api repos/<owner>/<name>`) and refuses when the account has no push permission on it. |
| `file` | Runs the check, makes sure the labels exist, finds the issues already filed by their marker, and creates an issue for every other finding and debt record. Returns `issues`: `{ item, kind, number, url, existed }` for each item. |

The repository is the `repository` field of the input: the core takes it from its own
`plugin.json`. Without push permission on it, nothing is sent.

When `gh` is missing or not logged in, both operations degrade: nothing is sent, and the result
carries a `hint` and a `fallback` (the install or login command). Run it, then rerun the
retrospective's file step.

## Credentials

The plugin never reads or stores a token. `gh` keeps its own credentials: run `gh auth login`,
or set `GH_TOKEN` in the environment `gh` runs in.

## What is sent

Every title, body and label is rendered by the script from the items' fields; no other text is
sent.

- Title: `[<plugin>] <title>`; a finding with no plugin is titled `[adf] <title>`.
- Body: the item's body, then a list of its facts (a finding: class, changes, evidence, cost,
  where it was caught, plugin and version, host, retrospective; a debt record: class, plugin and
  version, change, source, host), then the marker.
- Labels: `adf-retro` for a finding and `adf-debt` for a debt record, the class (lower case,
  spaces as dashes: `deferred wording` is `deferred-wording`), and `plugin:<name>` when the item
  names a plugin. A missing label is created; one that exists is kept.

## The marker

The last line of every body is an HTML comment that names the item:

- a finding: `<!-- adf: <host>/<retro id>/<finding id> -->`;
- a debt record: `<!-- adf: <host>/debt/<debt id> -->`. Debt is keyed without the retrospective,
  since a later retrospective may file the same record.

Before it creates anything, `file` lists the repository's `adf-retro` and `adf-debt` issues,
open and closed, and returns an item whose marker is already on one with `existed: true`
instead of filing it again. When a create fails midway, the refusal names the issues created and
the items not created; a rerun files only the missing ones.

## Calling convention

The core runs `node <plugin>/scripts/upstream.mjs <operation>` and writes one JSON object to
stdin: `{ "root": "<host root>", "config": {}, "input": { ... } }`. The plugin prints one JSON
object with `state` set to `done`, `degraded` or `refused` (with `error`). The exit code is 0 for
`done` and `degraded`, 1 for `refused`.

| Operation | Input |
|---|---|
| `check` | `{ repository: "owner/name" }` |
| `file` | `{ repository, host, retro, findings, debt }`; a finding is `{ id, title, class, changes, evidence, cost, caughtWhere, plugin, version, body }`, a debt record `{ id, title, plugin, pluginVersion, change, class, source, body }` |

An unknown or missing field is refused before any call. With no findings and no debt, `file`
is done with `issues: []` and calls nothing. The plugin takes no configuration.
