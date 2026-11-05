# Agentic Dev Flow

A spec-driven change workflow for coding agents in Claude Code and Codex.

ADF (agentic dev flow) runs each change through one cycle of commands. Each command leaves a record in the project, so the next command and the next developer can read it.

```text
  /adf:propose ──▶ /adf:apply ──▶ /adf:verify ──▶ /adf:review ──▶ /adf:archive
   brainstorm,      execute the     check the        code review,     merge the specs,
   specs, plan      plan in the     code against     fix what         deliver the code,
   in a worktree    worktree        the artifacts    blocks           remove the worktree

  /adf:retro    looks back over the archived changes; it is not a stage of one change
```

To install ADF in Claude Code or in Codex, see [Quick start](#quick-start).

## Commands

Each command is a skill of the core plugin `adf`. In Codex, invoke the skill by the name that `/skills` lists. See [the Codex page](docs/guide/getting-started/codex.md#command-forms).

| Command | When to use it | What it does |
|---|---|---|
| `/adf:init` | Once per project, before the first change. | Writes the registry, the planning guide, the review prompt and the `.gitignore` lines. |
| `/adf:add` | To enable a plugin, or to change its configuration. | Writes the plugin entry in the registry. |
| `/adf:remove` | To disable a plugin. | Removes the plugin entry from the registry. |
| `/adf:propose` | To start a change. | Makes the branch and the worktree, then writes every artifact up to the plan. |
| `/adf:apply` | After propose. | Executes the plan task by task with subagents, in the worktree. |
| `/adf:verify` | After apply. | Checks that the code matches the artifacts, and commits the record. |
| `/adf:review` | After verify. | Runs the project's code review, fixes what blocks, and commits the record. |
| `/adf:archive` | After review. | Merges the specs, places the debt, finalizes the merge request and removes the worktree. |
| `/adf:land` | Optional: needs a tracker plugin. Use it after the merge request is merged. | Writes the hand-off comment of each tracker issue and hands each issue to its tester. |
| `/adf:retro` | After some changes are archived. | Reports how the flow worked over a window of archived changes. |
| `/adf:update` | When the session start tells you that a new release exists. | Moves the project to the new release in one merge request. |

## Quick start

<details>
<summary><b>Claude Code</b></summary>

Install Node 20 or later. Then:

1. Merge this block into the project's `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "agentic-dev-flow": {
         "source": {
           "source": "git",
           "url": "https://github.com/romant094/agentic-dev-flow.git",
           "ref": "v0.20.0"
         }
       }
     },
     "enabledPlugins": {
       "adf@agentic-dev-flow": true
     }
   }
   ```

2. Open Claude Code in the project.
3. Trust the project when Claude Code asks.
4. Run this command in a shell:

   ```
   claude plugin install adf@agentic-dev-flow --scope project
   ```

5. Restart Claude Code in the project.
6. Run `/adf:init`.

The install also installs the dependency, Superpowers. The full steps are in [Install in Claude Code](docs/guide/getting-started/claude-code.md).

</details>

<details>
<summary><b>Codex</b></summary>

Install Node 20 or later. Then run these commands in a shell:

```
codex plugin marketplace add romant094/agentic-dev-flow --ref v0.20.0
codex plugin marketplace add anthropics/claude-plugins-official
codex plugin add superpowers@claude-plugins-official
codex plugin add adf@agentic-dev-flow
```

In the project:

1. Invoke the skill `adf:init` by the name that `/skills` lists.
2. Open `/hooks` and trust the plugins' hooks once.

The full steps are in [Install in Codex](docs/guide/getting-started/codex.md).

</details>

Then make [your first change](docs/guide/getting-started/first-change.md).

## Plugins

The core `adf` runs the cycle. Every other plugin is optional. A project enables only the plugins it needs, with `/adf:add`.

| Plugin | What it adds | When a project needs it |
|---|---|---|
| [`adf-gitlab`](docs/guide/plugins/adf-gitlab.md) | The `forge` role on GitLab: it pushes the change branch and keeps its merge request, through `glab`. | The project is on GitLab. |
| [`adf-memory`](docs/guide/plugins/adf-memory.md) | The `knowledge` role: an indexed wiki memory, its log, and the ingest, query and lint workflows. | The agents must read and keep the project's knowledge. |
| [`adf-jira`](docs/guide/plugins/adf-jira.md) | The `tracker` role on Jira, and guarded Jira skills. | The project's issues are in Jira. |
| [`adf-english-check`](docs/guide/plugins/adf-english-check.md) | A hook that stops an agent's commit of non-English text. | The project's files must be in English. |
| [`adf-npm-workspaces`](docs/guide/plugins/adf-npm-workspaces.md) | Each worktree gets its own `node_modules`, and a guard stops `npm install` in a worktree. | The project is an npm-workspaces monorepo. |
| [`adf-postgres`](docs/guide/plugins/adf-postgres.md) | One PostgreSQL database for each worktree, dropped at teardown. | The project needs a PostgreSQL database. |
| [`adf-prisma`](docs/guide/plugins/adf-prisma.md) | Each worktree gets its own Prisma client, migrations and seed, and verify checks the migration order. | The project uses Prisma. |
| [`adf-maintainer`](docs/guide/plugins/adf-maintainer.md) | The `upstream` role: it files a retrospective's findings and the open ADF debt as GitHub issues. | Only the maintainer of ADF needs it. |

## How it works

- **The core and the plugins.** The core `adf` holds the cycle, its gates, the review, the metrics and the retrospective. A plugin adds one outside tool, such as a forge or a tracker, at an [extension point](docs/guide/extension-points/README.md).
- **The registry.** `.claude/adf-extensions.json` holds the branch policy and the enabled plugins. See [the registry](docs/guide/concepts/registry.md).
- **One branch and one worktree for each change.** `/adf:propose` makes them, and `/adf:archive` removes the worktree. See [worktrees](docs/guide/concepts/worktrees.md).
- **The files in the project.** See [host files](docs/guide/concepts/host-files.md) and the other [concepts](docs/guide/README.md#section-map).

## Why ADF

- **Full control of a change.** You control each step, from the gathered context, the plans and the decomposition to the review, the verification and the delivery of the code.
- **Flexibility.** A project enables only the plugins it needs.

ADF is built on two foundations:

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** gives the spec-driven model. The specs say what the system must do. Each change carries its proposal, design, delta specs and tasks in `openspec/changes/`. ADF has its own engine and schema for this model, so the `openspec` command-line tool is not needed.
- **[Superpowers](https://github.com/obra/superpowers)** gives the agent's working skills: brainstorming, writing plans, test-driven development, subagent-driven execution, worktrees, code review and verification before completion. `adf` installs it as a dependency.

ADF joins them into one cycle. It adds the gates between the stages and a script for each deterministic step. The agents reply in a structured form that a script checks. ADF also adds the review rounds, the delivery through a forge, the metrics and the extension points.

## Documentation

- [The user guide](docs/guide/README.md): the install, the cycle, the extension points, the plugins and the concepts.
- [The changelog](CHANGELOG.md): the changes of each release.

## Contributing

Issues and pull requests are welcome. See [Contributing](docs/guide/contributing.md).

## License

MIT. See [LICENSE](LICENSE).
