<!-- sources:
- plugins/adf/skills/init/**
- plugins/adf/.codex-plugin/**
- plugins/adf/scripts/runlog.mjs
- plugins/adf/scripts/lib/runtime.mjs
-->

# Install in Codex

Use v0.20.0 or a later tag in `--ref`. Node 20 or later is the only other prerequisite.

The install is at user scope: it applies to every project on the machine.

## Add the marketplaces

Run these commands in a shell:

```
codex plugin marketplace add romant094/agentic-dev-flow --ref v0.20.0
codex plugin marketplace add anthropics/claude-plugins-official
```

The second marketplace holds the dependency, Superpowers.

## Install the plugins

```
codex plugin add superpowers@claude-plugins-official
codex plugin add adf@agentic-dev-flow
```

## Enable more plugins

To use another plugin of the package, for example `adf-memory`, do these steps:

1. Install it: `codex plugin add adf-memory@agentic-dev-flow`.
2. Invoke the skill `adf:add` with the id `adf-memory@agentic-dev-flow`.
3. Open `/hooks` and trust the new hooks.

## Run the first skill

1. Open Codex in the project.
2. Run `/skills`.
3. Invoke the skill `adf:init` by the name that `/skills` lists, or pick it in the list.

`/adf:init` asks the questions that [the Claude Code page](claude-code.md#set-up-the-project) lists.

Not checked: the `$adf:init` mention form. Use the name that `/skills` lists.

## Trust the hooks

1. Open `/hooks`.
2. Trust the hooks of the plugins once.

Codex does not run a hook that you did not trust. `/adf:init` tells you to do this step when the hooks need it.

Not checked: the `/hooks` trust screen.

## Command forms

This guide names every command in the Claude Code form, for example `/adf:propose`. In Codex, invoke the skill with the same name, by the name that `/skills` lists.

| Claude Code | Codex |
|---|---|
| `/adf:init` | the skill `adf:init` |
| `/adf:propose <change>` | the skill `adf:propose`, with the change name |
| `/adf:apply`, `/adf:verify`, `/adf:review`, `/adf:archive` | the skills with the same names |
| `/adf:add <id>`, `/adf:remove <id>` | the skills `adf:add` and `adf:remove`, with the plugin id |
| `/adf:land`, `/adf:retro` | the skills with the same names |
| `/adf:update` | the skill `adf:update`; its pull step upgrades the user's Codex marketplace |

The skills work as in Claude Code.

Codex sessions are not read for metrics yet.

## Codex home

The flow's scripts read the Codex home from `CODEX_HOME`. When the variable is not set, they use `~/.codex`. Set `CODEX_HOME` when your Codex home is elsewhere.

## Send the maintainer a run log

Run this command in the main checkout of the project:

```
node <adf root>/scripts/runlog.mjs collect
```

`<adf root>` is the directory of the installed `adf` plugin. In Codex it is `~/.codex/plugins/cache/agentic-dev-flow/adf/<version>`.

The command writes `.adf/runlog/<date>-<runtime>.tar.gz`. The archive holds whole sessions, the changes' records, the registry and `versions.json`. It never holds credential files or private keys. Read the warning that the command prints, then send the archive to the maintainer.
