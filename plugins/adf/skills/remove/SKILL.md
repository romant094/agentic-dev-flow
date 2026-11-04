---
name: remove
description: Disable an ADF plugin in this project. Triggers may be phrased in any language.
argument-hint: <plugin name or id>
---
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.


Disable the plugin named in the arguments, by its name (`adf-jira`) or its id
(`adf-jira@agentic-dev-flow`). The plugin's files stay where they are; only its
registry entry goes.

1. If the developer gave no name, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check`, list the enabled plugins, ask
   which one to remove and stop until they answer.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" remove "<plugin name or id>"
   ```

   On exit code 1, show the `error` field to the developer and stop.

3. Show `report` as it is. When a later contract version defines roles, also report each role
   that now falls back to the core default.

Do not commit: the developer commits the registry with the rest of their change.
