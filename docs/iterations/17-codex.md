# Iteration 17 — Codex

## Goal

The package works in Codex as well as in Claude Code. A developer installs the flow in Codex,
runs `/adf:init` and one change from propose to land, with the same scripts, the same registry
and the same host files as in Claude Code. A teammate of the developer runs it on a real project
and sends back one log file from which the port's defects are fixed.

## Intent

The guide (iteration 18) documents both providers, so Codex support comes first. The node
scripts are already provider-neutral; what ties the package to Claude Code is the packaging
around them: manifests, commands, agent definitions, hooks, the install records the scripts
read, and the session transcripts the metrics read. This iteration changes the packaging and
the few scripts that read Claude Code's state, and leaves the flow itself as it is.

## Settled by the developer

1. Codex comes before the guide (18); after 17 the package supports both Claude Code and Codex
   (2026-11-04).
2. A root `plugin.json` in the agent-plugins.org schema is needed. Reference shape:
   `addyosmani/agent-skills` (root `plugin.json`, plus `.claude-plugin/plugin.json` and
   `.claude-plugin/marketplace.json`).
3. A teammate tests it on a real project; the run collects a log for the fixes.
4. No brainstorming questions (2026-11-04): adapt what exists to Codex; the calls below are the
   designer's.

## What Codex offers (checked on 2026-11-04)

Codex CLI `0.146.0-alpha.3.1` (`/Applications/ChatGPT.app/Contents/Resources/codex`), its source
(`openai/codex`) and its documentation (developers.openai.com/codex, now learn.chatgpt.com/docs).

| Claude Code | Codex | Evidence |
|---|---|---|
| `.claude-plugin/plugin.json` | read as a fallback; first a root `plugin.json` whose `$schema` starts with `https://agent-plugins.org/schemas/`, then `.codex-plugin/plugin.json`, then `.claude-plugin/plugin.json` | `codex-rs/utils/plugins/src/plugin_namespace.rs` `find_plugin_manifest_path`; on this machine `context7` and `frontend-design` from `claude-plugins-official` run from `.claude-plugin/` only |
| Root `plugin.json` components | none declared; skills are always `./skills`; Codex-only fields under `extensions."com.openai"` (`apps`, `hooks`, `onboardingSkill`, `interface`) | `codex-rs/core-plugins/src/agent_plugin_manifest.rs:17-28, 169` |
| `.claude-plugin/marketplace.json` | read as legacy; the primary path is `.agents/plugins/marketplace.json` (`plugins[]`: `name`, `source`, `policy`, `category`) | `codex plugin list` printed the legacy path for `claude-plugins-official`; plugins/build doc |
| `claude plugin marketplace add/update`, `claude plugin install/update` | `codex plugin marketplace add <repo>[@ref] [--ref]`, `codex plugin marketplace upgrade [name]`, `codex plugin add <id>`, `codex plugin remove`, `codex plugin list` | `codex plugin --help` |
| `installed_plugins.json`, cache `~/.claude/plugins/cache/<m>/<p>/<v>` | `[plugins."<id>"] enabled` in `config.toml` (user `~/.codex/`, project `.codex/config.toml` for a trusted project), cache `~/.codex/plugins/cache/<m>/<p>/<v>` | `~/.codex/config.toml`; plugins/build doc |
| Commands `commands/*.md` | converted to skills at install, but a command over 4000 bytes or with `$ARGUMENTS` is skipped; every `adf` command fails one of the two | `core-plugins/src/command_migration.rs:343-360, 418-433` |
| Skills `skills/<n>/SKILL.md` | the same format; invoked by `$<name>` or `/skills`, or implicitly by `description` | build-skills doc |
| `${CLAUDE_PLUGIN_ROOT}` in skill text | not substituted; the model sees the skill file's path | build-skills doc (no substitution named) |
| `hooks/hooks.json` | loaded by default from a plugin, the same schema and event names; `CLAUDE_PLUGIN_ROOT` and `PLUGIN_ROOT` are set; `PreToolUse` on a shell command has `tool_name` `Bash`; exit 2 or `permissionDecision: deny` blocks; a hook runs only after the user trusts it in `/hooks` | `codex-rs/hooks/src/engine/discovery.rs:311-319`; hooks doc; `hooks.state."superpowers@claude-plugins-official:hooks/hooks.json:session_start:0:0"` in `~/.codex/config.toml` |
| `agents/*.md` in a plugin | not loaded; custom agents are TOML (`name`, `description`, `developer_instructions`, optional `model`, `model_reasoning_effort`) in `~/.codex/agents/` or `.codex/agents/`; dispatched by `spawn_agent` with `agent_type`, in parallel | `codex-rs/agent-roles/src/discovery.rs`; subagents doc; `core/src/tools/handlers/multi_agents/spawn.rs` |
| AskUserQuestion | `request_user_input`, in Plan mode only; not in `codex exec` | `codex-rs/tools/src/tool_config.rs:6-15`; binary string |
| `CLAUDE.md` | `AGENTS.md`; `CLAUDE.md` only through `project_doc_fallback_filenames` | agents-md doc |
| `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` in the binary's strings; its presence in a model's shell command is not yet confirmed | binary strings |
| Transcripts `~/.claude/projects/<key>/<session>.jsonl` | rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, records `session_meta` (with `cwd`), `turn_context`, `response_item`, `event_msg` (`token_count`) | sessions on this machine; the source |
| `claude -p` | `codex exec` (`--json`, `-C`, `-s`, `--dangerously-bypass-hook-trust`); `CODEX_HOME` for a clean home | `codex exec --help`; non-interactive-mode doc |

