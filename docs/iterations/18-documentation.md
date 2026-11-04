# Iteration 18 — Documentation

## Goal

A developer who finds the repository on GitHub and has never seen the flow understands four
things from the first page: what ADF is, why to use it, what it does, and how to install it in
Claude Code or in Codex. From the user guide the same developer installs the flow, runs a change
through the cycle, adds a plugin and updates the flow with `/adf:update`. A changelog tells each
release's changes from `v0.18.1`, the first working release, on.

The guide stays current in two stages: a script in `npm test` fails when a part of the flow has
no page, and an agent in every release step checks that the pages still say what the changed
code does.

## Reader

A stranger on GitHub, not a teammate of the origin project: no knowledge of the flow, of the
origin's history or of the maintainer's records. Every page is written for that reader.

## Structure

### The first page: `README.md`

The repository's `README.md` becomes the product page, on the pattern of
`addyosmani/agent-skills` (`README.md` on its `main`). In this order:

1. Title, a one-line tagline, and a text diagram of the main cycle:
   `propose → apply → verify → review → archive`. `land` is not in the main cycle (see
   *Extension points*). `retro` is shown apart from the cycle: it looks back over archived
   changes and is not a stage of one change.
2. **Commands**: a table, one row per command of the core (`plugins/adf/skills/`): command,
   when to use it, what it does. `/adf:land` is in the table with the mark *optional — needs a
   tracker plugin*.
3. **Quick start**: one collapsible `<details>` block per agent, Claude Code and Codex, each with
   the exact install commands and a link to that agent's install page.
4. **Plugins**: a table, one row per plugin in `.claude-plugin/marketplace.json` other than
   `adf`: plugin, one-line description, when a project needs it, link to its guide page.
5. **How it works**: the core and the plugins, the registry, one branch and worktree per change;
   links to the extension points and the concepts.
6. **Why ADF**: full control of a change, from the gathered context, the plans and the
   decomposition to the review, the verification and the delivery of the code; and flexibility,
   because a project enables only the plugins it needs. ADF is built on two foundations, and the
   section says in one line each what each gives:
   - **OpenSpec**: the spec-driven model. The specs say what the system must do, and each change
     carries its proposal, design, delta specs and tasks in `openspec/changes/`. ADF ships its
     own engine and schema for this model, with no openspec CLI (iteration 03).
   - **Superpowers**: the agent's working skills, a dependency of `adf` — brainstorming, writing
     plans, test-driven development, subagent-driven execution, worktrees, code review and
     verification before completion.
   - **ADF** joins them into one cycle and adds what neither has: the gates between the stages,
     scripts for every deterministic step, structured agent replies checked by script, the
     review rounds, the delivery through a forge, metrics, and the extension points.
   No cost figures and no comparison with other tools: the measured figures come from test
   runs.
7. **Documentation**: link to `docs/guide/README.md` and to `CHANGELOG.md`.
8. **Contributing** (issues and pull requests are welcome; link to `docs/guide/contributing.md`)
   and **License**.

The status table by iteration leaves the `README.md`; `docs/roadmap.md` already holds the order
and the state of each iteration. The `## Layout`, `## Tests` and `## Host files` sections move to
guide pages (`concepts/` and a contributor page); the `README.md` links to them.

### `CHANGELOG.md`

At the repository root. One section per package version, newest first, from `v0.18.1` to the
current version, in the *Keep a Changelog* form, with an `## [Unreleased]` section on top for
the work after the last tag (this iteration's guide is there), (`## [x.y.z] — YYYY-MM-DD`, with `Added`,
`Changed`, `Fixed`, `Removed` as needed). Each entry is written for the stranger: what changed
for a user of the flow, not which iteration did it. The sources for the existing entries are the
tags, `git log` between them, and the iteration records. `v0.18.0` has no section: it fails two
test assertions and `v0.18.1` replaced it; the `v0.18.1` section is the first working release.

### The user guide: `docs/guide/`

`docs/iterations/`, `docs/lessons/` and `docs/roadmap.md` stay where they are as the
maintainer's records and are not part of the guide. `docs/switching.md` becomes a guide page.

