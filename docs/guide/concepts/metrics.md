<!-- sources:
- plugins/adf/contract/metrics-format.md
- plugins/adf/scripts/metrics.mjs
- plugins/adf/scripts/lib/prices.mjs
-->

# Metrics

The flow measures how each change ran. The measure is one record for each change. A script builds the record, and the retrospective reads the records. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## The metrics record

`/adf:archive` writes `metrics.json` in the directory of the change, in its `metrics` step, and commits it in its `commit-metrics` step. `metrics.mjs extract` builds the record from three sources:

- the records of the change in `.superpowers/sdd/`;
- the session transcripts of the agent;
- git.

The schema `schema/metrics.schema.json` checks the record. A record that fails the schema is not written. A `degraded` `metrics` step does not stop `/adf:archive`.

The rules of the record:

- It holds token counts, never prices.
- A value that the flow could not read is `null`, never `0`. The key `sources.coverage` names each group of the record as `"record"` or as `{ "none": "<reason>" }`.
- The git figures come from the commits between the merge base and `HEAD` of the change branch. The working tree is not read.
- A reason names the checkout as `.` and the home directory as `~`.

The record has these groups:

| Group | Holds |
|---|---|
| `dispatches` | One entry for each dispatched agent: its name, role, level, model, turns, tokens and active minutes. |
| `tokens` | The totals, and the buckets by actor, phase, model, level and day. |
| `timing` | The time between propose and extract, the active minutes, and the minutes for each task. |
| `autonomy` | How often the developer wrote, answered a question or cleared the session. |
| `replies`, `impl` | How many replies of each role were valid, retried or stopped, and the status of the implementers. |
| `tests` | The runs of the test suite. |
| `findings`, `review`, `verify` | The findings of each review layer, and the verdicts of review and verify. |
| `ledger`, `isolation`, `compliance` | The ledger counts, the files and worktrees outside the change, and the plan rules that were performed. |
| `maintainability` | The lines changed, by file and by capability. |

For every field, see `plugins/adf/contract/metrics-format.md`. The record reads transcripts for Claude Code only. For a change that ran in Codex, every transcript group is `null`, and its coverage entry says so.

## Prices

The record holds tokens only. The cost is computed when someone reads the record, from a dated price table in the project:

- The files are `.adf/prices/<YYYY-MM-DD>.json`. The project commits them.
- A file holds the rates of each model from its date on. `/adf:archive` adds a file only when the prices changed.
- The cost of a response uses the file that was in force on the UTC day of the response.

The core fetches the rates from a pricing page. The registry key `metrics.pricesUrl` sets the page. Without it, the core uses the default pricing page of the runtime. `/adf:init` does not ask for the URL. See [the registry](registry.md).

`metrics.mjs prices fetch` fetches the page by hand. A failed fetch keeps the last file. With no file at all, the fetch is refused. `metrics.mjs cost --file <record>` prices a record, and lists the models that it could not price.

## The retrospective's numbers

`/adf:retro` reads the metrics records of the changes in its window. A script computes every number of the report. The agent that reasons over the numbers writes none of them: each figure it cites is a key that the script computed. The `window` step shows how many of the changes have a metrics record.

`metrics.mjs candidates` names the review layers and verify checks that were quiet for three archived changes in a row. The retrospective uses it for its removal candidate. See [/adf:retro](../cycle/retro.md).
