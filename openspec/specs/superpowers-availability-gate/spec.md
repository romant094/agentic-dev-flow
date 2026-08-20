# Superpowers Availability Gate

## Purpose

Defines how the Superpowers plugin is declared as a project prerequisite, how its presence
is detected, and what happens when it is absent.

The workflow's execution discipline lives in that plugin's skills. The requirements below
fix the gate that makes its absence a hard stop rather than a silent downgrade: every
command that writes checks first, and no agent performs a missing skill's work by hand.

## Requirements

### Requirement: Superpowers is a declared project prerequisite

`.claude/settings.json` SHALL declare `enabledPlugins` with
`"superpowers@claude-plugins-official": true`, so that trusting the repository folder
prompts a contributor to install the plugin and Claude Code reports it as missing when it
is not installed.

#### Scenario: Contributor trusts the repository for the first time

- **WHEN** a contributor without the plugin opens the repository and trusts the folder
- **THEN** Claude Code reports the declared plugin as not installed and prints the
  install command

### Requirement: Plugin presence is detected from two independent facts

Detection SHALL treat the plugin as available only when both hold: an entry for
`superpowers@claude-plugins-official` exists in the user's `installed_plugins.json` with an
`installPath` that exists on disk, and `enabledPlugins` does not set that plugin to
`false`. A plugin that is installed but explicitly disabled MUST be treated as
unavailable. The plugin version MUST NOT be checked — presence only.

#### Scenario: Plugin installed but disabled

- **WHEN** the plugin is present on disk and `enabledPlugins` sets it to `false`
- **THEN** detection reports it as unavailable

#### Scenario: Entry present but directory missing

- **WHEN** `installed_plugins.json` names the plugin but its `installPath` does not exist
- **THEN** detection reports it as unavailable

### Requirement: Preflight gate on every command that writes

A preflight check SHALL run as the first step of `/opsx:propose`, `/opsx:apply`,
`/opsx:verify` and `/opsx:archive`, before anything is created or modified. When the plugin
is unavailable the check MUST print
`claude plugin install superpowers@claude-plugins-official` and stop the command before any
file is created or modified. Each of the four is checked independently, because a change
proposed in one session is applied, verified and archived in others.

`/opsx:archive` MUST NOT be exempted on the grounds that it only moves files: it is the one
command whose actions cannot be repeated — it merges the delta specs into the permanent
specifications, commits the archive move and the memory ingest, and removes the worktree —
so a degraded run there is the one that costs most. The read-only `/opsx:sync`
preview is the only command the gate does not cover, because it writes no file and invokes
no skill.

#### Scenario: Propose without the plugin

- **WHEN** `/opsx:propose` runs and detection reports the plugin unavailable
- **THEN** the install command is printed, the command stops, and no change directory is
  created

#### Scenario: Apply without the plugin

- **WHEN** `/opsx:apply` runs and detection reports the plugin unavailable
- **THEN** the install command is printed, the command stops, and no source file is
  modified

#### Scenario: Verify without the plugin

- **WHEN** `/opsx:verify` runs and detection reports the plugin unavailable
- **THEN** the install command is printed, the command stops, and no verification record
  is written

#### Scenario: Archive without the plugin

- **WHEN** `/opsx:archive` runs and detection reports the plugin unavailable
- **THEN** the install command is printed and the command stops before the change
  directory is moved, before any commit, and before the worktree is removed

#### Scenario: Plugin available

- **WHEN** detection reports the plugin available
- **THEN** the preflight check passes silently and the command proceeds

### Requirement: A failed skill invocation stops the workflow

The schema SHALL instruct that a failed skill invocation is a hard stop: the agent reports
which skill is missing and how to install it, and MUST NOT perform that skill's work
manually. The workflow MUST NOT contain any instruction permitting a fallback to manual
implementation when a skill is unavailable.

#### Scenario: Skill invocation fails mid-workflow

- **WHEN** an artifact's instruction invokes a Superpowers skill and the invocation fails
- **THEN** the agent stops, names the missing skill, and prints the install command
  instead of authoring the artifact itself
