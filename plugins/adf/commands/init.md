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
   - `settings.notes`: what was not written, and why;
   - `gitignore.added`: the lines added to `.gitignore`: the change worktrees, the execution
     ledger and Superpowers' default output folder;
   - `planningGuide`: whether the planning guide `openspec/planning.md` was created;
   - `branches`: the branch policy, or null when it is not set;
   - `detectedIntegration`: the remote's default branch, or null.

2. If `branches` is null, set the branch policy. Ask the developer, in one question:
   - which branch is the integration branch, the one a change forks from and merges into.
     Offer `detectedIntegration` when it is not null;
   - which other branches nobody commits or pushes to directly, a release branch for example.
     The integration branch is always protected.

   Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" branches --integration <branch> [--protected <b1,b2>]
   ```

   If `branches` is not null, show it and change nothing.

3. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/superpowers.mjs"
   ```

   If `ok` is false, show `reason` and the `install` command to the developer. Continue: setup
   does not need Superpowers, but every command that changes a change does.

4. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" check
   ```

   If `ok` is false, show every entry of `errors` to the developer and stop.

5. Report:
   - whether the registry was created or already existed;
   - the contract version;
   - the settings keys added, and every note;
   - the branch policy, and whether `.gitignore` changed;
   - whether the planning guide was created, and that the team fills it in;
   - whether Superpowers is available, with the install command if it is not;
   - the enabled plugins from the `check` output, or "none";
   - that plugins are enabled with `/adf:add <plugin path>`.

Do not commit. The developer commits the registry, the settings, `.gitignore` and the planning
guide. A change's worktree forks from the integration branch, so it sees them only after they
reach it.
