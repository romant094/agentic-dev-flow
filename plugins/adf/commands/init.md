---
description: Set up ADF in this project, or report what is missing if it is already set up
---

Set up the ADF core in the current project. Running it again is safe: it creates only what is
missing and changes nothing that exists.

1. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" init
   ```

   On exit code 1, show `error` and stop.

2. If `branches` is null, set the branch policy. Ask the developer, in one question:
   - which branch is the integration branch, the one a change forks from and merges into.
     Offer `detectedIntegration` when it is not null;
   - which other branches nobody commits or pushes to directly, a release branch for example.
     The integration branch is always protected.

   Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/extensions.mjs" branches --integration <branch> [--protected <b1,b2>]
   ```

   If `branches` is not null, change nothing.

3. Read where the technical debt store lives:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/debt.mjs" root
   ```

   If `root` is null, ask the developer which directory, relative to the project root, holds
   the debt tree; offer `docs/tech-debt`. Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/debt.mjs" root --set <path>
   ```

   If `root` is not null, change nothing.

4. Show the `report` of step 1 as it is, with the `report` of step 2 when it ran in place of its
   branch policy line, and one line `Debt store: <root>`, with `(root index created)` when step 3
   created it. When Superpowers is not available, continue: setup does not need
   Superpowers, but every command that changes a change does.

Do not commit: the developer commits the registry, the settings, `.gitignore`, the planning
guide, the review prompt and the debt tree's root index. A change's worktree forks from the integration branch, so it sees them only after they
reach it.
