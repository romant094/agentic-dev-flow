---
name: add
description: Enable an ADF plugin in this project, or set the configuration of one already enabled. Triggers may be phrased in any language.
argument-hint: <plugin id or path> [config as JSON]
---
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.


Enable the plugin given in the arguments: an installed plugin's id (`name@marketplace`), or
the path of a plugin directory. A second argument, if present, is the
plugin's configuration as a JSON object. For a plugin that is already enabled, the
configuration replaces its current one in place (step 3).

1. If the developer gave no plugin, ask for it and stop until they answer.

2. Run, with `--config '<json>'` only when a configuration was given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" add "<plugin id or path>" --config '<json>'
   ```

   On exit code 1 with an `error` that says the plugin is already enabled, go to step 3. On any
   other exit code 1, show the `error` field to the developer and stop. The registry is
   unchanged. The usual causes are a project without ADF (run `/adf:init`), a plugin not
   installed for this project (run the install command the error names, then retry), a plugin
   written for another contract version, or a role another plugin already provides.

3. Only when step 2 found the plugin already enabled: if no configuration was given, tell the
   developer that the plugin is already enabled and stop. Otherwise replace its configuration,
   which keeps its place in the registry (never remove and add it again, which moves it to the
   end and changes the order hooks run in):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" config "<plugin id or name>" --config '<json>'
   ```

   On exit code 1, show the `error` field to the developer and stop.

4. Show `report` as it is. A `Warning: the config has no ...` line names the configuration keys
   the plugin declares as required and the configuration lacks: the plugin is enabled, and an
   operation that needs those keys refuses until a configuration sets them. The report includes
   the tracker's check and its notes when a plugin provides the tracker; act on a note, for
   example run `/adf-jira:setup`. It includes the debt check
   when the registry names a debt root; on its errors, tell the developer the flow refuses to
   read the tree until they are fixed, for example a last column `Jira` renamed to `Tracker`.

Do not commit: the developer commits the registry and the copied host files with the rest of
their change.

End with this note to the developer: merge the registry change into the integration branch
before the next `/adf:propose`. A change's provisioning reads the registry from the change
worktree's own copy, so a change already open sees the plugin, or its new configuration, only
when the integration branch is merged into its branch.
