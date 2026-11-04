# Claude Code tools

How the flow's words map to Claude Code's tools. Read it when a skill sends you here.

## Dispatch

Dispatch a subagent with the Agent tool. Set `subagent_type` to the `agent` that
`dispatch.mjs plan` or `dispatch.mjs prompt` prints (`adf:<level>`), and pass the printed
`prompt` as the prompt. Dispatch every agent of a round in one message. Read each reply from
its result, or continue an agent with SendMessage.

## Asking the developer

Ask with the AskUserQuestion tool. Put one decision in one question, and offer the options the
skill names.

## Invoking a skill

A skill is `/adf:<name>`, for example `/adf:propose`. Invoke one with the Skill tool, or the
developer types it.

## Hooks

The plugin's hooks run as soon as the plugin is enabled. They need no trust step.
