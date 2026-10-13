---
description: Set up ADF in this project, or report what is missing if it is already set up
---

Set up the ADF core in the current project. Running it again is safe: it creates only what is
missing and changes nothing that exists.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" init
   ```

   The output is one JSON object: `created` says whether the registry
   `.claude/adf-extensions.json` was written now, `contract` is the contract version this core
   runs.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check
   ```

   If `ok` is false, show every entry of `errors` to the developer and stop.

3. Report:
   - whether the registry was created or already existed;
   - the contract version;
   - the enabled plugins from the `check` output, or "none";
   - that plugins are enabled with `/adf:add <plugin path>`.

Do not commit. The developer commits the registry with the rest of their change.
