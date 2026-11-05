# Changelog

This file lists the changes of each release of ADF.
The form is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A version is the package version in `.claude-plugin/marketplace.json`, and its tag is `v<version>`.
It lists the changes to the flow and its plugins. A change to the documentation alone is not listed and is not a release.

## [0.21.0] — 2026-11-05

### Added

- `/adf:quick`: a short cycle for a fix that changes no behaviour. It runs from a tracker key, a phrase or the open bugs to a merge request, then `/adf:land`. It writes one `quick.md`, runs only the affected tests and one review round.
- The quick task can gather the tracker and the debt store. It drops large items, an agent estimates the rest, and the developer selects.
- `## Affected tests command` in the planning guide. `/adf:init` proposes it, and `quick.mjs tests` runs it on the changed files of the branch.
- Contract 1.11: the tracker operation `bugs`. `scope.mjs gather --bugs` lists the open bugs and the open debt defects.
- `adf-jira` 0.6.0: the `bugs` operation, the newest updated bugs first.
- Contract 1.10: the `forge` operations `open` and `finalize` take `links`. The merge request description starts with a link to each tracker issue and debt entry of the scope.
- `adf-gitlab` 0.7.0: renders the links. A debt entry links to its file at the merge-base commit.
- The metrics record names its cycle, `full` or `quick`. `/adf:retro` reports quick changes as their own group.

### Changed

- The core schema is named `full`. A change whose metadata says `adf` reads as `full`.
- The merge request body no longer has to name the scope keys. The archive key check counts the keys of the links.
- A forge plugin declared before contract 1.10 gets the links at the top of the body at `finalize`.
- The retro aggregates and the delta cover full changes only.
- `/adf:land` gives the tester of a quick change its `quick.md`.

## [0.20.0] — 2026-11-04

### Added

- Codex support. The package runs in Codex as well as in Claude Code.
- Codex runs the hooks of `adf`, `adf-english-check` and `adf-npm-workspaces`.
- `adf-jira` finds the `adf` core in the plugin cache of each runtime.
- `/adf:retro` dispatches its agent in the form of the current runtime.
- The Codex marketplace, `.agents/plugins/marketplace.json`. Install with `codex plugin marketplace add romant094/agentic-dev-flow --ref v0.20.0`.
- A Codex manifest for each plugin, generated from its Claude Code manifest by `scripts/manifests.mjs`.
- The session-start notice of a new release and the pull step of `/adf:update` work in Codex.
- When a re-point of the Codex marketplace fails, the flow restores the marketplace record.
- `runlog.mjs collect`: it packs the sessions and the change records of a run into one archive for the maintainer. The archive holds no credential files and no private keys.

### Changed

- The commands are skills that both agents read. In Codex, invoke the skill by the name that `/skills` lists, for example `adf:init`.
- The scripts print the real plugin paths, and they name the agent tools of the current runtime.
- The flow reads the session id and the metrics by runtime. The flow does not read Codex sessions for metrics yet.

## [0.19.0] — 2026-11-04

### Added

- `/adf:update`: one merge request that moves the project to the latest release, or to the tag that `--to` names. It pins the new release, migrates the plugin configuration in the registry and merges the host files.
- The session-start notice. It tells you when a newer release exists, or when the installed release is not the pinned one. It runs git with a timeout, and it caches a failed check.
- The pull step of `/adf:update`: it installs the pinned release for a teammate or for a user-scope install. It runs `claude plugin update` for an installed plugin and `claude plugin install` for the others. When an install fails, it restores the settings file.
- `/adf:update` removes its temporary clones by script.
- Contract `1.9`: a plugin can declare migrations of its `config`, which `/adf:update` runs.
- One package version for the core and all plugins, in `metadata.version` of `.claude-plugin/marketplace.json`. `scripts/check-release.mjs` checks it against the plugin versions and the tag.
- The scripts report the plugin root that they run from. The report works when the Claude Code home is a symbolic link.

### Changed

- `adf-english-check` 0.8.0 checks the files of the commit that `/adf:update` makes.

### Fixed

- The flow finds a plugin that is installed for the main checkout when it runs in a worktree. A command that runs in a worktree also counts a project or local install record of that worktree.
- The flow finds a plugin that a trusted project enables with no install record, in the plugin cache.

### Upgrade from 0.18.1

Release 0.18.1 has no notice and no pull step. Do these steps once:

1. Move the `ref` in `.claude/settings.json` to `v0.19.0`, in a merge request of its own.
2. After the merge, each developer pulls the integration branch.
3. Each developer starts one Claude Code session in the project, then closes it.
4. Each developer runs `claude plugin update <id> --scope project` for each enabled plugin of the package.

From 0.19.0 on, the session start tells you when to update, and `/adf:update` does the rest.

## [0.18.1] — 2026-11-02

The first working release. Name `v0.18.1` as the `ref` of the marketplace. Do not use `v0.18.0`: its commit fails two tests.

### Added

- The core `adf`, on Superpowers, with no openspec CLI. Its commands are `/adf:init`, `/adf:add`, `/adf:remove`, `/adf:propose`, `/adf:apply`, `/adf:verify`, `/adf:review`, `/adf:archive`, `/adf:land` and `/adf:retro`.
- The main cycle: propose, apply, verify, review and archive. Each change has its own branch and worktree.
- The extension contract `1.8`, with the optional declaration field `requiredConfig`.
- The plugins `adf-gitlab` 0.6.0, `adf-english-check` 0.7.0, `adf-memory` 0.2.1, `adf-maintainer` 0.1.0, `adf-npm-workspaces` 0.2.0, `adf-postgres` 0.2.0, `adf-prisma` 0.1.0 and `adf-jira` 0.5.0.
- A checklist to switch a project from its own change flow to ADF, in one stage after a freeze.