```
docs/guide/
  README.md                  the index: what the flow is, where to start, the section map
  getting-started/
    claude-code.md           install in Claude Code: marketplace, project scope, /adf:init
    codex.md                 install in Codex: marketplace, user scope, adf:init, /hooks trust
    switching.md             a project with a flow of its own moves to the plugins
    first-change.md          one small change from propose to archive
  cycle/
    README.md                the main cycle on one page, the artifacts and where they live
    propose.md apply.md verify.md review.md archive.md
    retro.md                 the retrospective, apart from the cycle
  extension-points/
    README.md                the full cycle with land, and where each point acts
    contract/
      tracker.md             the tracker role; /adf:land is documented here
      forge.md               the forge role; without it archive merges locally
      knowledge.md           the knowledge role
      upstream.md            the upstream role
      provision-teardown.md  the worktree hooks
      verify-check.md        the verify hook
    agent-hooks.md           the agents' own hooks: the English check, the npm guard,
                             the session-start update notice
  plugins/
    README.md                which plugin does what, what is skipped without it
    <one page per plugin>    adf-english-check, adf-gitlab, adf-jira, adf-maintainer,
                             adf-memory, adf-npm-workspaces, adf-postgres, adf-prisma
  concepts/
    registry.md              .claude/adf-extensions.json, roles, contract versions
    worktrees.md             one branch and worktree per change, groups, provisioning
    capability-levels.md     mechanical, integration, architecture
    memory-and-debt.md       wiki memory, the technical debt store
    metrics.md               the metrics record, prices, the retrospective's numbers
    host-files.md            what the flow writes into a project
  projects/
    several-projects.md      several projects on one machine (inputs below)
    team.md                  what a teammate does after the merge request that installs the flow
  update.md                  /adf:update, the only update path
  troubleshooting.md         the refusals a developer meets and what to do
  contributing.md            the repository layout and its tests
```

Two kinds of page describe one plugin from two sides, and each fact has one place:

- An **extension point** page says what the point is, when in the cycle it acts, and what the core
  does with no provider. It names the plugins that provide it.
- A **plugin** page says how to install, enable and configure the plugin, and what it does. It
  links to the points it provides.

Each agent difference has one place too: the install pages say how each agent installs, invokes
a command and trusts a hook. The other pages name a command in the Claude Code form
(`/adf:propose`) and link to `getting-started/codex.md` for the Codex form, once per page.

A plugin's own `README.md` shrinks to what it provides and a link to its guide page.

Each page names the files it describes in a front matter list, `sources:` (paths or globs under
`plugins/`). The script check and the agent check both read it.

The flow has no public release before this one, so there is no update path before
`/adf:update`: the guide documents only the command.

## Language

Every page of the guide, the `README.md` and the `CHANGELOG.md` is written in ASD-STE100
Simplified Technical English: one idea per sentence, at most 20 words in a procedure sentence and
25 in a description, active voice, the imperative for a step, one step per action, one term per
concept. Command names, file names and code identifiers stay as they are.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `docs/guide/` with the index and the section skeleton above; `docs/switching.md` moves to `getting-started/` | `check-guide.mjs` |
| 2 | `getting-started/` and `cycle/`: each command page says what the command asks, writes, commits and how it resumes after a stop; each install page holds the commands of its agent, taken from the code and from `docs/iterations/17-codex.md` | the agent check (step 6) |
| 3 | `extension-points/`, `plugins/` (the plugin READMEs move here and shrink to a link), `concepts/`, `projects/`, `update.md`, `troubleshooting.md`, `contributing.md` | the agent check (step 6) |
| 4 | `README.md` as the product page and `CHANGELOG.md` from `v0.18.1` | read by the developer |
| 5 | Stage 1, by script: `scripts/check-guide.mjs` in `npm test`. Every skill in `plugins/adf/skills/`, every plugin in `.claude-plugin/marketplace.json`, every contract point in `plugins/adf/contract/README.md`, every registry key and every agent hook in `plugins/*/hooks/hooks.json` has a page that names it; every file under `plugins/*/skills/`, `plugins/*/commands/`, `plugins/*/contract/` and `plugins/*/hooks/` is in some page's `sources:`; every `sources:` entry and every relative link resolves. The registry keys are the top-level keys and the fields of an extension entry; a plugin's own `config` keys are on its page and the script does not check them. `scripts/check-release.mjs` also refuses a `metadata.version` with no section in `CHANGELOG.md`, and a pinned tag in an install command of the guide or the `README.md` that is not `v<metadata.version>` | unit tests; a removed page, a new skill with no page, a release with no changelog section or a stale pinned tag fails `npm test` |
| 6 | Stage 2, by reasoning: `scripts/guide-review.mjs` in every release step, on the pattern of `review.mjs`. `input` takes the diff since the previous release tag, selects the pages whose `sources:` it touches and the pages the diff itself adds or changes, and writes one package per guide section; the maintainer's session dispatches one read-only agent per package; the agent replies in JSON under a schema the port owns (a finding: page, claim, the source line that contradicts it, the fix), and `check` validates the reply. A release goes out with no open finding; that is the maintainer's rule in `docs/roadmap.md`, with no committed record | unit tests of `input` and `check`; one run on this branch, from `v0.20.0`, which selects every page of the guide |
| 7 | The upkeep rule in `docs/roadmap.md`, `## Checks after every iteration`: 3. `check-guide.mjs` (in `npm test`); 4. `guide-review.mjs` with no open finding; 5. a release adds its `CHANGELOG.md` section. A flow change updates its pages in the same commit | read by the developer |

