<!-- sources:
- plugins/adf-maintainer/scripts/*.mjs
- plugins/adf-maintainer/scripts/lib/*.mjs
- plugins/adf-maintainer/adf-extension.json
-->

# `adf-maintainer`

`adf-maintainer` provides the `upstream` role on GitHub, through the [`gh`](https://cli.github.com) CLI. A retrospective files its flow findings and the open ADF debt as issues in the GitHub repository of the flow. The core calls it. You do not run it by hand.

Only the maintainer of the flow installs this plugin. Every other project has no `upstream` provider. Its retrospective skips the step, and the findings stay in the sidecar of the retrospective.

## What it does

| Operation | Does |
|---|---|
| `check` | Reports whether `gh` is installed and logged in. It gives the install or login command when it is not. It reads the repository with `gh api repos/<owner>/<name>` and refuses when the account has no push permission on it. |
| `file` | Runs the check and makes sure the labels exist. It finds the issues already filed by their marker. It creates an issue for every other finding and debt record. It returns `issues`: `{ item, kind, number, url, existed }` for each item. |

The repository is the `repository` field of the input. The core takes it from its own `plugin.json`. Without push permission on the repository, nothing is sent.

When `gh` is missing or not logged in, both operations degrade. Nothing is sent. The result carries a `hint` and a `fallback`, which is the install or login command. Run it, then rerun the file step of the retrospective.

## Install and enable

```
claude plugin install adf-maintainer@agentic-dev-flow --scope project
/adf:add adf-maintainer@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md).

## Configure

The plugin takes no configuration.

## Credentials

The plugin never reads or stores a token. `gh` keeps its own credentials. Run `gh auth login`, or set `GH_TOKEN` in the environment where `gh` runs.

## What is sent

The script renders every title, body and label from the fields of the items. No other text is sent.

- Title: `[<plugin>] <title>`. A finding with no plugin has the title `[adf] <title>`.
- Body: the body of the item, then a list of its facts, then the marker.
  - A finding lists its class, changes, evidence, cost, where it was caught, plugin and version, host and retrospective.
  - A debt record lists its class, plugin and version, change, source and host.
- Labels: `adf-retro` for a finding and `adf-debt` for a debt record. The class, in lower case with dashes for spaces: `deferred wording` is `deferred-wording`. `plugin:<name>` when the item names a plugin. The plugin creates a missing label and keeps one that exists.

## The marker

The last line of every body is an HTML comment that names the item:

- a finding: `<!-- adf: <host>/<retro id>/<finding id> -->`;
- a debt record: `<!-- adf: <host>/debt/<debt id> -->`. Debt has no retrospective in its key, because a later retrospective may file the same record.

Before it creates anything, `file` lists the `adf-retro` and `adf-debt` issues of the repository, open and closed. An item whose marker is already on one of them comes back with `existed: true`. The plugin does not file it again.

When a create fails midway, the refusal names the issues created and the items not created; a rerun files only the missing ones.

## Calling convention

The core runs `node <plugin>/scripts/upstream.mjs <operation>` and writes one JSON object to stdin: `{ "root": "<host root>", "config": {}, "input": { ... } }`.

The plugin prints one JSON object. Its `state` is `done`, `degraded` or `refused`. A refusal carries `error`. The exit code is 0 for `done` and `degraded`, and 1 for `refused`.

| Operation | Input |
|---|---|
| `check` | `{ repository: "owner/name" }` |
| `file` | `{ repository, host, retro, findings, debt }` |

A finding is `{ id, title, class, changes, evidence, cost, caughtWhere, plugin, version, body }`. A debt record is `{ id, title, plugin, pluginVersion, change, class, source, body }`.

The plugin refuses an unknown or missing field before any call. With no findings and no debt, `file` is done with `issues: []` and calls nothing.

## Points it provides

- [`upstream`](../extension-points/contract/upstream.md): the operations `check` and `file`.
