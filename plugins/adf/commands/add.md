---
description: Enable an ADF plugin in this project
argument-hint: <plugin path> [config as JSON]
---

Enable the plugin at the path given in the arguments. A second argument, if present, is the
plugin's configuration as a JSON object.

1. If the developer gave no path, ask for it and stop until they answer.

2. Run, with `--config '<json>'` only when a configuration was given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" add "<plugin path>" --config '<json>'
   ```

   On exit code 1, show the `error` field to the developer and stop. The registry is unchanged.
   The usual causes are a project without ADF (run `/adf:init`), a plugin written for another
   contract version, or a plugin already enabled.

3. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check
   ```

   If `ok` is false, show the errors and stop.

4. Report the plugin's name and the points it provides, or "no points yet".

Do not commit. The developer commits the registry with the rest of their change.
