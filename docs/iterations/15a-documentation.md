# Iteration 15a — Documentation

## Goal

A developer who has never seen the flow installs it in a project, runs a change from propose to
land, and updates it, from the repository's documentation alone. A team that shares the project
gets the same plugins without a step of its own. The documentation says what happens when one
machine has several projects with the flow at project scope.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `README.md` states the current state: the plugin-first flow is on `main`, the monolithic flow on `adf-legacy`; the status table ends at iteration 15 | read by the developer |
| 2 | `docs/install.md`: install at project scope from the marketplace by git URL and a pinned `ref`; `/adf:init`, `/adf:add`; why project scope and not user scope; what the teammates do after the merge request that installs the flow | a clean `CLAUDE_CONFIG_DIR` and a scratch repository follow it to a passing `extensions.mjs check` |
| 3 | `docs/usage.md`: the cycle `/adf:propose` → `apply` → `verify` → `review` → `archive` → `land`, what each command asks and writes, the resume after a stop, the optional plugins and what is skipped without them | each command named matches `plugins/adf/commands/` |
| 4 | `docs/projects.md`: several projects on one machine (inputs below) | each claim names the file or the record that shows it |
| 5 | Update until iteration 16: change the `ref`, refresh the marketplace, reinstall, migrate the registry by hand; replaced by `/adf:update` in 16 | the steps run on a scratch repository from `v0.18.1` to the current tag |
| 6 | Every plugin README has the same sections: what it provides, the registry entry and its `config`, the host files it adds, what fails without it | a script check in `npm test` |
| 7 | `docs/switching.md` takes the switch's own findings (iteration 15) | read by the developer |

## Inputs: several projects at project scope

Found on 2026-11-03 in `~/.claude/plugins/` on the developer's machine.

- Each project declares the marketplace and enables the plugins in its own tracked
  `.claude/settings.json`; its registry (`.claude/adf-extensions.json`) and the guide
  (`openspec/planning.md`) are its own. A plugin acts only in the sessions of a project that
  enables it, and a hook of `adf-english-check` or `adf-npm-workspaces` does nothing without a
  registry entry.
- The plugin code lives in a global cache, one directory per plugin version
  (`cache/agentic-dev-flow/<plugin>/<version>`). `installed_plugins.json` keeps one record per
  plugin and project path, so two projects run two versions side by side: the rehearsal clones
  are on adf 0.17.2, xnms on 0.18.1.
- The marketplace record is global: `known_marketplaces.json` holds one `agentic-dev-flow`
  entry with one `ref`. When two projects pin different refs, the clone follows the last
  marketplace add or update. Not yet checked: what an install or a project trust in the other
  project then takes. To check in step 4.
- `adf` finds a plugin through the install record of the main directory, also from a worktree
  (`plugins/adf/scripts/lib/installed.mjs`, `mainCheckout`). An install made in a worktree does
  not count (issue #12).
- A teammate who trusts the project gets the marketplace clone and the cache but no install
  record, so `adf` skips the extension plugins (issue #12). Step 2 depends on that fix.

## Decisions

- Documentation before `/adf:update` (16): the origin's team needs to install the flow now that
  the origin has switched.
- English only, STE style, like every other artifact.
