<!-- sources:
- plugins/adf/contract/metrics-format.md
- plugins/adf/scripts/metrics.mjs
- plugins/adf/scripts/lib/prices.mjs
- plugins/adf/scripts/lib/registry.mjs
-->

# Metrics

The flow measures how each change ran. The measure is one record for each change. A script builds the record, and the retrospective reads the records. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## What the flow collects, and the switch

**What is collected.** Token counts, times, review rounds and dispatches of each change. A script reads them from three sources: the records of the change in `.superpowers/sdd/`, git, and the local session transcripts of the agent.

**Where it is kept.** In the repository. The record is `metrics.json` in the archived change, and the price table is in `.adf/prices/`. The project commits both.

**What leaves the machine.** Only one request: the fetch of the public model price page. The record itself goes nowhere.

**Why to keep it on.** The retrospective reads the records. With them, it finds the stages that cost much and catch nothing, and it names them as removal candidates.

The registry key `metrics.enabled` is the switch. `/adf:init` asks for it, with yes as the default. A registry without the key has metrics on, so a project set up before the switch needs no migration. `metrics.mjs switch` reads the switch, and `metrics.mjs switch --set false` turns it off.

With metrics off:

- `/adf:archive` skips its `metrics` step. It writes no record and fetches no price page, and its report says so. The `commit-metrics` step commits only the ledger copy of the change, or it is skipped when that copy is current.
- `/adf:quick` runs the same archive steps, so it writes no record either.
- `/adf:retro` says that the window has no records. A record written before the switch was turned off still counts.

## The metrics record

`/adf:archive` writes `metrics.json` in the directory of the change, in its `metrics` step, and commits it in its `commit-metrics` step. `metrics.mjs extract` builds the record from three sources:

- the records of the change in `.superpowers/sdd/`;
- the session transcripts of the agent;
- git.

The schema `schema/metrics.schema.json` checks the record. The script does not write a record that fails the schema. A `degraded` `metrics` step does not stop `/adf:archive`.

The rules of the record:

- It holds token counts, never prices.
- A value that the flow could not read is `null`, never `0`. The key `sources.coverage` names each group of the record as `"record"` or as `{ "none": "<reason>" }`.
- The git figures come from the commits between the merge base and `HEAD` of the change branch. The working tree is not read.
- A reason names the checkout as `.` and the home directory as `~`.
- One session can run several changes through dispatched agents. Then the record of a change counts only the agents that worked on that change, and the turns of the session made while they ran. The record finds these agents by the branch or the worktree of the change. When it cannot find them, every transcript group is `null`, and its coverage entry names the shared session. The retrospective also leaves out the transcript figures of an older record that counted a shared session whole.

The key `cycle` names the cycle of the change: `full` or `quick`. A record without `cycle` is a full change. For a quick change, `timing.tasks` counts the numbered steps of `quick.md`. The groups `verify` and `impl` are `null`, and their coverage entries read `quick task: no verify` and `quick task: no impl`. The phases of a quick change are `gather`, `estimate`, `code`, `tests`, `review` and `end`.

The record has these groups:

| Group | Holds |
|---|---|
| `dispatches` | One entry for each dispatched agent: its name, role, level, model, turns, tokens and active minutes. |
| `tokens` | The totals, and the buckets by actor, phase, model, level and day. |
| `timing` | The time between propose and extract, the active minutes, and the minutes for each task. |
| `autonomy` | How often the developer wrote, answered a question or cleared the session. |
| `replies`, `impl` | How many replies of each role were valid, retried or stopped, and the status of the implementers. |
| `tests` | The runs of the test suite. Optional `suiteRun`: the duration of the last whole-suite run, and the idle time from its end to the first read of its result. |
| `findings`, `review`, `verify` | The findings of each review layer, and the verdicts of review and verify. |
| `ledger`, `isolation`, `compliance` | The ledger counts, the files and worktrees outside the change, and the plan rules that were performed. |
| `maintainability` | The lines changed, by file and by capability. |

For every field, see `plugins/adf/contract/metrics-format.md`. The record reads transcripts for Claude Code only. For a change that ran in Codex, every transcript group is `null`, and its coverage entry says so.

## Prices

The record holds tokens only. The flow computes the cost when someone reads the record, from a dated price table in the project:

- The files are `.adf/prices/<YYYY-MM-DD>.json`. The project commits them.
- A file holds the rates of each model from its date on. `/adf:archive` adds a file only when the prices changed.
- The cost of a response uses the file that was in force on the UTC day of the response.

The core fetches the rates from a pricing page. The registry key `metrics.pricesUrl` sets the page. Without it, the core uses the default pricing page of the runtime. `/adf:init` does not ask for the URL. See [the registry](registry.md).

`metrics.mjs prices fetch` fetches the page by hand. A failed fetch keeps the last file. With no file at all, the fetch refuses. `metrics.mjs cost --file <record>` prices a record, and lists the models that it could not price.

## The retrospective's numbers

`/adf:retro` reads the metrics records of the changes in its window. It reports the quick changes as their own group. A script computes every number of the report. The agent that reasons over the numbers writes none of them: each figure it cites is a key that the script computed. The `window` step shows how many of the changes have a metrics record.

`metrics.mjs candidates` names the review layers and verify checks that were quiet for three archived changes in a row. The retrospective uses it for its removal candidate. See [/adf:retro](../cycle/retro.md).
