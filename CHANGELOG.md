# Changelog

This file lists the changes of each release of ADF.
The form is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
A version is the package version in `.claude-plugin/marketplace.json`, and its tag is `v<version>`.

## [Unreleased]

### Added

- A user guide in [`docs/guide/`](docs/guide/README.md): the install in Claude Code and in Codex, the main cycle, the extension points, each plugin, the concepts and the update.
- `scripts/check-guide.mjs`, in `npm test`: it fails when a skill, a plugin, an extension point or a registry key has no page, or when a link does not resolve.
- `guide-review`: an agent check, in each release step, that the guide pages still say what the changed code does.
- This changelog.
- Two rules in `scripts/check-release.mjs`: `CHANGELOG.md` must have a section for the package version, and every install command must pin the tag of that version.

### Changed

- The `README.md` is the product page. The install details, the host files, the layout and the tests moved to the guide.

## [0.20.0] — 2026-11-04

### Added

- Codex support. The package runs in Codex as well as in Claude Code.
- The Codex marketplace, `.agents/plugins/marketplace.json`. Install with `codex plugin marketplace add romant094/agentic-dev-flow --ref v0.20.0`.
- A Codex manifest for each plugin, generated from its Claude Code manifest by `scripts/manifests.mjs`.
- The session-start notice of a new release and the pull step of `/adf:update` work in Codex.
- `runlog.mjs collect`: it packs the sessions and the change records of a run into one archive for the maintainer. The archive holds no credential files and no private keys.

### Changed

- The commands are skills that both agents read. In Codex, invoke the skill by the name that `/skills` lists, for example `adf:init`.
- The scripts print the real plugin paths, and they name the agent tools of the current runtime.
- The flow reads the session id and the metrics by runtime. The flow does not read Codex sessions for metrics yet.

### Fixed

- Codex runs the hooks of `adf`, `adf-english-check` and `adf-npm-workspaces`. Before the fix, Codex loaded no hooks of these plugins.
- `adf-jira` finds the `adf` core in the plugin cache of each runtime.
- `/adf:retro` dispatches its agent in the form of the current runtime.
- When a re-point of the Codex marketplace fails, the flow restores the marketplace record.

## [0.19.0] — 2026-11-04

### Added

- `/adf:update`: one merge request that moves the project to the latest release, or to the tag that `--to` names. It pins the new release, migrates the plugin configuration in the registry and merges the host files.
- The session-start notice. It tells you when a newer release exists, or when the installed release is not the pinned one.
- The pull step of `/adf:update`: it installs the pinned release for a teammate or for a user-scope install.
- Contract `1.9`: a plugin can declare migrations of its `config`, which `/adf:update` runs.
- One package version for the core and all plugins, in `metadata.version` of `.claude-plugin/marketplace.json`. `scripts/check-release.mjs` checks it against the plugin versions and the tag.
- The scripts report the plugin root that they run from.

### Changed

- `adf-english-check` 0.8.0 checks the files of the commit that `/adf:update` makes.

### Fixed

- The flow counts a plugin install for a worktree, and for the cached plugin of a trusted project.
- The install check works when the Claude Code home is a symbolic link.
- The pull step runs `claude plugin update` for an installed plugin. Before the fix, it ran `claude plugin install`, which does nothing for an installed plugin.
- The pull step restores the settings file when a later install fails.
- `/adf:update` removes its temporary clones by script.
- The session-start notice runs git with a timeout, and it caches a failed check.

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
