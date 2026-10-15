---
description: Disable an ADF plugin in this project
argument-hint: <plugin name>
---

Disable the plugin named in the arguments. The plugin's files stay where they are; only its
registry entry goes.

1. If the developer gave no name, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check`, list the enabled plugins, ask
   which one to remove and stop until they answer.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" remove "<plugin name>"
   ```

   On exit code 1, show the `error` field to the developer and stop.

3. Report the removed plugin and its path. When a later contract version defines roles, also
   report each role that now falls back to the core default.

Do not commit: the developer commits the registry with the rest of their change.
