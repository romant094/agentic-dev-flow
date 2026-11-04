<!-- sources:
- plugins/adf/skills/init/**
- plugins/adf/scripts/lib/migrate.mjs
- plugins/adf/scripts/lib/init.mjs
- plugins/adf/scripts/init.mjs
-->

# Switching a project to the plugins

Use this page when a project already runs its own change flow: its own commands, schema, scripts and agents. A project with no flow of its own needs only the install: [Claude Code](claude-code.md) or [Codex](codex.md).

The default is a one-stage switch after a freeze:

1. Work in flight stops at a phase boundary.
2. One merge request removes the old flow and sets up the plugins.
3. Open change branches take the integration branch by merge.

The old flow and the plugins never run together. Use the two-stage switch only when a freeze is not possible.

Paths and names on this page are examples. `develop` stands for the integration branch of the project.

## One-stage switch

### Before the freeze

1. List every change in flight and its phase. Include the developers' own worktrees.
2. Finish every change that is past verify to archive, with the old flow.
3. Take a change that has a plan and apply records but no verify. Either finish it with the old flow, or continue it with `/adf:verify` after the switch. The first way is safer.
4. Continue a change that has only the artifacts of propose with `/adf:apply` after the switch.

### Freeze

5. Announce the freeze. Nobody commits to a change branch until the switch merges (step 13).

### The switch merge request

6. Branch from `develop`. One merge request carries steps 7 to 12.
7. Remove the old flow.

   1. Make an inventory of its parts and of what replaces each part.
   2. Remove what the inventory lists.

   A typical inventory:

   | Old flow part | Replaced by |
   |---|---|
   | Flow commands (for example `.claude/commands/<flow>/`) and the schema they run | `adf` |
   | The spec-sync skill or script | `adf` (archive) |
   | Agents per capability level | `adf` agents |
   | Reply, plan, workspace and dependency checks, the ledger, metrics scripts, a retrospective skill | `adf` |
   | Merge request script and the flow's merge request template | the forge plugin, for example `adf-gitlab`, and its template |
   | In-repo tracker plugin and its `enabledPlugins` and marketplace entries | the tracker plugin, for example `adf-jira`; keep its profile directory |
   | Worktree database script | `adf-postgres` |
   | Worktree provisioning script | `adf-npm-workspaces`, `adf-prisma` |
   | Migration order check | `adf-prisma` `verify-check` |
   | Log rotation script and skill | `adf-memory` |
   | Flow capability specs (for example in `openspec/specs/`) | removed: the plugins hold the flow's own specs |
   | The old flow's project configuration (for example `openspec/config.yaml`) | `openspec/planning.md`, written by `/adf:init` |
   | Guards and deny rules that protect the old flow's files, flow regression scripts, flow digest skills | nothing; they are obsolete with the old flow |
   | A pre-commit English check | `adf-english-check`, for the flow's commits |
   | Memory pages that describe the old flow or name its removed scripts | reworded or removed |
   | Project skills and plugins that are not part of the flow | kept; reword any that name the old commands |

   Never remove the changes themselves. `openspec/changes/` keeps every change in flight and the archive. A change in flight continues with the `/adf:*` command of its next phase (steps 3, 4 and 15). If you remove its directory, you lose its artifacts. The removal touches only the tools of the flow, never the content of a change.

   Search the whole repository for the old command names and script paths before you close the inventory. Remove or reword every hit.
8. Reword the agent instructions of the project (for example `CLAUDE.md`) that describe the old flow. Name `/adf:propose` as the entry point for a change. An agent follows the instructions it reads, so an old command named there wins over the plugin's command.
9. Bring the technical debt tables to the format of the plugins.

   1. Rename the last column of an entry table to `Tracker`. For example, rename a column `Jira`.
   2. In the same edit, replace any example row in a format description with a pointer to the debt format. After the rename, the check reads an example row as an entry.

   `/adf:init` runs `debt check`. It names a column to rename.
10. Declare the marketplace and enable the plugins in the committed project settings (`.claude/settings.json`). Declare the marketplace by its git URL with an explicit ref. Never use a local path that no other developer has.

    ```json
    {
      "extraKnownMarketplaces": {
        "agentic-dev-flow": {
          "source": { "source": "git", "url": "https://github.com/romant094/agentic-dev-flow.git", "ref": "v0.20.0" }
        }
      },
      "enabledPlugins": {
        "adf@agentic-dev-flow": true,
        "adf-gitlab@agentic-dev-flow": true,
        "adf-memory@agentic-dev-flow": true
      }
    }
    ```

    Enable every plugin that the project uses, at project scope. When a developer trusts the project, Claude Code clones the declared marketplace. The plugins are relative-path sources in that marketplace, so they load from it.

    If `/plugin` reports a plugin "enabled in project settings but isn't installed here", the developer runs this command once:

    ```
    claude plugin install <name>@agentic-dev-flow --scope project
    ```

    To move to a new release, change the ref in one merge request.

    `claude plugin install --scope project` rewrites the settings file with its own indentation. Say so in the commit. The formatter of the project restores the style.
11. Run `/adf:init`. Then run `/adf:add` once per plugin, each with its configuration on the first add. Add `adf-postgres` before `adf-prisma`. Then run the own setup of a plugin, for example `/adf-jira:setup`. Answer the questions of `/adf:init`:

    - the integration branch and any other protected branch;
    - the debt root;
    - the worktree preparation (the builds that a fresh worktree lacks);
    - the whole-suite command, from CI and `package.json`;
    - the worktree copies, for example the env file.

12. Check three things:

    - the registry check passes;
    - the debt check passes;
    - an agent that you ask to start a change picks `/adf:propose`.

### After the switch

13. Merge the switch into `develop` before the first propose. A change worktree reads its own copy of the registry and the planning guide. A change opened before the merge does not see the setup. End the freeze.
14. Merge `develop` into every change branch that is still open. Never rebase a pushed branch. Add a `base:` line to the `.openspec.yaml` of a change that forked from a branch other than `develop`.
15. Continue each change with the `/adf:*` command of its next phase (the table in the developer's guide below). The forge plugin takes over the existing Draft merge request of the change.

## Two-stage switch (fallback)

Use it only where a freeze is not possible. Both flows exist together between the two stages, so the agent can pick the wrong one.

Stage 1 is one merge request, on top of the old flow:

1. Do steps 9 to 12 of the one-stage switch: the debt format, the project settings, init, add and setup.
2. Disable the old in-repo tracker plugin: `"enabledPlugins": { "<old tracker>": false }`. Its skills still describe the old debt column. Their descriptions are almost the same as the descriptions of the tracker plugin, so the agent cannot tell them apart. The old flow must not call it.
3. Reword the agent instructions of the project so that a new change starts with `/adf:propose`. A change in flight keeps the commands of the old flow until stage 2.
4. Rename the debt column and remove the example row of the format description in one edit.

Stage 2 is a merge request of its own. It does step 7 of the one-stage switch, the removal. Then it does steps 13 to 15.

During stage 1 the old agents stay beside the agents of the plugins. Their names do not clash. Stage 2 removes them.

## Developer's migration guide

This part tells each developer what to do after the switch merges into `develop`.

On your machine:

1. Update your checkout of the integration branch.
2. Start Claude Code in the project and trust it. Claude Code clones the marketplace that the project settings declare.
3. Run `/plugin`. If it reports a plugin "enabled in project settings but isn't installed here", run `claude plugin install <name>@agentic-dev-flow --scope project` once for that plugin. Otherwise, install nothing.
4. Remove any personal copy of the old flow. For example, remove old commands or agents under `~/.claude/`, or a local settings file that enables the old tracker plugin.

For each of your own changes in flight:

1. Merge `develop` into the change branch, then push.
2. Run the `/adf:*` command of the next phase of the change:

   | Last phase that the old flow finished | Next command |
   |---|---|
   | nothing yet | `/adf:propose <change>` |
   | propose | `/adf:apply <change>` |
   | apply | `/adf:verify <change>` |
   | verify | `/adf:review <change>` |
   | review | `/adf:archive <change>` |
   | archive, merge request merged | `/adf:land <change>` |

   `/adf:land` is the one new command. After the merge, it comments on each taken tracker issue and hands the issue to the tester. See [the tracker role](../extension-points/contract/tracker.md).

Do not:

- rebase a pushed change branch: merge `develop` into it;
- run the commands of the old flow, or copy them back;
- enable or disable a plugin in your own settings: change the project settings in a merge request.

The Codex form of each command is in [the Codex page](codex.md).
