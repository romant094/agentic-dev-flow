# Iteration 10b — Maintainer plugin

## Goal

The `adf-maintainer` plugin provides the role `upstream`. A retrospective files its flow
findings and the open ADF debt as issues in the plugin's GitHub repository, after a check of
push permission and the developer's yes. The plugin is installed by the maintainer only, and
every other host skips the step. Every step is a script: the issue titles, bodies and labels
are rendered from the findings and the debt records the core passes, and the LLM writes no
text that is sent.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | Every extension is optional: a registry entry whose plugin is not installed, or is disabled, is treated as absent; `/adf:add` records the entry's `points`, the role call returns `none` naming the absent entries that recorded the point, and the step's report says the plugin is in the registry but not installed (or disabled); an entry with no `points` is named for none | `roles.spec.mjs`, `registry.spec.mjs` |
| 2 | Rename the debt kind `flow` to `adf` ("ADF debt") in the debt store, the contract, the archive instruction and the lessons; the reader accepts the old kind | `debt.spec.mjs`, `archive.spec.mjs`, `check-lessons.mjs` |
| 3 | The retrospective's window holds the ADF debt records with no Filed value; they are in the agent's input and in the report | `window.spec.mjs`, `retro.spec.mjs` |
| 4 | Contract 1.5: `upstream.check {repository}` and `upstream.file {repository, host, retro, findings, debt}`, the findings and debt records themselves, not the sidecar's path; `file` returns `issues: [{item, kind, number, url, existed}]`; the retrospective's step order start, window, reply, file, render, record, publish, remove; `file` handles a degraded or refused `check`, refuses to run after render, and takes `--findings` and `--debt` filters; after a `done` file, each debt record filed is marked with its issue's URL, and the issue links are rendered into the report | `retro-cli.spec.mjs`, `roles.spec.mjs` |
| 5 | The core's `plugin.json` names its `repository` | `manifest.spec.mjs` |
| 6 | Plugin `plugins/adf-maintainer/`: `check` (`gh` present and authenticated, `permissions.push` on the repository the core passes in the input) and `file` through `gh api`; every issue body carries a marker, `<!-- adf: <host>/<retro>/<R1> -->` for a finding and `<!-- adf: <host>/debt/<id> -->` for a debt record, and an issue that already carries it is returned with `existed: true`, not created again; titles, bodies and labels (`adf-retro` or `adf-debt`, the class, the plugin) rendered by script | `upstream.spec.mjs` with a fake `run` |
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

Refined while building, from the decisions above.

- `file` runs before render, so the sidecar does not exist yet: the `upstream.file` input
  carries the content, `{repository, host, retro, findings, debt}`, with the resolved findings
  and the debt records themselves. `check` takes `{repository}`. The core reads the repository
  from its own `plugin.json` and passes it; the plugin reads no host file.
- The markers are scoped by host: `<!-- adf: <host>/<retro>/<R1> -->` for a finding and
  `<!-- adf: <host>/debt/<id> -->` for a debt record, which a later retrospective may file.
  `host` is the host's `origin` remote path, else its root directory's name.
- `/adf:add` records each registry entry's `points`; an absent entry is named only for the
  points it recorded. A disabled plugin is absent too.

## Result

- `npm test`: 926 tests, 925 pass, 0 failures, 1 skipped (the live openspec parity, with
  `OPENSPEC_DIST` not set); `check-lessons.mjs`: ok, 765 rows, 40 pending, none on 10b.
- `npm run parity -- <origin>`: 21 of 21 PASS after two fixes. `origin-ledger.mjs` explains
  the renamed resolution (`renamed-resolution`, 29 cases). `origin-window.mjs` found a port
  defect that new origin data exposed: a merge carrying two changes charged each with the
  other's files outside the plan; the port now reports null there, as the origin does.
- A test sends the core's `file` input to the real plugin with a fake `gh` and reads the result
  in the core's report: the shapes match.
- The contract change is a minor one although `upstream.file` changed its input: no provider
  existed under 1.4.
- Not run: `gh` against the real repository (`gh` is not installed on the build machine; the
  `labels[]=` field syntax needs `gh` 2.20 or later), `claude plugin validate .`.
- Open: the English check's `retro.mjs` entry names `.adf/retro` only, so it does not read
  the debt index the retrospective now commits (the index gets only issue URLs).
- Versions: adf 0.12.0, adf-maintainer 0.1.0, contract 1.5; gitlab 0.3.0, memory 0.1.0,
  english-check 0.5.0 unchanged.
