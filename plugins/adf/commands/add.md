---
description: Enable an ADF plugin in this project. Triggers may be phrased in any language.
argument-hint: <plugin id or path> [config as JSON]
---

Enable the plugin given in the arguments: an installed plugin's id (`name@marketplace`), or
the path of a plugin directory. A second argument, if present, is the
plugin's configuration as a JSON object.

1. If the developer gave no plugin, ask for it and stop until they answer.

2. Run, with `--config '<json>'` only when a configuration was given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" add "<plugin id or path>" --config '<json>'
   ```

   On exit code 1, show the `error` field to the developer and stop. The registry is unchanged.
   The usual causes are a project without ADF (run `/adf:init`), a plugin not installed for this
   project (run the install command the error names, then retry), a plugin written for another
   contract version, a plugin already enabled, or a role another plugin already provides.

3. Show `report` as it is.

Do not commit: the developer commits the registry, the copied host files and the settings with
the rest of their change.
