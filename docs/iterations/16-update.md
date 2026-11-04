# Iteration 16 — Update

## Goal

A project on an older release of the package learns at session start that a newer one exists,
and one person, the project's owner of the flow, brings it up to date with `/adf:update`: one
merge request that pins the new release, migrates the registry and merges the host files, with
the developer deciding every file the project has edited. The rest of the team gets the new
release with the merge. A user-scope install gets the same notice and its own update.

## Intent

The flow's concept is settled; later releases are fixes and improvements. The flow has no public
release, so there is no update path other than this command (iteration 16a documents only it).
A project's flow can fall behind the repository without anybody noticing, and an update by hand
touches several files whose rules nobody remembers.

## Settled by the developer (2026-11-03)

1. **One package version.** Every release of any plugin is a release of the whole package
   `agentic-dev-flow`: a new git tag. Any tag on GitHub is valid and the newest one is the
   latest; the developer publishes nothing that failed its checks.
2. **Where each version is read.**
   - The package version a project runs: the marketplace `ref` in the project's committed
     `.claude/settings.json`.
   - The plugin versions a project is configured for: a `version` on each registry entry in
     `.claude/adf-extensions.json` (new).
   - The latest package version: the newest tag of the repository on GitHub.
3. **The package version is written** in `.claude-plugin/marketplace.json` `metadata.version`
   (the Claude Code marketplace schema's "Marketplace version"), and the tag is
   `v<metadata.version>`. Each plugin keeps its own version, raised only when the plugin changes;
   it tells which plugin changed and whose `config` needs a migration.
4. **The notice.** At session start, when the project's `ref` is older than the latest tag, the
   session shows that release vX is available, the project is on vY, and `/adf:update` updates
   it. The same for a user-scope install, against its installed version. The notice does nothing
   else.
5. **One owner per project.** One person is responsible for the flow in a project: they run
   `/adf:update`, which opens the merge request, and they decide whether to tell the team. The
   team works on whatever the integration branch holds; after the merge, everybody is on the
   new release with no step of their own.
6. **What `/adf:update` does:**
   1. compares the project's `ref` with the latest tag, and shows which plugins changed (the
      registry's versions against the new tag's `marketplace.json`) and what is new in them;
   2. on the developer's yes, makes a branch and a worktree from the integration branch;
   3. in it: sets the new `ref` in `.claude/settings.json`; migrates the `config` of every
      changed plugin and writes its new version in the registry; merges the host files
      `/adf:init` and `/adf:add` wrote (item 7);
   4. commits, pushes and opens a merge request through the forge, its description listing the
      versions and the changes;
   5. tells the developer to restart the session so the new release loads.
