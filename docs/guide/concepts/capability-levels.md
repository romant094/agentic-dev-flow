<!-- sources:
- plugins/adf/scripts/dispatch.mjs
- plugins/adf/scripts/lib/dispatch.mjs
- plugins/adf/agents/**
- plugins/adf/schema/runtimes/claude-code.md
- plugins/adf/schema/runtimes/codex.md
- plugins/adf/schema/instructions/apply.md
-->

# Capability levels

The flow sends work to subagents. It sorts every dispatch into one of three capability levels. The level sets the effort and the turn ceiling of the agent. The runtime chooses the model for a level. The flow text never names a model or a vendor.

## The levels

| Level | Effort | Turn ceiling | Takes |
|---|---|---|---|
| `mechanical` | low | 120 | Work with a complete specification whose result the flow checks itself: a diff that is reviewed afterwards, a search, an inventory, a move, formatting. |
| `integration` | medium | 200 | Integration and debugging work, tasks that the plan marks `integration`, investigations that read several files, the reuse sweep. |
| `architecture` | high | 300 | Architecture, adjudication, whole-branch review, the spec merge at archive, tasks that the plan marks `architecture`. |

The turn ceiling is an emergency stop, not a budget. An agent that reaches it returns its work marked partial, and the orchestrator can resume it.

The mechanical level never takes a claim that nobody re-checks, such as "committed" or "the suite is green". Such a claim goes one level up.

## Which dispatch gets which level

Each task of `plan.md` carries a `**Level:**` line with one of the three levels. The flow refuses a task without it.

| Dispatch | Level |
|---|---|
| A task's implementer | The task's level. |
| A task's review and re-review | The task's level, but at least `integration`. |
| A task's fix, round 1 | The task's level. |
| A task's fix, round 2 and later | One level above the task's level. |
| A merge review of a group, the final review | `architecture`. |
| A fix or re-review after a merge review or the final review | `integration`. A fix from round 2 on goes one level up. |
| The reuse sweep, an investigation | `integration`. |
| Verify check `c4` | `architecture`. |
| Verify check `c8` | `integration`. |
| `/adf:review`: the reviewer | `architecture`. |
| `/adf:review`: a fixer | `integration`. A fixer from round 2 on goes one level up. |
| `/adf:archive`: the spec merge adjudication and the ingest | `architecture`. |
| `/adf:retro`: the retrospective agent | `architecture`. |
| The scope check of `/adf:propose`, the estimate of a quick task, the hand-off comment of `/adf:land` | `integration`. |

The level above `architecture` is `architecture`.

For the stages, see [the main cycle](../cycle/README.md).

## How a dispatch names its agent

A script, `dispatch.mjs plan`, gives each dispatch a fixed name, its level and the worktree it runs in. The metrics read the role, the task and the round from the name. See [Metrics](metrics.md).

- In Claude Code, the agent is `adf:<level>`. The plugin ships one agent file for each level in `plugins/adf/agents/`.
- In Codex, the plugin's agent files do not load. The dispatch carries the level itself: a `reasoningEffort` value and a prompt that starts with the text of the level. See [the Codex page](../getting-started/codex.md).

An agent that dispatches agents chooses the level that its work needs.
