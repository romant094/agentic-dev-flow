# Iteration 17 — Codex: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The package installs and runs in Codex as well as in Claude Code, and a teammate's Codex run produces one log archive the port is fixed from.

**Architecture:** One module, `plugins/adf/scripts/lib/runtime.mjs`, owns every path, command and environment name that differs between the runtimes; the scripts ask it. Packaging for Codex: a root `plugin.json` (agent-plugins.org schema) per plugin and `.agents/plugins/marketplace.json`, generated from `.claude-plugin/` by `scripts/manifests.mjs`; the `adf` commands move to skills, which both runtimes read; a Codex dispatch carries its level's effort and text, and `schema/runtimes/<runtime>.md` maps the flow's words to each runtime's tools. `scripts/runlog.mjs collect` packs a run's sessions and records.

**Tech Stack:** Node 20+, standard library only, `node:test`; `git`, `claude` and `codex` through `execFileSync`, injectable for tests.

**Spec:** `docs/iterations/17-codex.md`

## Global Constraints

- English only in every artifact; Conventional Commits; no `Co-Authored-By` or tool credit.
- Gate every commit on the tests: `npm test && git commit ...`; push after each commit; never force, never amend, no `git stash`.
- The scripts use Node's standard library only (no TOML package: `lib/toml.mjs` reads the subset).
- Runtime names are exactly `claude-code` and `codex`; `ADF_RUNTIME` overrides detection.
- Versions live only in `.claude-plugin/`; the root `plugin.json` files and `.agents/plugins/marketplace.json` are generated and checked, never edited by hand.
- Agent-plugins schema URI: `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
- No Codex agent files in the host: in Codex a dispatch carries the level's `reasoning_effort` and the agent file's body; levels `mechanical`, `integration`, `architecture`.
- Flow text never names a model or a vendor (`schema/instructions/apply.md`).
- A script prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage error.
- Subagents never commit; the orchestrator commits and checks each commit for a forbidden trailer.

## Review Focus

1. A Claude Code session after the move to skills: `/adf:propose <name>` still gets its argument, and the metrics still find the slash-command marks in the transcript (Task 3 test `a skill invocation is marked like a command`, on a transcript fixture recorded from a real skill invocation in Task 11).
2. A machine with both runtimes installed and a script run from a local clone (neither cache): detection falls to the environment, then `claude-code`, never throws (Task 1 test `a clone with no runtime env is claude-code`).
3. A Codex `config.toml` with tables the reader does not know (`[mcp_servers.x.env]`, arrays, multi-line strings): the reader skips them and still reads `[plugins."<id>"] enabled` (Task 4 test `unknown shapes are skipped`).
4. A Codex hook not trusted yet: the notice and the guards do not run, and nothing says so; `/adf:init` in Codex says to trust them in `/hooks` (Task 6 step 3, the init text).
5. `runlog.mjs collect` in a project with no session in the window, or a session file that is not valid JSON on one line: the archive still writes, the empty or broken file named in `versions.json` `skipped` (Task 9 test `broken and missing sessions are named, not fatal`).

---

### Task 1: The runtime module

**Files:**
- Create: `plugins/adf/scripts/lib/runtime.mjs`
- Modify: `plugins/adf/scripts/lib/superpowers.mjs` (`claudeHome` stays, re-exported by runtime), `plugins/adf/scripts/lib/plugin-root.mjs` (reads `version` from `.claude-plugin/plugin.json`, unchanged; `cached` checks the runtime's cache)
- Test: `plugins/adf/scripts/__tests__/runtime.spec.mjs`

**Interfaces:**
- Produces:
  - `detectRuntime({ env, scriptPath, homes }) -> 'claude-code' | 'codex'`
  - `runtimeHome(runtime, env) -> string` (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`)
  - `sessionId(runtime, env) -> string | null` (`CLAUDE_CODE_SESSION_ID`; `CODEX_THREAD_ID`)
  - `cacheDir(runtime, home) -> string` (`<home>/plugins/cache` for both)
  - `cli(runtime) -> 'claude' | 'codex'`
  - `installCommand(runtime, id, scope) -> string` (`claude plugin install <id> --scope <scope>`; `codex plugin add <id>`)
  - `RUNTIMES = ['claude-code', 'codex']`