7. **Host files the project edited** (`openspec/planning.md`, `openspec/review-prompt.md`, a
   plugin's `hostFiles` such as the merge request template). The command shows three versions:
   the template of the old release, the project's file, the template of the new release, and
   asks how to merge:
   - **automatic**, then a second question: *keep everything* (the agent carries the template's
     changes into the project's file and keeps the project's edits) or *replace from the update*
     (the file becomes the new release's template);
   - **manual**: the developer reads the three versions and decides.
8. **Changes in flight.** The command finds them (`openspec/changes/` outside `archive/`, the
   flow's worktrees) and warns, naming each. They continue on the new release; a conflict is
   settled inside its own change.
9. **The first update is by hand, once.** A project on `v0.18.1` has no `/adf:update` and no
   notice; its owner moves the `ref` to the first release that has them in a merge request of
   its own. Every later update goes through the command.
10. **A teammate after the merge.** The new `ref` reaches the teammate with the integration
    branch. Claude Code does not install it by itself (checked in step 4, see `## Result`): the
    session start finds the installed release older than the project's `ref` and offers one
    script that pulls the pinned release (`update.mjs pull`, run by `/adf:update`: the
    marketplace refresh and `claude plugin update` for this project). No other teammate step.
11. **Local plugins** (a project's own, for its domain, such as a `path` entry or another
   marketplace) are not the package's: the command does not check or update them.

## Calls made by the designer, not the developer

- A host file that equals the old release's template, unedited, is replaced with no question.
- The old release's template is read from the old tag (the marketplace clone or GitHub), not
  stored in the project.
- The notice is a `SessionStart` hook of the `adf` plugin. It reads the tags with
  `git ls-remote --tags` at most once a day (a cache in the user's Claude Code data directory), and
  says nothing and blocks nothing when the network or git fails.
- A registry `config` migration is the plugin's own: a plugin may ship ordered migration steps,
  one per version that changed its `config`, and the core runs the steps between the entry's
  version and the new one. A plugin with no step for a version keeps the `config` as it is.
- The contract version in the registry is raised to the new core's when it differs; a major
  contract change refuses the update and names both versions, as `/adf:add` does.
- A user-scope update has no merge request: it refreshes the marketplace and reinstalls the
  plugins, and reports the versions.
- The update runs the new release's code: `update.mjs` takes the new tag into a temporary clone
  (`git clone --depth 1 --branch <tag>`) and runs that release's migration steps, templates and
  merge from it. It never moves the global marketplace record (`known_marketplaces.json`), which
  every project on the machine shares.
- An entry with no `version` (every registry written before this iteration) takes the version
  from the old tag's `marketplace.json`; the update then runs only the migration steps after it.
- The sections of `openspec/planning.md` the flow's scripts write (the whole-suite command,
  worktree copies, worktree preparation, the format command) are values, not edits: the merge
  keeps them in every choice, *replace from the update* included, and compares only the rest.
  The merge base is the template at the project's current `ref`.
- *What is new* comes from `git log` between the two tags, one list per plugin by its path, from
  the Conventional Commits subjects; no changelog file.
- A user-scope install's version is its install record's version; its update refreshes the
  marketplace as the user's record declares it and reinstalls (it does not edit Claude Code's
  `known_marketplaces.json`, so a user marketplace pinned to a ref stays on it). When a project pins a `ref`, the project's notice and update
  apply in it, and the user-scope ones only outside such projects.
- Issues #12 and #14 are fixed in this iteration, before step 1.

## Non-goals

- Updating a project's local plugins.
- Rolling back to an older release (a revert of the merge request does it).
- Codex support: an iteration of its own (roadmap row 19).

## Depends on

- Issue #12: an install made at project scope by a teammate's project trust writes no install
  record, so `adf` skips the extension plugins. The update reinstalls; the new install must count.
- Issue #14: in the origin, `adf` commands ran scripts from a local clone of this repository, not
  from the pinned release. The update must run the release it installs; the command reports the
  plugin root it resolved and its version.

## Steps

| # | Step | Check |
|---|---|---|
| 1 | `metadata.version` in `marketplace.json`; a release check fails when the tag is not `v<metadata.version>` | `npm test` |
| 2 | A `version` on each registry entry, written by `/adf:add` and `/adf:init` from the plugin's manifest; an entry without one reads as unknown | `registry.spec.mjs` |
| 3 | `update.mjs check`: the project's `ref`, the latest tag, the changed plugins, the changes in flight; for a user-scope install the same against its installed version | unit tests on a fixture repository with tags |
| 4 | Check whether Claude Code installs a changed `ref` by itself after a pull; the `SessionStart` check: the notice of a newer tag, and `update.mjs pull` when the installed release is older than the project's `ref` from `update.mjs check`, cached once a day, silent on failure | a hook test; one session in a scratch project on an old tag |
| 5 | Registry migration: the declaration's migration steps, run in order between two versions | unit tests |
| 6 | Host file merge: unedited replaced; edited shows the three versions and takes the developer's choice | unit tests; the agent's automatic merge checked on one edited file |
| 7 | `/adf:update`: steps 6.1–6.5 above; the merge request through the forge, or a local branch with no forge | a scratch project from `v0.18.1` to the new tag |
| 8 | Release adf with the new tag | `npm test`, the scratch run of step 7 (parity is retired, `docs/roadmap.md`) |

## Result

Released as adf 0.19.0, adf-english-check 0.8.0, package `v0.19.0`.

Checks: `npm test` 1645 pass, 0 fail; `scripts/check-release.mjs` ok. Parity is retired from the
release steps (`docs/roadmap.md`, `## Checks after every iteration`): the switch removed the
origin's flow, so its tools have nothing to compare against.

### The scratch run (2026-11-04)

Run by the maintainer's agent with no developer step. A local bare repository held the package
at four tags (`v0.19.0`, `v0.19.1`, and after the fixes below `v0.19.2`, `v0.19.3`), with the
marketplace renamed `adf-sandbox` so the developer's own `agentic-dev-flow` record stayed
untouched (a clean `CLAUDE_CONFIG_DIR` has no login). A scratch project with a local bare origin
and no forge plugin enabled `adf` and `adf-memory` at project scope, with an edited
`openspec/review-prompt.md`. Interactive sessions were driven by `expect`; `/adf:update` ran
headless (`claude -p`, Sonnet), the developer's answers given in its arguments: about $0.15 per
update, $0.09 for the pull.

What was checked:
- **The notice.** The `SessionStart` hook's `systemMessage` shows in the interactive session:
  `SessionStart:startup says: ADF v0.19.1 is available; this project is on v0.19.0. Run
  /adf:update.` After the merge of an update: `This project pins ADF v0.19.1; v0.19.0 is
  installed. Run /adf:update to install it.`
- **`/adf:update` end to end**, twice: `plan`, `apply` from the new clone, the branch commit, the
  no-forge report, `cleanup`. An unedited template replaced (`planning.md`), an edited one merged
  with *Keep everything*: once clean, once through a `git merge-file` conflict the agent
  resolved, keeping the project's section and carrying the template's change.
- **Claude Code after a changed `ref`.** A session start moves the global marketplace record and
  its clone to the project's new `ref` and says "Plugins changed. Run /reload-plugins", but does
  not reinstall: the install record stays on the old release, also after `/reload-plugins`
  (the new version only lands in the cache). So `update.mjs pull` is needed.
- **`pull` in a session** (`/adf:update` with `pull` true): `claude plugin update` for each
  enabled package plugin; installed equals the pinned `ref` after it.
- **A teammate on the same machine** who clones the project and trusts it: no install record of
  its own, the plugins enabled at the pinned version from the shared cache; `check` reports
  installed equal to `ref`.

Defects found and fixed:
- F1: `where` warned "not from an installed release" when the Claude Code home is a symlink
  (node resolves the script's path, the home was compared unresolved). Fixed in `b234840`.
- F2: step 10 removed the clones with `rm -rf`, which Claude Code's safety check and a
  developer's hook block; the clones stayed. `update.mjs cleanup --clones` now removes only the
  directory `plan` made (`d97abcb`).
- F3: `pull` ran `claude plugin install`, which does nothing for an installed plugin; the
  refusal caught it. `pull` now runs `claude plugin update` for a plugin with an install record
  for the scope and `install` for the others (`3471a02`).
- F4 (not a defect of the port): `claude plugin marketplace update` from a shell follows the
  global record's `ref`, not the project's; only a session start moves the record. `pull` runs
  inside a session through `/adf:update`, so it is in order there.
- F5: the update specs left the clones of every `plan` in the system temporary directory (490
  directories). The specs remove them now (`0173adb`).

Not checked: the merge request path through a forge (the scratch project had none; `forge.mjs`
`open` and `finalize` are covered by unit tests), a teammate on another machine, a user-scope
update.

### The first update of a project on `v0.18.1`

`v0.18.1` has neither the notice nor `pull`, and Claude Code does not reinstall on a changed
`ref` (above). So:
1. The project's owner moves the `ref` in `.claude/settings.json` to `v0.19.0` in a merge request
   of its own. The registry entries need no `version`: an entry without one reads its version
   from the old tag's `marketplace.json`.
2. After the merge, each developer, on their own machine: pulls the integration branch, starts
   one Claude Code session in the project and closes it (this moves the marketplace record),
   then runs `claude plugin update <id> --scope project` for each enabled plugin of the package,
   in the project's main directory.
3. From `v0.19.0` on, the session start says when to update, and `/adf:update` does the rest.
