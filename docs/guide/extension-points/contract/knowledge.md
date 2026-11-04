<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/scripts/lib/roles.mjs
- plugins/adf/scripts/lib/ingest.mjs
-->

# The knowledge role

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`knowledge` is a role. The provider owns the project's knowledge base. The core reads it before it designs. Archive puts into it what a change taught. The core never names a knowledge base path. It reads each path from the `context` operation. The contract is in [the contract README](../../../../plugins/adf/contract/README.md#knowledge-role-since-13).

| Operation | What it does |
|---|---|
| `context` | Returns the path of the index, the instructions of each workflow (`ingest`, `query`, `lint`, `fix`) and the globs an ingest may write. |
| `log` | Writes one log entry of type `ingest`, `query`, `lint` or `task`. The provider keeps its own housekeeping, such as a rotation. |
| `check` | Returns the mechanical faults of the knowledge base, or an empty list. |

The provider states its own time rule. The core passes no time.

## When it acts

| Stage | Use |
|---|---|
| [/adf:propose](../../cycle/propose.md) | Brainstorm reads the index. |
| [/adf:verify](../../cycle/verify.md) | The out-of-plan check allows every path that `context` names. An ingest that no plan names is not a finding. |
| [/adf:archive](../../cycle/archive.md) | The `ingest` step updates the knowledge base. The log entry records it. |

For the knowledge base and the debt tree, see [memory and debt](../../concepts/memory-and-debt.md).

## With no provider

- Brainstorm reads no index.
- Archive skips the ingest. Its report says so.
- No log entry is written.

## Providers

| Plugin | Notes |
|---|---|
| [`adf-memory`](../../plugins/adf-memory.md) | Provides `context`, `log` and `check`. Its `hostFiles` entries copy `index.md`, `log.md` and `system.md` into `.claude/memory/`. |