What the flow text uses is already neutral: the commands ask the developer in plain words (no
command names AskUserQuestion), and the instructions say "the agent of its level" and leave the
model to the runtime.

## Design

### 1. One runtime module

`plugins/adf/scripts/lib/runtime.mjs` answers which runtime runs the script, and owns every path
and command that differs: `claude-code` or `codex`. The answer comes from where the script runs
(its path under the Claude Code home or the Codex home), else `CODEX_THREAD_ID` or
`CLAUDE_CODE_SESSION_ID` in the environment, else `claude-code`; `ADF_RUNTIME` overrides it for
tests and the scratch run. The rest of the code asks this module and names no home directory.

### 2. Manifests

- Each plugin directory gets a root `plugin.json` in the agent-plugins.org schema
  (`$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`,
  `keywords`, and `extensions."com.openai".interface`). Codex reads it first. The
  `.claude-plugin/plugin.json` stays for Claude Code, which does not read the root one.
- The repository gets `.agents/plugins/marketplace.json`, one entry per plugin, `source` the
  plugin's path. `.claude-plugin/marketplace.json` stays.
- One script keeps the three in step: `scripts/manifests.mjs` writes the root `plugin.json` and
  the Codex marketplace from `.claude-plugin/`, and `check-release.mjs` fails when they differ.
  The versions stay in one place, `.claude-plugin/`.

### 3. Commands become skills

Codex skips every `adf` command (each is over 4000 bytes or uses `$ARGUMENTS`), and a root
`plugin.json` makes `./skills` the only skill directory. So the eleven commands of `adf` move to
`plugins/adf/skills/<name>/SKILL.md`, the same text, for both runtimes. In Claude Code a plugin
skill is invoked as `/adf:<name>` like the command it replaces, and it takes `$ARGUMENTS` and
`${CLAUDE_PLUGIN_ROOT}` the same way.

One line goes at the top of each skill body, for a runtime that substitutes neither token:
`${CLAUDE_PLUGIN_ROOT}` is the plugin's directory, two levels above this file; `$ARGUMENTS` is
the text the developer wrote after the skill's name; the runtime's tools are mapped in
`schema/runtimes/` (section 5). Superpowers does the same for its scripts: a skill names a
script by its path from the skill's directory, which both runtimes show the model.

The same two lines go into the `adf-jira` skills, which already are skills. `triggers.spec.mjs`
checks skills where it checked commands.

### 4. Paths in the text the scripts print

