<!-- sources:
- plugins/adf/contract/debt-format.md
- plugins/adf/scripts/debt.mjs
- plugins/adf-memory/adf-extension.json
- plugins/adf-memory/instructions/**
-->

# Memory and technical debt

A project that uses the flow keeps two stores of knowledge. The wiki memory holds what the team learned about the system. The technical debt tree holds the debt that is known and not yet fixed. The Codex form of each command is in [the Codex page](../getting-started/codex.md).

## Wiki memory

The wiki memory is optional. The plugin `adf-memory` provides it through the `knowledge` role. Without a provider, the flow has no knowledge base. See [the knowledge role](../extension-points/contract/knowledge.md) and [adf-memory](../plugins/adf-memory.md).

The memory is a set of Markdown files in `.claude/memory/`:

| Path | Holds |
|---|---|
| `index.md` | One line for each page. |
| `system.md` | The overview of the system. |
| `entities/` | Pages about modules, components and services. |
| `concepts/` | Pages about patterns, protocols, workflows and decisions. |
| `log.md` | The log of the current month, newest entry first. |
| `log-archive/` | The logs of earlier months. It is read-only. |

The flow reads the index before `/adf:propose` designs a change. `/adf:archive` puts into the memory what the change taught. See [/adf:archive](../cycle/archive.md).

## The technical debt store

The debt tree is a Markdown tree. Its directory is `debt.root` in the registry, for example `docs/tech-debt`. `/adf:init` asks for it. See [the registry](registry.md). The normative format is `plugins/adf/contract/debt-format.md`.

```text
<debt.root>/
  index.md              the root index: one row for each block
  <block>/index.md      the open entries of the block
  <block>/resolved.md   the resolved entries, moved here by /adf:archive
  <block>/<topic>.md    an optional body file
  adf/index.md          the ADF records
  adf/<id>.md           the body of one ADF record
```

A block is an area of the code. A block id is in kebab-case. `debt.mjs add --block <id>` creates a missing block.

### An entry

A block index holds tables with these columns: `ID`, `Title`, `Anchors`, `Class`, `Source`, `Tracker`. A last column `Precedent` is optional.

| Column | Meaning |
|---|---|
| `ID` | `<block>-<number>`, with at least two digits. `debt.mjs add` allocates it. Nothing renumbers an id, and an id is never allocated twice. |
| `Anchors` | The code sites of the one action that the entry describes. |
| `Class` | `defect` (the code is wrong), `debt` (a compromise taken knowingly) or `decision` (a decision still to be made). |
| `Source` | The change or the store that the entry came from. |
| `Tracker` | The key of the tracker issue that mirrors the entry. It is empty until a tracker plugin writes it. |
| `Precedent` | The id of a resolved entry whose fix this entry may reuse. |

The tree has no status, assignee, priority or estimate column. The tree owns the content of the debt. A tracker plugin owns the planning.

### Resolved debt

When a change resolves an entry, `/adf:archive` moves its row to `resolved.md` of the block. The `resolved.md` table has the columns `ID`, `Title`, `Anchors`, `Class`, `Tracker`, `Resolved by` and `Date`. It drops the `Source` and `Precedent` columns of the block index. Later changes read how the debt was fixed. Open-debt counts ignore a resolved row.

### ADF records

The block `adf` holds the defects that the project found in the flow's own plugins. A record has the columns `ID`, `Title`, `Plugin`, `Version`, `Change`, `Class`, `Source` and `Filed`. A record goes upstream only through `/adf:retro`, which fills `Filed` with the URL of the issue. Without an upstream provider, the records stay in the project. See [/adf:retro](../cycle/retro.md).

### The check

`debt.mjs check` checks the tree. It refuses, among other faults, a table with other columns, a duplicate id, a class outside the vocabulary and a count of entries in prose. `/adf:init` and `/adf:add` run the check once the registry names a debt root, and they show its errors. The list of refusals is in `plugins/adf/contract/debt-format.md`.