This iteration makes no release: the guide goes to `main` by its PR, and `metadata.version`
stays `0.20.0` (the developer, 2026-11-04). The next release takes the `## [Unreleased]`
section.

There is no scratch run in this iteration (the developer, 2026-11-04): Claude Code was run end to
end up to iteration 15, and a teammate checks Codex on a real project. Every provider claim in
the guide is taken from the code or from the iteration records, never from memory, and the agent
check reviews it.

## Inputs: several projects at project scope

Found on 2026-11-03 in `~/.claude/plugins/` on the developer's machine.

- Each project declares the marketplace and enables the plugins in its own tracked
  `.claude/settings.json`; its registry (`.claude/adf-extensions.json`) and the guide
  (`openspec/planning.md`) are its own. A plugin acts only in the sessions of a project that
  enables it, and a hook of `adf-english-check` or `adf-npm-workspaces` does nothing without a
  registry entry.
- The plugin code lives in a global cache, one directory per plugin version
  (`cache/agentic-dev-flow/<plugin>/<version>`). `installed_plugins.json` keeps one record per
  plugin and project path, so two projects run two versions side by side.
- The marketplace record is global: `known_marketplaces.json` holds one `agentic-dev-flow`
  entry with one `ref`. When two projects pin different refs, the clone follows the last
  marketplace add or update. Not checked: what an install or a project trust in the other
  project then takes. The page says so.
- `adf` finds a plugin through the install record of the main directory, also from a worktree
  (`plugins/adf/scripts/lib/installed.mjs`, `mainCheckout`). An install made in a worktree does
  not count.
- A teammate who trusts the project: issue #12, fixed in iteration 16 by the `pull` path; after
  the merge request that installs or updates the flow, each teammate runs `/adf:update` once and
  restarts.
- Codex installs at user scope (`docs/iterations/17-codex.md`), so the several-projects page has
  one section per agent.

## Decisions

Settled by the developer on 2026-11-03.

- After `/adf:update` (16), not before it.
- The guide is nested by section in the repository, not one long page.
- No update path before `/adf:update`: the guide documents only the command.
- The maintainer's records (iterations, lessons, roadmap) stay in `docs/`; the guide is
  `docs/guide/`.
- The guide is checked in two stages: a script finds a part of the flow with no page or a dead
  link, and an agent finds a page that no longer says what the code does.
- The switch's findings stay in the iteration 15 record; the guide does not repeat them.

Settled by the developer on 2026-11-04.

- After Codex support (iteration 17): the guide covers both Claude Code and Codex.
- The reader is a stranger on GitHub. The first page says what ADF is, why to use it, what it
  does and how to install it; its base is the `README.md` of `addyosmani/agent-skills`.
- Each tool has its own page: each plugin and each agent. The first page gives each a short
  description and a link.
- A `CHANGELOG.md`, from `v0.18.1`, the first working release.
- `land` leaves the main cycle. A separate section, *Extension points*, shows the full cycle and
  where the plugins act; `land` is documented there, under the tracker.
- The extension points section has two parts: the contract points, and the agents' own hooks
  (the English check is there).
- Both checks stay in this iteration.
- No scratch run.
- ASD-STE100 for the guide.
- *Why ADF* says: full control from the context, the plans and the decomposition to the review,
  the verification and the delivery; and flexibility. No cost figures: they come from test runs.
- *Why ADF* also says that ADF is built on OpenSpec and Superpowers, and what each gives.
- Outside pull requests are welcome.
- The iteration makes no release; it is documentation only.

Calls made in the design, open to the developer's review:

- Branch `feat/18-documentation` and a PR into `main`, as for iteration 17.
- The changelog form is *Keep a Changelog*; `check-release.mjs` refuses a version with no section.
- `guide-review.mjs` works as `review.mjs` does: the script builds the packages and checks the
  replies, the maintainer's session dispatches the agents.
- `plugins/adf/contract/README.md` stays the normative contract for plugin authors; the
  `extension-points/` pages explain each point to a user and link to it.
- The install commands pin the current tag, and `check-release.mjs` keeps the pin current.
- Command pages use the Claude Code form and link once to the Codex install page for its form.
- `README.md` sections `## Layout` and `## Tests` move to `contributing.md`, `## Host files` to
  `concepts/host-files.md`.
