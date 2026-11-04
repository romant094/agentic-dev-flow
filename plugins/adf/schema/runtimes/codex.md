# Codex tools

How the flow's words map to Codex's tools. Read it when a skill sends you here.

## Dispatch

Dispatch a subagent with `spawn_agent`. Codex does not load the plugin's agent files, so the
flow carries the level itself: `dispatch.mjs prompt` prints `reasoningEffort`, and its `prompt`
already starts with the level's text.

1. Call `spawn_agent` with `reasoning_effort` set to the printed `reasoningEffort`, and the
   printed `prompt` as the message.
2. Leave `model` unset. The flow never names a model.
3. Dispatch every agent of a round in one turn. Codex runs them in parallel.
4. Call `wait_agent` (or `wait`) for every one of them.
5. Continue an agent with `send_input`.
6. Call `close_agent` after its reply is recorded.

## Asking the developer

Ask in plain chat text: one decision per question, the options the skill names. Then end the
turn and wait for the answer. `request_user_input` exists only in Plan mode, and not in
`codex exec`: do not rely on it.

## Invoking a skill

Invoke a skill with `$<name>`, or pick it from `/skills`. A plugin's skills carry the plugin's
namespace, for example `$adf:propose`. Use the name that `/skills` shows.

## Hooks

Codex runs a plugin's hook only after the developer trusts it once in `/hooks`. A hook that is
not trusted does not run.