The instructions and the prompt skeletons under `plugins/adf/schema/` name
`${CLAUDE_PLUGIN_ROOT}`. A script that prints one of them (`changes.mjs instructions`,
`dispatch.mjs prompt`) substitutes the plugin's real directory, which it knows from its own
path, so an agent in either runtime reads a path it can run.

### 5. Agents and the runtime's tools

The three capability levels stay `agents/*.md` for Claude Code. Codex does not load a plugin's
agents, and a custom Codex agent is a host file (`.codex/agents/*.toml`) that `/adf:init` would
write and `/adf:update` would merge. Superpowers, which runs in Codex, ships no agent
definitions: it dispatches the default agent with the prompt. The flow does the same in Codex:
`dispatch.mjs prompt` prints, by runtime, either the Claude Code agent `adf:<level>` or, for
Codex, the level's `reasoning_effort` (from the agent file's `effort`) and the agent file's body
put in front of the prompt. No host file is added.

How the flow's words map to a runtime's tools is in one reference file per runtime,
`plugins/adf/schema/runtimes/<runtime>.md`, after the model of Superpowers'
`using-superpowers/references/codex-tools.md`. The Codex file says: dispatch an agent with
`spawn_agent` (`reasoning_effort` and the prompt `dispatch.mjs` printed), wait for it with
`wait_agent` and close it with `close_agent`; dispatch a round's agents in one turn, as the flow
says; ask the developer in plain chat text and stop the turn (`request_user_input` exists only in
Plan mode); a skill is invoked by its `$<name>`. Each skill's token line points at it.

### 6. Install records and the Superpowers gate

`lib/installed.mjs` and `lib/superpowers.mjs` read the runtime's records through
`runtime.mjs`: in Codex, `[plugins."<id>"] enabled` from the user's and the project's
`config.toml`, and the cache directory `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>`.
The refusals name the runtime's commands (`codex plugin add <id>`). The TOML reader is a small
one in the standard library, for the two shapes these files use (`[table."key"]` and
`key = value`).

### 7. Hooks

The three `hooks/hooks.json` files run in Codex as they are: the variables, the tool name and
the blocking exit are the same. The scripts behind them read their input through one helper that
accepts both runtimes' fields. The guide tells the developer to trust the hooks once in
`/hooks`; `/adf:init` in Codex says so too, since a hook that is not trusted does not run.

### 8. Update

In Codex the package is installed at user scope (Codex has no project-scope install command),
so `update.mjs` takes the user-scope path of iteration 16 there: the notice compares the installed
version with the latest tag, and `pull` runs `codex plugin marketplace upgrade agentic-dev-flow`,
then `codex plugin add` for each enabled package plugin. In a project that pins a `ref` in
`.claude/settings.json` (a team on both runtimes), the Codex notice and `pull` take that `ref`.

### 9. Session id and metrics

The ledger reads the session id through `runtime.mjs` (`CODEX_THREAD_ID` in Codex). The metrics
read Claude Code's transcripts only: in Codex the metrics record's transcript figures are null,
with the reason `transcripts of runtime codex are not read`, as the module already does for
missing transcripts. The record says which runtime ran the change.

### 10. The run log

`scripts/runlog.mjs collect [--from <date>] [--to <date>]`, run by the teammate in the project's
main directory, writes one archive, `.adf/runlog/<date>-<runtime>.tar.gz`, that holds:
- the runtime's session files whose working directory is the project or one of its worktrees,
  in the window (Codex rollouts, or Claude Code transcripts);
- the flow's own records of every change in the window (the ledger, `run.json`, the reply and
  record files under the change), and the registry;
- `versions.json`: the runtime and its version, node, git, the installed package plugins and
  their versions.

It prints the archive's path and size, and a warning that the archive holds the whole sessions,
so the teammate reads it before sending it. The teammate sends the archive to the developer by
any channel; the developer's agent reads it in the port. The format of the archive is in the
script's header, so a later `/adf:retro` can read it too.