- `scope-and-tracker.md` of the earlier draft becomes `extension-points/contract/tracker.md`.

## Result

### Checks run

- `npm test` at the last commit of this task: 1757 tests, 1752 pass, 0 fail, 5 skipped.
  `check-guide.mjs` inside it: `ok: true`, `errors: []`. `check-lessons.mjs`: `ok: true`,
  `errors: []`.
- One `npm test` run during Task 5 showed 1 failure that nobody identified. Two reruns showed 0
  failures, and the failure did not reproduce. It stays unexplained.
- First run of `guide-review.mjs`: `node scripts/guide-review.mjs input --from v0.20.0 --out
  .superpowers/sdd/18-documentation-plan/guide-review`, run at 78b6c82. It wrote 6 packages with
  40 pages, which is every page of the guide. Six read-only agents replied. `check` accepted all
  six replies: `ok: true`, 0 errors.
- Findings: concepts 1, plugins 4, cycle 0, extension-points 0, getting-started 0, projects 0.
- Rerun at a1e3b18 of concepts and plugins (from v0.20.0): concepts 0; plugins 2 new findings (adf-memory `pages`/`excluded` are counts; adf-postgres teardown checks a non-empty config for every worktree) — fixed in the final fix wave.
- Final whole-branch review (opus): ready with fixes — 5 Important, 16 Minor; fixed in 4e20bac, e2d9dbc, 0adada1 (scoped re-review: all addressed).
- guide-review of the pages the fix wave changed (`input --from a1e3b18`, 20 pages, 6 packages, all replies valid): 2 findings (registry.md `points` warning; adf-jira partial hand-off with no initial status) — fixed in the last commit of the branch.
- Found: plugins/adf/contract/README.md:271 says the registry check warns about an entry with no `points`; the code does not (registry.mjs:383-410). Not changed in this iteration.

### Findings and fixes

Each finding was checked against the cited source line first. All 5 were true. The fixes are in
the commit `docs(guide): fix the guide-review findings`.

| Page | Finding | Fix |
|---|---|---|
| `concepts/memory-and-debt.md` | `resolved.md` has more than two added columns | Lists all 7 columns and the dropped `Source` and `Precedent` (`debt-format.md:69`) |
| `plugins/adf-gitlab.md` | A degraded `check` carries no `fallback` | `open`, `finalize` and `state` carry it; `check` does not (`forge.mjs:234`) |
| `plugins/adf-jira.md` | The comment of a partial hand-off does check a status when the issue moves back | The comment row expects `statuses.initial` when the plan routes the issue back (`tracker.mjs:503`) |
| `plugins/adf-maintainer.md` | `change` and `source` of a debt record are optional | Marked optional; refusal covers unknown and missing required fields (`upstream.mjs:149`) |
| `plugins/adf-postgres.md` | Teardown with a `null` branch is done, not refused | Provision refuses; teardown drops nothing and returns a note (`postgres.mjs:330`) |

### What the task reviews found and fixed

- Task 1: clean; 6 minors deferred (`guide.mjs` edge cases, untested CLI shape).
- Task 2: 3 Important (pages with no sources; plugin pages citing only the marketplace; pages not citing code); fixed in 1 round.
- Task 3: 2 Important (a `/reload-plugins` claim the code contradicts; first install not marked "Not checked"); fixed in 1 round.
- Task 4: 2 Important (review defaults wrongly marked "Not checked"; archive "What it asks" listed non-questions); fixed in 1 round.
- Task 5: 1 Important (`forge.md` claimed a check before every operation); fixed in 1 round.
- Task 6: approved with minors (a dropped `isOurEntry` fact, lost small facts, a few sentences over 25 words); the lessons evidence and the parity replay moved to the guide pages.
- Task 7: 2 Important (a `v0.18.1` manual update path against the spec; an incomplete install lookup in several-projects); fixed in 1 round.
- Task 8: 1 Important (CHANGELOG `Fixed` entries for defects no release shipped); fixed in 1 round.
- Task 9: approved; minors deferred (run on a committed tree; all-or-nothing reply check).
- Rulings: Task 6 moves lessons evidence to the guide; remove the `v0.18.1` update path; guide prose says "main checkout"; README keeps a Quick start link under the diagram.

### Stale input in this spec

The input "An install made in a worktree does not count" is stale. `plugins/adf/scripts/lib/installed.mjs:46` counts a project or local install record of the current worktree for commands run in that worktree.

### Not checked

- A run in a scratch project (the developer's decision, 2026-11-04).
- The first Claude Code install on an empty machine.
- The Codex items that each page marks "Not checked".
- The deferred minors listed above.
