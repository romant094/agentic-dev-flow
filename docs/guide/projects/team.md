<!-- sources:
- plugins/adf/skills/update/**
- plugins/adf/scripts/update.mjs
- plugins/adf/scripts/lib/update.mjs
-->

# What a teammate does

One developer installs or updates the flow in a merge request. The other developers get the change with the merge. Each of them must also install the release that the project now pins. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## After the merge request

The merge request changes `.claude/settings.json`, which pins the release. It does not change the plugins that are installed on a teammate's machine. A changed pin alone does not update the install. In the checked case, Claude Code moved its marketplace record at the next session start and did not reinstall the plugins.

Each teammate does this once, after the merge request is merged:

1. Pull the integration branch.
2. Open Claude Code in the project.
3. Read the notice at the session start. It reads `This project pins ADF v<x.y.z>; v<a.b.c> is installed. Run /adf:update to install it.`
4. Run `/adf:update`.
5. Restart the Claude Code session.

In step 4, `/adf:update` runs `claude plugin update <id> --scope project` for each enabled plugin of the package that has an install record. It runs `claude plugin install` for the others. It restores `.claude/settings.json` afterwards. It refuses when that file has uncommitted changes.

After the restart, `update.mjs check` reports `pull` as false and `installed` equal to `ref`. For the update itself, see [/adf:update](../update.md).

## Why not `claude plugin install`

`claude plugin install` does nothing for a plugin that is already installed. Use `/adf:update` or `claude plugin update <id> --scope project`.

## A teammate who just cloned the project

A teammate on the same machine who clones the project and trusts it gets the plugins at the pinned version from the shared cache. This teammate needs no install step. See [Several projects on one machine](several-projects.md).

Not checked: a teammate on another machine, whose cache has no copy of the pinned release.
