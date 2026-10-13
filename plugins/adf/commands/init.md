---
description: Set up ADF in this project, or report what is missing if it is already set up
---

Set up the ADF core in the current project. Running it again is safe: it creates only what is
missing and changes nothing that exists.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" init
   ```

   The output is one JSON object:
   - `created`: whether the registry `.claude/adf-extensions.json` was written now;
   - `contract`: the contract version this core runs;
   - `settings.added`: the keys written to the project's `.claude/settings.json`, so that
     Claude Code offers ADF to a contributor who trusts the folder;
   - `settings.notes`: what was not written, and why.

2. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/superpowers.mjs"
   ```

   If `ok` is false, show `reason` and the `install` command to the developer. Continue: setup
   does not need Superpowers, but every command that changes a change does.

3. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check
   ```

   If `ok` is false, show every entry of `errors` to the developer and stop.

4. Report:
   - whether the registry was created or already existed;
   - the contract version;
   - the settings keys added, and every note;
   - whether Superpowers is available, with the install command if it is not;
   - the enabled plugins from the `check` output, or "none";
   - that plugins are enabled with `/adf:add <plugin path>`.

Do not commit. The developer commits the registry and the settings with the rest of their
change.
