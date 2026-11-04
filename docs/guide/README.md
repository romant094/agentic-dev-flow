# ADF user guide

## What the flow is

ADF (agentic dev flow) is a set of plugins for Claude Code and Codex. It runs a change through one cycle: propose, apply, verify, review and archive. Each phase writes a record in the project, so the next phase and the next developer can read it.

## Where to start

1. Install ADF in your agent: [Claude Code](getting-started/claude-code.md) or [Codex](getting-started/codex.md).
2. Make one small change: [Your first change](getting-started/first-change.md).
3. A project that already runs its own change flow: [Switching a project to the plugins](getting-started/switching.md).

## Section map

The sections of this guide, in reading order.

- [Install in Claude Code](getting-started/claude-code.md)
- [Install in Codex](getting-started/codex.md)
- [Your first change](getting-started/first-change.md)
- [Switching a project to the plugins](getting-started/switching.md)
- [The main cycle](cycle/README.md)
- [/adf:propose](cycle/propose.md)
- [/adf:apply](cycle/apply.md)
- [/adf:verify](cycle/verify.md)
- [/adf:review](cycle/review.md)
- [/adf:archive](cycle/archive.md)
- [/adf:retro](cycle/retro.md)
- [Extension points](extension-points/README.md)
- [The tracker role](extension-points/contract/tracker.md)
- [The forge role](extension-points/contract/forge.md)
- [The knowledge role](extension-points/contract/knowledge.md)
- [The upstream role](extension-points/contract/upstream.md)
- [The worktree hooks](extension-points/contract/provision-teardown.md)
- [The verify hook](extension-points/contract/verify-check.md)
- [The agents' own hooks](extension-points/agent-hooks.md)
- [Plugins](plugins/README.md)
- [adf-english-check](plugins/adf-english-check.md)
- [adf-gitlab](plugins/adf-gitlab.md)
- [adf-jira](plugins/adf-jira.md)
- [adf-maintainer](plugins/adf-maintainer.md)
- [adf-memory](plugins/adf-memory.md)
- [adf-npm-workspaces](plugins/adf-npm-workspaces.md)
- [adf-postgres](plugins/adf-postgres.md)
- [adf-prisma](plugins/adf-prisma.md)
- [The registry](concepts/registry.md)
- [Worktrees](concepts/worktrees.md)
- [Capability levels](concepts/capability-levels.md)
- [Memory and technical debt](concepts/memory-and-debt.md)
- [Metrics](concepts/metrics.md)
- [Host files](concepts/host-files.md)
- [Several projects on one machine](projects/several-projects.md)
- [What a teammate does](projects/team.md)
- [/adf:update](update.md)
- [Troubleshooting](troubleshooting.md)
- [Contributing](contributing.md)
