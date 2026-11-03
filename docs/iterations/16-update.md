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
    branch. When Claude Code does not install it by itself (not checked yet, step 4), the session
    start finds the installed release older than the project's `ref` and runs, or offers, one
    script that pulls the pinned release (`update.mjs pull`: the marketplace refresh and the
    reinstall for this project). No other teammate step.
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
- A user-scope install's version is its install record's version; its update pins the new tag in
  the user's marketplace record. When a project pins a `ref`, the project's notice and update
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
| 8 | Release adf with the new tag | `npm test`, `npm run parity -- <origin>` |