`/adf:init` writes nothing into the agent instruction files; it only reads them for the old
flow's mentions, `AGENTS.md` included (`lib/init.mjs` `INSTRUCTION_FILES`), so the instruction
files need no change.

## Calls made by the designer, not the developer

- A root `plugin.json` per plugin directory, not one at the repository root: Codex reads the
  manifest of a plugin from that plugin's root, and the repository is a marketplace of nine
  plugins, not one plugin (agent-skills is one plugin, so its plugin root is its repository root).
- Commands become skills in both runtimes rather than a generated copy for Codex: one text, no
  build step, no duplicate `/adf:*` entries in Claude Code.
- `runtime.mjs` detects by the script's own path first: a script run from a plugin cache knows
  its runtime without any environment variable.
- The host layout stays `.claude/` in Codex too (the registry, the worktrees, the memory): one
  layout for a team on both runtimes. Codex adds only its plugin enablement in
  `.codex/config.toml`.
- No Codex agent definitions in the host: the level's effort and text travel with the dispatch,
  as Superpowers does it (checked on 2026-11-04 in `obra/superpowers`, `agent-skills` and
  `openspec`: none ships Codex agent files).
- Reference shapes, checked on 2026-11-04: all three put the work in `skills/<name>/SKILL.md`,
  which every runtime reads. `addyosmani/agent-skills` keeps thin Claude Code commands that
  invoke a skill, and says to invoke the skill directly in Codex; `obra/superpowers` has no
  commands at all; `Fission-AI/openspec` generates skills per tool and writes them into a
  project's `.agents/skills/` for Codex. Each keeps its manifests side by side
  (`.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/marketplace.json`; a root
  `plugin.json` only in agent-skills) and checks their versions by script.
- Codex metrics are a non-goal of this iteration (below), so a Codex change still archives.
- The scratch run uses `codex exec` with a clean `CODEX_HOME`, the marketplace from a local bare
  repository at a test tag, and `--dangerously-bypass-hook-trust` only for the hook checks.

## Non-goals

- Reading Codex rollouts for the metrics and the retrospective (a later iteration; the run log
  keeps them).
- A Codex-only project that pins a package `ref` of its own (Codex has no committed marketplace
  pin that is confirmed; a team pins through `.claude/settings.json`).
- The Codex desktop app's own plugin install path (the docs restrict lifecycle hooks there to
  plugins installed by hand); the CLI is the target, the app is checked once and its result
  written down.
- The guide (18).

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `lib/runtime.mjs`: detection, homes, commands, session id | unit tests |
| 2 | Root `plugin.json` per plugin and `.agents/plugins/marketplace.json`, written by `scripts/manifests.mjs`; `check-release.mjs` fails on a difference | `npm test`; `codex plugin marketplace add` of a local clone lists every plugin |
| 3 | `adf` commands move to skills, with the two lines for the tokens; `adf-jira` skills get the two lines; `triggers.spec.mjs` reads skills | `npm test`; Claude Code: `/adf:init` runs as a skill in a scratch project |
| 4 | Scripts that print instructions and prompts substitute the plugin's directory | unit tests |
| 5 | `dispatch.mjs` prints the agent by runtime (Claude Code agent, or Codex effort and body); `schema/runtimes/claude-code.md` and `codex.md` | unit tests |
| 6 | Install records, the Superpowers gate and the refusals through `runtime.mjs`, with the TOML reader | unit tests on a fixture Codex home |
| 7 | Hooks: one input helper; the English check and the npm guard block in Codex; the notice shows | unit tests; `codex exec` in the scratch project |
| 8 | Update in Codex: notice and `pull` | unit tests with an injected `codex` |
| 9 | The ledger's session id; the metrics' null transcript figures with the reason | unit tests |
| 10 | `runlog.mjs collect` | unit tests on a fixture home and project |
| 11 | The scratch run in Codex: install, `/adf:init`, one small change from propose to archive with no forge, the run log collected; then the same `/adf:init` in Claude Code | the run's notes in `## Result` |
| 12 | README install section for Codex; release | `npm test`; `scripts/check-release.mjs` |
