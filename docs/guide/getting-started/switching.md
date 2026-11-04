<!-- sources:
- plugins/adf/skills/init/**
- plugins/adf/scripts/lib/migrate.mjs
- plugins/adf/scripts/lib/init.mjs
- plugins/adf/scripts/init.mjs
-->

# Switching a project to the plugins

This checklist is for a host project that already runs its own change flow, written before the
plugins existed: its own commands, schema, scripts and agents. A project with no flow of its own
needs only the install in `README.md`.

The default is one stage after a freeze: work in flight stops at a phase boundary, one merge
request removes the old flow and sets up the plugins, and open change branches take the
integration branch by merge. Both flows never coexist. The two-stage switch is the fallback where
a freeze is not possible.

Paths and names below are examples. `develop` stands for the project's integration branch.

## One-stage switch

### Before the freeze

1. Collect every change in flight and its phase, the developers' own worktrees included.
2. Finish to archive, with the old flow, every change past verify.
3. A change with a plan and apply records but no verify either finishes with the old flow, or
   continues with `/adf:verify` after the switch. The first path is the safer one.
4. A change with only propose's artifacts continues with `/adf:apply` after the switch.

### Freeze

5. Announce the freeze: nobody commits to a change branch until the switch merges (step 13).

### The switch merge request

6. Branch from `develop`. One merge request carries steps 7 to 12.
7. Remove the old flow. Make an inventory of its parts and what replaces each, then remove what
   the inventory says. A typical inventory:

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
   | Flow capability specs (for example in `openspec/specs/`) | removed: the flow's own specs live in the plugins |
   | The old flow's project configuration (for example `openspec/config.yaml`) | `openspec/planning.md`, written by `/adf:init` |
   | Guards and deny rules that protect the old flow's files, flow regression scripts, flow digest skills | nothing; obsolete with the old flow |
   | A pre-commit English check | `adf-english-check`, for the flow's commits |
   | Memory pages that describe the old flow or name its removed scripts | reworded or removed |
   | Project skills and plugins that are not part of the flow | kept; reword any that name the old commands |

   Never remove the changes themselves: `openspec/changes/` keeps every change in flight and the
   archive. A change in flight continues with the `/adf:*` command of its next phase (steps 3, 4
   and 15); removing its directory loses its artifacts. The removal touches only the flow's tools,
   never a change's content.

   Search the whole repository for the old command names and script paths before you close the
   inventory. Every hit is a part to remove or reword.
8. Reword the host's agent instructions (for example `CLAUDE.md`) that describe the old flow.
   Name `/adf:propose` as the entry point for a change. An agent follows the instructions it
   reads, and an old command named there wins over the plugin's.
9. Bring the technical debt tables to the port's format. The last column of an entry table is
   `Tracker`; rename a column such as `Jira`. In the same edit, replace any example row in a
   format description with a pointer to the port's debt format: after the rename the check reads
   an example row as an entry. `/adf:init` runs `debt check`; it names a column to rename.
10. Declare the marketplace and enable the plugins in the committed project settings
    (`.claude/settings.json`). Declare the marketplace by its git URL with an explicit ref, never
    by a local path that no other developer has:

    ```json
    {
      "extraKnownMarketplaces": {
        "agentic-dev-flow": {
          "source": { "source": "git", "url": "https://github.com/<owner>/agentic-dev-flow.git", "ref": "<release tag or commit>" }
        }
      },
      "enabledPlugins": {
        "adf@agentic-dev-flow": true,
        "adf-gitlab@agentic-dev-flow": true,
        "adf-memory@agentic-dev-flow": true
      }
    }
    ```

    Enable every plugin the project uses, at project scope. When a developer trusts the project,
    Claude Code clones the declared marketplace; the port's plugins are relative-path sources in
    that marketplace, so they load from it. If `/plugin` still reports a plugin "enabled in
    project settings but isn't installed here", the developer runs
    `claude plugin install <name>@agentic-dev-flow --scope project` once. To move to a new
    release, change the ref in one merge request. (Claude Code plugin docs:
    `plugins/marketplace-reference`, `plugins/install`.)

    `claude plugin install --scope project` rewrites this file with its own indentation. Say so
    in the commit; the project's formatter restores the style.
11. Run `/adf:init`, then `/adf:add` once per plugin, each with its configuration on the first
    add. Add `adf-postgres` before `adf-prisma`. Then run a plugin's own setup, for example
    `/adf-jira:setup`. Answer init's questions:

    - the integration branch and any other protected branch;
    - the debt root;
    - the worktree preparation (the builds a fresh worktree lacks);
    - the whole-suite command, from CI and `package.json`;
    - the worktree copies, for example `.env`.

12. Check: the registry and debt checks pass, and an agent asked to start a change picks
    `/adf:propose`.

### After the switch

13. Merge the switch into `develop` before the first propose. A change worktree reads its own
    copy of the registry and the planning guide, so a change opened before the merge does not
    see the setup. End the freeze.
14. Merge `develop` into every change branch still open. Never rebase a pushed branch. A change
    forked from a branch other than `develop` gets a `base:` line in its `.openspec.yaml`.
15. Continue each change with the `/adf:*` command of its next phase (the table in the
    developer's guide below). The forge plugin takes over the change's existing Draft merge
    request.

## Two-stage switch (fallback)

Use it only where a freeze is not possible. Both flows coexist between the stages, and the agent
can pick the wrong one.

Stage 1, one merge request, on top of the old flow:

1. Steps 9 to 12 of the one-stage switch: the debt format, the project settings, init, add and
   setup.
2. Disable the old in-repo tracker plugin (`"enabledPlugins": { "<old tracker>": false }`). Its
   skills still describe the old debt column, and their descriptions are near-identical to the
   tracker plugin's; the agent cannot tell them apart. The old flow must not call it.
3. Reword the host's agent instructions so that a new change starts with `/adf:propose`. A
   change in flight keeps the old flow's commands until stage 2.
4. Rename the debt column and remove the format description's example row in one edit.

Stage 2, a merge request of its own: step 7 of the one-stage switch, the removal. Then steps 13
to 15.

The old agents sit beside the plugin's agents during stage 1. Their names do not clash; stage 2
removes them.

## Developer's migration guide

What each developer does after the switch merges into `develop`.

On your machine:

1. Update your checkout of the integration branch.
2. Start Claude Code in the project and trust it. Claude Code clones the marketplace the project
   settings declare.
3. Run `/plugin`. If it reports a plugin "enabled in project settings but isn't installed here",
   run `claude plugin install <name>@agentic-dev-flow --scope project` once for it; otherwise
   install nothing.
4. Remove any personal copy of the old flow, for example old commands or agents under
   `~/.claude/`, or a local settings file that enables the old tracker plugin.

For each of your own changes in flight:

1. Merge `develop` into the change branch, then push.
2. Run the `/adf:*` command of the change's next phase:

   | The old flow's last finished phase | Next command |
   |---|---|
   | nothing yet | `/adf:propose <change>` |
   | propose | `/adf:apply <change>` |
   | apply | `/adf:verify <change>` |
   | verify | `/adf:review <change>` |
   | review | `/adf:archive <change>` |
   | archive, merge request merged | `/adf:land <change>` |

   `/adf:land` is new: after the merge it comments on each taken tracker issue and hands it to the
   tester.

Do not:

- rebase a pushed change branch: merge `develop` in;
- run the old flow's commands, or copy them back;
- enable or disable a plugin in your own settings: change the project settings in a merge
  request.
