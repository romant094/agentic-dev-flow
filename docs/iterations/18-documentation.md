# Iteration 18 — Documentation

## Goal

A user guide in the repository, nested by section, from which a developer who has never seen the
flow installs it, runs a change from propose to land, adds a plugin and updates the flow with
`/adf:update`. The guide stays current in two stages: a script in `npm test` fails when a part of
the flow has no page, and an agent in every release step checks that the pages still say what
the changed code does.

## Structure

`docs/guide/` holds the user guide. `docs/iterations/`, `docs/lessons/` and `docs/roadmap.md` stay
where they are as the maintainer's records and are not part of it. `docs/switching.md` becomes a
guide page.

```
docs/guide/
  README.md                  the index: what the flow is, where to start, the section map
  getting-started/
    install.md               marketplace, project scope, /adf:init
    switching.md             a project with a flow of its own moves to the plugins
    first-change.md          one small change from propose to land
  cycle/
    README.md                the cycle on one page, the artifacts and where they live
    propose.md apply.md verify.md review.md archive.md land.md retro.md
  concepts/
    registry.md              .claude/adf-extensions.json, roles, contract versions
    worktrees.md             one branch and worktree per change, groups, provisioning
    capability-levels.md     mechanical, integration, architecture
    scope-and-tracker.md     scope sources, taken keys, the hand-off
    memory-and-debt.md       wiki memory, the technical debt store
    metrics.md               the metrics record, prices, the retrospective
  plugins/
    README.md                which plugin does what, what is skipped without it
    <one page per plugin>    adf-gitlab, adf-jira, adf-memory, adf-english-check,
                             adf-npm-workspaces, adf-postgres, adf-prisma, adf-maintainer
  projects/
    several-projects.md      several projects on one machine (inputs below)
    team.md                  what a teammate does after the merge request that installs the flow
  update.md                  /adf:update, the only update path
  troubleshooting.md         the refusals a developer meets and what to do
```

A plugin's own `README.md` stays short: what it provides and a link to its guide page, so each
fact has one place.

Each page names the files it describes in a front matter list, `sources:` (paths or globs under
`plugins/`). The script check and the agent check both read it.

The flow has no public release, so there is no update path before `/adf:update`: the guide
documents only the command.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `docs/guide/` with the index and the section skeleton above; `docs/switching.md` moves to `getting-started/` | `check-guide.mjs` |
| 2 | `getting-started/` and `cycle/`: each command page says what the command asks, writes, commits and how it resumes after a stop | the agent check (step 6) |
| 3 | `concepts/`, `plugins/` (the plugin READMEs move here and shrink to a link), `projects/`, `update.md`, `troubleshooting.md` | the agent check (step 6) |
| 4 | `README.md` of the repository: the current state (the plugin-first flow on `main`, the monolithic one on `adf-legacy`) and a link to the guide in place of the status table | read by the developer |
| 5 | Stage 1, by script: `scripts/check-guide.mjs` in `npm test`. Every command in `plugins/adf/commands/`, every plugin in `.claude-plugin/marketplace.json`, every contract role and every registry key has a page that names it; every file under `plugins/*/commands/`, `plugins/*/skills/` and `plugins/*/contract/` is in some page's `sources:`; every `sources:` entry and every relative link resolves | unit tests; a removed page or a new command without a page fails `npm test` |
| 6 | Stage 2, by reasoning: `scripts/guide-review.mjs` in every release step. The script takes the diff since the previous release tag, selects the pages whose `sources:` it touches, and builds one package; one read-only agent replies in JSON under a schema the port owns (a finding: page, claim, the source line that contradicts it, the fix), checked by script. A release goes out with no open finding | unit tests of the package and the reply check; one run on the release that adds the guide |
| 7 | The upkeep rule in `docs/roadmap.md`, `## Checks after every iteration`: 3. `check-guide.mjs` (in `npm test`); 4. `guide-review.mjs` with no open finding. A flow change updates its pages in the same commit | read by the developer |
| 8 | A scratch repository and a clean `CLAUDE_CONFIG_DIR` follow `getting-started/` to a passing `extensions.mjs check` and one change to land | the run's notes in the `## Result` |

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
  are on adf 0.17.2, the origin on 0.18.1.
- The marketplace record is global: `known_marketplaces.json` holds one `agentic-dev-flow`
  entry with one `ref`. When two projects pin different refs, the clone follows the last
  marketplace add or update. Not yet checked: what an install or a project trust in the other
  project then takes. To check for `projects/several-projects.md`.
- `adf` finds a plugin through the install record of the main directory, also from a worktree
  (`plugins/adf/scripts/lib/installed.mjs`, `mainCheckout`). An install made in a worktree does
  not count (issue #12).
- A teammate who trusts the project gets the marketplace clone and the cache but no install
  record, so `adf` skips the extension plugins (issue #12). `projects/team.md` waits for that fix.

## Decisions

Settled by the developer on 2026-11-03.

- After `/adf:update` (16), not before it: the origin's team already has the developer's own
  instructions for the current state, so the guide is not urgent, and after 16 it documents the
  update command too.
- The guide is nested by section in the repository, not one long page.
- No update path before `/adf:update`: the flow has no public release, so every update goes
  through the command, and the guide documents only it.
- The maintainer's records (iterations, lessons, roadmap) stay in `docs/` for now; the guide is
  `docs/guide/`.
- The guide is checked in two stages: a script finds a part of the flow with no page or a dead
  link, and an agent finds a page that no longer says what the code does.
- The switch's findings stay in the iteration 15 record; the guide does not repeat them.
- English only, STE style, like every other artifact.
- After Codex support (iteration 17), not before it (2026-11-04): the guide covers both Claude
  Code and Codex.
