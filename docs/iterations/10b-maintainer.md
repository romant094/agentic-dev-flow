# Iteration 10b — Maintainer plugin

## Goal

The `adf-maintainer` plugin provides the role `upstream`. A retrospective files its flow
findings and the open ADF debt as issues in the plugin's GitHub repository, after a check of
push permission and the developer's yes. The plugin is installed by the maintainer only, and
every other host skips the step. Every step is a script: the issue titles, bodies and labels
are rendered from the retrospective's sidecar and the debt records, and the LLM writes no text
that is sent.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Every extension is optional: a registry entry whose plugin is not installed is treated as absent; the role call returns `none` with the plugin named, and the step's report says the plugin is in the registry but not installed | `roles.spec.mjs`, `registry.spec.mjs` |
| 2 | Rename the debt kind `flow` to `adf` ("ADF debt") in the debt store, the contract, the archive instruction and the lessons; the reader accepts the old kind | `debt.spec.mjs`, `archive.spec.mjs`, `check-lessons.mjs` |
| 3 | The retrospective's window holds the ADF debt records with no Filed value; they are in the agent's input and in the report | `window.spec.mjs`, `retro.spec.mjs` |
| 4 | Contract 1.5: `upstream.file {report, findings, debt}`; the retrospective's step order start, window, reply, file, render, record, publish, remove; `file` handles a degraded or refused `check`; after a `done` file, `debt.mjs mark-filed` for each debt record filed, and the issue links rendered into the report | `retro-cli.spec.mjs`, `roles.spec.mjs` |
| 5 | The core's `plugin.json` names its `repository` | `manifest.spec.mjs` |
| 6 | Plugin `plugins/adf-maintainer/`: `check` (`gh` present and authenticated, the repository from the core's manifest, `permissions.push`) and `file` through `gh api`; every issue body carries the marker `adf-retro: <retro id>/<item id>`, and an issue that already carries it is returned, not created again; titles, bodies and labels (`adf-retro`, the class, the plugin) rendered by script | `upstream.spec.mjs` with a fake `run` |
| 7 | `check-lessons.mjs` keys an iteration with a letter suffix apart from its number | `check-lessons` test |
| 8 | Lessons rows, the plugin's README, the marketplace; versions adf 0.12.0, adf-maintainer 0.1.0, contract 1.5 | `npm test`, `npm run parity -- <origin>` |

## Decisions

Settled by the developer on 2026-10-20.

- Every extension is optional. A role whose plugin is absent, or in the registry but not
  installed, is skipped; the core never fails for a missing plugin.
- The plugin calls GitHub through `gh api`. It never reads or stores a token: `gh auth login`
  or `GH_TOKEN` gives `gh` its credentials.
- The target is always the plugin's own repository, named by the `repository` field of the
  core's `plugin.json`. Without push permission on it nothing is sent.
- "Flow debt" is renamed "ADF debt", kind `adf`. The retrospective collects the ADF debt not
  yet filed, and its `file` step files the findings and the debt in one call. There is no other
  command that files debt.
- The core's hold is the two-phase confirmation: `retro.mjs file` without `--yes` prints what
  would be sent, and the developer's yes reruns it with `--yes`. The plugin asks nothing more.
- A marker in every issue body makes `file` safe to rerun after a partial failure.
- `file` runs before the report is rendered and committed, so the issue links and the debt's
  Filed column land in the retrospective's commit.
- No parity tool: the origin files nothing upstream.