- [ ] **Step 1: Write the failing tests:** `ADF_RUNTIME wins`; `a script under the Codex cache is codex`; `a script under the Claude cache is claude-code`; `CODEX_THREAD_ID alone is codex`; `a clone with no runtime env is claude-code`; `a symlinked home is compared resolved` (as `plugin-root.spec.mjs` does); `sessionId reads the runtime's variable`.
- [ ] **Step 2: Run** `node --test plugins/adf/scripts/__tests__/runtime.spec.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `runtime.mjs`; order of detection: `ADF_RUNTIME`, script path under a resolved home's `plugins/cache`, `CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, default `claude-code`. `pluginRoot` takes the home from `runtimeHome(detectRuntime(...))` when none is passed.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): one runtime module for Claude Code and Codex`.

### Task 2: Codex manifests

**Files:**
- Create: `scripts/manifests.mjs`, `.agents/plugins/marketplace.json`, `plugins/<each>/plugin.json` (nine, generated)
- Modify: `scripts/check-release.mjs` (fails when a generated file differs from `manifests.mjs --check`)
- Test: `plugins/adf/scripts/__tests__/manifests.spec.mjs`

**Interfaces:**
- Produces: `node scripts/manifests.mjs [--check]` → `{ ok, written: [path], differ: [path] }`; exit 1 with `--check` when `differ` is not empty.

- [ ] **Step 1: Write the failing tests:** `root plugin.json carries the schema, name, version and description of .claude-plugin/plugin.json`; `extensions."com.openai".interface.displayName is the plugin name`; `the Codex marketplace lists every plugin of .claude-plugin/marketplace.json with source {source:"local", path:"./plugins/<name>"} and policy installation AVAILABLE`; `--check reports a hand-edited version`.
- [ ] **Step 2: Run** the spec. Expected: FAIL.
- [ ] **Step 3: Implement** `manifests.mjs`; root `plugin.json` fields only from the allowed set (`$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`); marketplace `name` `agentic-dev-flow`, `interface.displayName` `Agentic Dev Flow`; each entry `{ name, version, description, source: { source: "local", path: "./plugins/<name>" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }`, the shape of `addyosmani/agent-skills` `.agents/plugins/marketplace.json`.
- [ ] **Step 4: Run** `node scripts/manifests.mjs`, then `npm test`. Expected: files written; 0 failures.
- [ ] **Step 5: Verify in Codex:** `CODEX_HOME=<scratch>/codex-home /Applications/ChatGPT.app/Contents/Resources/codex plugin marketplace add <local clone>` then `codex plugin list --json` lists the nine plugins with their versions (no login is needed for these commands; if one is, record it and move the check to Task 11).
- [ ] **Step 6: Commit** `feat: agent-plugins manifests and the Codex marketplace`.

### Task 3: The adf commands become skills

**Files:**
- Move: `plugins/adf/commands/<name>.md` → `plugins/adf/skills/<name>/SKILL.md` (eleven: init, add, remove, propose, apply, verify, review, archive, land, retro, update), by `git mv`
- Modify: each moved file (frontmatter `name: <name>`; the two token lines), `plugins/adf-jira/skills/*/SKILL.md` (the two token lines), `plugins/adf/scripts/__tests__/triggers.spec.mjs`, `README.md` and `plugins/adf/contract/README.md` where they name `commands/`
- Test: `plugins/adf/scripts/__tests__/skills.spec.mjs`, `triggers.spec.mjs`, `transcripts.spec.mjs`

**Interfaces:**
- Produces: `plugins/adf/skills/<name>/SKILL.md` with frontmatter `name`, `description`, `argument-hint` and `effort` as the command had; the body's first lines, verbatim:

```
In a runtime that does not substitute them: `${CLAUDE_PLUGIN_ROOT}` is the directory two levels above this file's directory, and `$ARGUMENTS` is the text the developer wrote after this skill's name. Outside Claude Code, read `${CLAUDE_PLUGIN_ROOT}/schema/runtimes/<runtime>.md` first: it maps this text's dispatches and questions to your tools.
```

(For `adf-jira` skills the path is `<adf root>`, which `extensions.mjs where` prints; the line says so.)

- [ ] **Step 1: Write the failing tests** in `skills.spec.mjs`: `every adf skill has name equal to its directory`; `every skill that uses ${CLAUDE_PLUGIN_ROOT} or $ARGUMENTS carries the token line`; `plugins/adf/commands/ does not exist`. In `triggers.spec.mjs`, replace the assertion `no command was found` with `no adf skill was found`. In `transcripts.spec.mjs`, add `a skill invocation is marked like a command` (fixture added in Task 11; mark the test `todo` until then).
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Move and edit** the files; the token line goes right after the frontmatter.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Verify in Claude Code:** in a scratch project with the plugin installed from a local marketplace (the iteration 16 recipe, marketplace renamed `adf-sandbox`), `claude -p "/adf:init"` resolves the skill and prints its first step. If `argument-hint` or `effort` is rejected for a skill, drop that key and record it in the iteration's `## Result`.
- [ ] **Step 6: Commit** `refactor(adf): commands become skills that both runtimes read`.

### Task 4: Install records and the Superpowers gate in Codex

**Files:**
- Create: `plugins/adf/scripts/lib/toml.mjs`
- Modify: `plugins/adf/scripts/lib/installed.mjs` (`selectInstall`), `plugins/adf/scripts/lib/superpowers.mjs`, `plugins/adf/scripts/lib/registry.mjs:401-402` (the refusal commands)
- Test: `toml.spec.mjs`, `installed.spec.mjs`, `superpowers.spec.mjs`, fixture `plugins/adf/scripts/__tests__/fixtures/codex-home/`

**Interfaces:**
- Consumes: Task 1 `detectRuntime`, `runtimeHome`, `installCommand`.
- Produces: `readToml(text) -> { [table: string]: { [key: string]: string | boolean | number } }` (table names unquoted: `plugins.adf@agentic-dev-flow`); `selectInstall(id, root, { runtime, home, exists })` same return shape; in Codex the layers are `<home>/config.toml` then `<main>/.codex/config.toml`, the later wins; the install is the cache directory of the version in the marketplace clone (`<home>/.tmp/marketplaces/<marketplace>/` — `.agents/plugins/marketplace.json`, else `.claude-plugin/marketplace.json`, the plugin's `.claude-plugin/plugin.json` version), else the single version directory in the cache.

- [ ] **Step 1: Write the failing tests:** `toml reads quoted table names and booleans`; `unknown shapes are skipped`; `codex: an enabled plugin resolves to its cache directory`; `codex: enabled = false is disabled`; `codex: the project config overrides the user config`; `codex: the refusal names codex plugin add`; `superpowers gate passes in codex with superpowers@claude-plugins-official enabled and cached`.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Claude Code paths stay as they are; the runtime picks the branch.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): read Codex install records and enablement`.

### Task 5: Real paths in printed text; dispatch by runtime; the runtime references

**Files:**
- Modify: `plugins/adf/scripts/lib/dispatch.mjs` (the `schema` path at line 530; the agent fields), `plugins/adf/scripts/changes.mjs` (`instructions` output), `plugins/adf/scripts/init.mjs` (prints `trustHooks`), `plugins/adf/skills/init/SKILL.md`
- Create: `plugins/adf/schema/runtimes/claude-code.md`, `plugins/adf/schema/runtimes/codex.md`
- Test: `dispatch.spec.mjs`, `changes.spec.mjs`, `init.spec.mjs`

**Interfaces:**
- Consumes: Task 1 `detectRuntime`; `pluginRoot`.
- Produces: `substituteRoot(text, root) -> string` in `lib/plugin-root.mjs` (replaces every `${CLAUDE_PLUGIN_ROOT}`); `dispatchAgent(level, runtime, agentsDir) -> { agent: 'adf:<level>' } | { reasoningEffort: string, preamble: string }` in `lib/dispatch.mjs` (effort from the agent file's frontmatter `effort`, preamble its body); `dispatch.mjs prompt` prints these fields and, in Codex, puts `preamble` in front of the prompt file it writes.

`schema/runtimes/codex.md` holds, one short section each: dispatch (`spawn_agent` with the printed `reasoningEffort` and the prompt file's text; a round's dispatches in one turn; `wait_agent` for every one; `close_agent` after its reply is recorded); a question to the developer (plain chat text, then end the turn; `request_user_input` only in Plan mode); invoking a skill (`$<name>`, the syntax Task 11 observed); hooks (trusted once in `/hooks`). `claude-code.md` states the Agent tool with `subagent_type` `adf:<level>` and AskUserQuestion, in the same sections.

- [ ] **Step 1: Write the failing tests:** `instructions output names no ${CLAUDE_PLUGIN_ROOT}`; `prompt output names no ${CLAUDE_PLUGIN_ROOT}`; `claude-code dispatch names adf:integration`; `codex dispatch carries effort medium and the integration body, and the prompt file starts with it`; `every runtime reference has the same section headings`; `init prints trustHooks true in codex`.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement**; when `trustHooks` is true the init skill tells the developer: "Open /hooks once and trust the ADF hooks; Codex does not run a hook it has not trusted."
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): real plugin paths in printed text; dispatch and tools by runtime`.

### Task 6: Hooks in Codex

**Files:**
- Modify: `plugins/adf-english-check/scripts/hook.mjs`, `plugins/adf-npm-workspaces/scripts/guard.mjs` (header comments name both runtimes; input read unchanged unless a test fails)
- Test: `plugins/adf-english-check/scripts/__tests__/*.spec.mjs`, `plugins/adf-npm-workspaces/scripts/__tests__/*.spec.mjs`

- [ ] **Step 1: Write the tests** with a Codex-shaped input (`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit -m x"},"session_id":"<uuid>","cwd":"<dir>","turn_id":"t1","model":"x"}`): `the English check blocks a non-English commit from Codex input`; `the guard blocks npm install in a worktree from Codex input`. Take the exact field set from `codex-rs/hooks` PreToolUse input in the source before writing the fixture.
- [ ] **Step 2: Run.** Expected: PASS if the fields match (then only the comments change), else FAIL and Step 3 reads the command from the Codex field.
- [ ] **Step 3: Implement** only what Step 2 showed.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `test: the hooks block from Codex input`.

### Task 7: Update in Codex

**Files:**
- Modify: `plugins/adf/scripts/lib/update.mjs` (`installedVersion`, `checkUpdate`, `pull`, `noticeMessage`), `plugins/adf/scripts/update.mjs`, `plugins/adf/skills/update/SKILL.md`
- Test: `update.spec.mjs`, `update-cli.spec.mjs`

**Interfaces:**
- Consumes: Task 1 `cli`, `detectRuntime`; Task 4 `selectInstall`.
- Produces: `pull({ root, runtime, home, run })` where `run(cli, args, { cwd })` is injectable (replaces `claude`); in Codex: `codex plugin marketplace upgrade agentic-dev-flow`, then `codex plugin add <id>` for each enabled package plugin; when the project pins a `ref` in `.claude/settings.json`, first `codex plugin marketplace add romant094/agentic-dev-flow --ref <ref>` (the user's record is the only one Codex has).

- [ ] **Step 1: Write the failing tests:** `codex: notice compares the installed version with the latest tag`; `codex: notice takes the project's pinned ref`; `codex: pull runs upgrade then add for each enabled plugin`; `claude-code: pull runs as before` (existing tests pass the new `run`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Codex's `/adf:update` has no merge request for the user-scope part; the project part (registry, host files) runs as in Claude Code.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): the update notice and pull in Codex`.

### Task 8: Session id and metrics in Codex

**Files:**
- Modify: `plugins/adf/scripts/lib/ledger.mjs` (`SESSION_ENV` use in `buildRecord`/`appendRecord`), `plugins/adf/scripts/lib/verify.mjs:533`, `plugins/adf/scripts/lib/transcripts.mjs`, the metrics record writer
- Test: `ledger.spec.mjs`, `verify.spec.mjs`, `metrics.spec.mjs`

**Interfaces:**
- Consumes: Task 1 `sessionId`.
- Produces: ledger `session` records carry the runtime's id; metrics record gains `runtime`; in Codex the transcript figures are `{ value: null, reason: 'transcripts of runtime codex are not read' }`.

- [ ] **Step 1: Write the failing tests:** `ledger records CODEX_THREAD_ID in codex`; `verify compares the session by the runtime's id`; `metrics in codex: transcript figures null with the reason, record has runtime codex`. Check `contract/metrics-format.md` for the record shape and update it for `runtime`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): session id and metrics by runtime`.

### Task 9: The run log

**Files:**
- Create: `plugins/adf/scripts/runlog.mjs`, `plugins/adf/scripts/lib/runlog.mjs`
- Test: `runlog.spec.mjs`, fixtures under `__tests__/fixtures/runlog/`

**Interfaces:**
- Consumes: Task 1 `detectRuntime`, `runtimeHome`; `lib/transcripts.mjs` `encodeKeys` for Claude Code; `lib/workspace.mjs` for the worktree list.
- Produces: `node runlog.mjs collect [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--root <dir>]` → `{ ok, archive, bytes, sessions, changes, skipped, warning }`; archive `.adf/runlog/<to>-<runtime>.tar.gz` made with the system `tar` (`execFileSync('tar', ['-czf', ...])`); inside: `sessions/<file>`, `changes/<name>/...` (the change's `.superpowers/sdd/<name>/` and `openspec/changes/<name>/` record files), `registry.json`, `versions.json` (`runtime`, `runtimeVersion` from `<cli> --version`, `node`, `git`, `plugins: { id: version }`, `window`, `skipped`). Default window: the last 7 days. Codex sessions are matched by `session_meta.payload.cwd` against the main directory and the worktrees; Claude Code sessions by project key.

- [ ] **Step 1: Write the failing tests:** `codex rollouts of the project and its worktrees are packed, others are not`; `claude-code transcripts are packed by project key`; `broken and missing sessions are named, not fatal`; `the warning says the archive holds whole sessions`; `.adf/runlog/ is ignored by the host .gitignore lines` (`.adf/*` already ignores it: assert).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The script header documents the archive format.
- [ ] **Step 4: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 5: Commit** `feat(adf): runlog collect packs a run for the maintainer`.

### Task 10: README

**Files:**
- Modify: `README.md` (Install: a Codex section; Layout: `skills/`, `.agents/`, root `plugin.json`, `runlog.mjs`; Status: row for iteration 17)

- [ ] **Step 1: Write** the Codex install section:

```
codex plugin marketplace add romant094/agentic-dev-flow --ref v<version>
codex plugin marketplace add anthropics/claude-plugins-official
codex plugin add superpowers@claude-plugins-official
codex plugin add adf@agentic-dev-flow
```

then `$adf:init` (or `/skills`) in the project, trust the hooks in `/hooks`, and the run log: `node <adf root>/scripts/runlog.mjs collect`, the archive sent to the maintainer. Use the skill invocation syntax Task 11 observed, not this draft's, where they differ.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures.
- [ ] **Step 3: Commit** `docs: install and run log in Codex`.

### Task 11: The scratch run, both runtimes

No product code; defects found are fixed as their own tasks (failing test first, then fix, then commit), as in iteration 16.

The developer's Codex login is a ChatGPT account with a small limit (2026-11-04), so the Codex
part runs in two levels and the full cycle is the teammate's run on a real project, returned by
`runlog.mjs collect`.

- [ ] **Step 1: Set up**, by script in the scratchpad: a local bare repository of the package at a test tag `v0.20.0-rc1` (a tag on a scratch branch, never pushed); a scratch project with a local bare origin and no forge; a clean `CODEX_HOME` with a copy of the developer's `~/.codex/auth.json` (never read or printed; removed by script after the run).
- [ ] **Step 2: Codex, no model**: `codex plugin marketplace add`, `codex plugin add` for `adf`, `adf-memory`, `superpowers@claude-plugins-official`; `codex plugin list --json`. Check: every package plugin listed with its version, enabled; the `adf` skills found (from the plugin cache and the `codex` skill listing, if the CLI has one).
- [ ] **Step 3: Codex, a minimal model run** (`codex exec -C <project> --json --dangerously-bypass-hook-trust`, the cheapest model `-m` allows, each prompt one short task): the init skill invoked with the answers in the prompt, then the registry and `openspec/planning.md` checked; a non-English commit blocked by the English check; the notice in a second session. `runlog.mjs collect` packs these sessions. Record the tokens from `turn.completed` usage. Stop and tell the developer if a limit is reached; the rest goes to the teammate's run.
- [ ] **Step 4: Claude Code**: the same scratch project, `/adf:init` and `/adf:propose` as skills; record a transcript fixture of a skill invocation for the `transcripts.spec.mjs` `todo` test of Task 3 and make it pass.
- [ ] **Step 5: Write** `## Result` in `docs/iterations/17-codex.md`: what was checked, defects found and their commits, what was not checked (the desktop app if not run).
- [ ] **Step 6: Clean up** by script (no `rm -rf` through the shell hook); `npm test`.
- [ ] **Step 7: Commit** `docs(iterations): iteration 17 result`.

### Task 12: Release

- [ ] **Step 1:** Raise versions: `adf` and every plugin whose files changed (each changed: root `plugin.json` is new); package `metadata.version` `0.20.0`; `node scripts/manifests.mjs`.
- [ ] **Step 2: Run** `npm test`. Expected: 0 failures, `check-release.mjs` ok.
- [ ] **Step 3: Commit** `chore(release): v0.20.0`, tag `v0.20.0`, push the commit and the tag.
- [ ] **Step 4:** Tell the developer the teammate's install lines (Task 10) and how the run log comes back.
