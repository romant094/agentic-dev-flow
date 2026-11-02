---
description: Set up ADF in this project, or report what is missing if it is already set up. Triggers may be phrased in any language.
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

3. Seed the retrospective window, so the changes the project archived before ADF do not count
   toward its first window or make the corpus lint due at the first archive:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" seed
   ```

   It writes `.adf/retro/<date>-window.json` only when the integration branch has archived
   changes and no window retrospective; otherwise `reason` says why it wrote nothing. Change
   nothing on either result.

4. Read where the technical debt store lives:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/debt.mjs" root
   ```

   If `root` is null, ask the developer which directory, relative to the project root, holds
   the debt tree; offer `docs/tech-debt`. Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/debt.mjs" root --set <path>
   ```

   Then check the tree, which may already exist:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/debt.mjs" check
   ```

   Exit code 1 here means the tree has errors: continue, and show them in step 9.

   If `root` is not null, change nothing: the `report` of step 1 already holds the debt check.

5. Read the worktree preparation recipe of the planning guide:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare.mjs" recipe
   ```

   If `steps` is empty, gather the candidates:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare.mjs" candidates
   ```

   Show each candidate with its `why`, and ask the developer which to keep, and whether a
   command or an input path needs a change. Each step is a command that rebuilds what git
   ignores, such as a built shared package or generated code, and the input paths whose change
   makes it run again. When `candidates` is empty, ask whether the project builds anything a
   fresh checkout needs before its tests run; read the package scripts and the build files to
   offer one. Write only what the developer confirms, one call per step:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare.mjs" add --command "<command>" --input <path> [--input <path> ...]
   ```

   If `steps` is not empty, change nothing.

6. Read what the planning guide holds for the whole-suite command and the worktree copies, and
   what init infers for them:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" suggest
   ```

   If `suite.current` is null, show each of `suite.candidates` with its `source` and `why`, and
   ask the developer for the one command that runs every test of the project with no cache; a
   candidate may need a flag that disables the cache, such as `--force`. When `candidates` is
   empty, read the package scripts and the build files to offer one. Write only what the
   developer confirms:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/suite.mjs" set --command "<command>"
   ```

   If `copies.candidates` is not empty, show them with `copies.current`, and ask which untracked
   files every worktree needs from the main checkout. Write only what the developer confirms:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" copies --path <path> [--path <path> ...]
   ```

   If `suite.current` is not null, change nothing for the command; if `copies.candidates` is
   empty, change nothing for the copies.

7. Read the `## Format command` section of `openspec/planning.md`. If it holds no command, read
   the project's format scripts (the `package.json` scripts, the `Makefile`, the git hook
   configuration such as `lefthook.yml` or `.husky/`) and propose one command that formats the
   files it is given, with `{files}` where the paths go, for example
   `npx biome format --write {files}`. Every commit the flow makes runs it on its paths first.
   When the developer confirms a command, write it into the section as one line in backticks,
   adding the section before `## Checks that need the developer` when the guide lacks it;
   when the developer declines, or the project has no formatter, leave the section as it is.
   If the section holds a command, change nothing.

8. Find the lines of the project's agent instruction files (`CLAUDE.md`, `AGENTS.md` and the
   like) that name a previous flow's commands, such as `/opsx:propose` or `openspec/schemas`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" scan
   ```

   It changes nothing. Do not edit these files: the developer rewords them for `/adf:*`.

9. Show the `report` of step 1 as it is, with the `report` of step 2 when it ran in place of its
   branch policy line, one line `Debt store: <root>`, with `(root index created)` when step 4
   created it, and, when step 4 set the root, `Debt check: ok` or the count and every
   `file:line message` of its `errors`. On debt errors, tell the developer the flow refuses to
   read the tree until they are fixed, for example a last column `Jira` renamed to `Tracker`.
   One line `Window seed: <path>` or `Window seed: none (<reason>)` from step 3. One line
   `Worktree preparation: <n> step(s)`, one line `Whole-suite command: <command>` or
   `Whole-suite command: none; apply asks for it`, one line `Worktree copies: <paths>` or
   `Worktree copies: none`, and one line `Format command: <command>` or
   `Format command: none`. Then the `report` of step 8 as it is. The report includes the
   tracker's check and its notes when a plugin
   provides the tracker; act on a note, for example
   run `/adf-jira:setup`. When Superpowers is not available, continue: setup does not need
   Superpowers, but every command that changes a change does.

Do not commit: the developer commits the registry, the settings, `.gitignore`, the planning
guide with its whole-suite command, worktree copies, worktree preparation and format command,
the review prompt, the window seed and the debt tree's root index.

End with this note to the developer: commit the setup and merge it into the integration branch
before the first `/adf:propose`. A change's worktree forks from the integration branch and its
provisioning reads the registry and the planning guide from that worktree's own copy, so a
change opened before the setup merges never sees it, and a later change to the registry or the
guide on the integration branch reaches a change already open only when that branch is merged
into it.
