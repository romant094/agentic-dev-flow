# Debt store format

The core keeps the host's open technical debt as a Markdown tree at the registry's `debt.root`
(`.claude/adf-extensions.json`, `{ "debt": { "root": "docs/tech-debt" } }`), set by `/adf:init`.
`scripts/debt.mjs` writes the tree and `debt.mjs check` checks it; `scripts/lib/debt.mjs` is the
parser. The tree owns the content of the debt; a tracker plugin owns its planning.

## Layout

```
<debt.root>/
  index.md              the root index: a "| Block | Covers |" table, one row per block
  <block>/index.md      the block's entries, as table rows
  <block>/<topic>.md    optional body file, only for an area that needs explaining
  adf/index.md          the records of kind adf
  adf/<id>.md           one body file per ADF record
```

A root row links its block: ``| [`snmp`](snmp/index.md) | SNMP transport |``. A block id is
kebab-case. `debt.mjs add --block <id>` creates a missing block and its root row.

## Entries

A block index holds tables with exactly these columns:

| ID | Title | Anchors | Class | Source | Tracker |
|---|---|---|---|---|---|
| `snmp-01` | Trailing index extracted in three places | `a.ts:12`, `b.ts:40,52` | debt | `some-change` | |

- **ID** is `<block>-<number>`, at least two digits, allocated by `debt.mjs add` as one more
  than the highest number the tree names for that block, in a row or in prose. Nothing
  renumbers an id, and an id still named anywhere in the tree is never allocated again.
- **The high-water line** ``Last id: `<block>-NN` `` in the block index names the highest id
  the block ever allocated: `add` and `adf` set it, `remove` keeps it (writing it when absent),
  so a removed id is never allocated again; a block index without it, written before it
  existed, is valid and gets it on its first add or remove.
- **Anchors** are the code sites of the one action the entry is: the same edit at twelve
  places is one entry with twelve anchors (`debt.mjs anchor`).
- **Class** is `defect` (the code is wrong), `debt` (a compromise taken knowingly) or
  `decision` (a decision still to be made). An accepted item is not work and gets no row.
- **Source** is the change or the store the entry came from.
- **Tracker** is the tracker's key once a tracker plugin has mirrored the entry, its identity:
  empty (or a dash) until then, and one key per row. The plugin writes it with
  `debt.mjs track --id <id> --key <key>`, once.

A **sub-block** is a heading (level two or deeper) above a table in the block index; the
entries of that table belong to it. It is never a row and never a file.

The tree carries no status, assignee, priority, estimate or other planning column, and no
count. An entry is deleted when its debt is resolved (`debt.mjs remove`); git keeps it.

## ADF records

The block `adf` holds the records of kind `adf`: defects of the flow's own plugins found while
a host used them. They go upstream only through the retrospective: its `file` step sends the
records with no Filed value to the `upstream` provider, the maintainer's plugin, and marks each
one filed with its issue's URL, as `debt.mjs mark-filed --id <id> --url <url>` does. With no
provider they stay on this machine.

| ID | Title | Plugin | Version | Change | Class | Source | Filed |
|---|---|---|---|---|---|---|---|
| `adf-01` | Verify reads the whole repository | `adf` | `0.9.0` | `my-change` | defect | `my-change` | |

- **Class** is `defect` (the code or the check is wrong), `deferred wording` (a rule stated
  twice whose deduplication changes what a surface says) or `decision` (a decision still to be
  made).
- **Filed** is the URL of the issue the record was filed as, once; empty until then.
- The body is `adf/<id>.md`: a heading naming the id and title, then the body text.

`debt.mjs adf --change <name> --file <json>` writes one record from
`{ plugin, pluginVersion, class, title, body, source? }`; `source` defaults to the change.
It always writes to the block `adf`.

A tree written before the kind was renamed keeps its records in the block `flow`, ids
`flow-<number>`, bodies `flow/<id>.md`. The reader takes that block as kind `adf` and checks it
by the same rules; `mark-filed` and `remove` work on its ids; no record is written to it.

## What `debt.mjs check` refuses

- a root index missing, or without its `Block | Covers` table; a block with no root row, a root
  row not linking `<block>/index.md`, a block with no `index.md`;
- a table whose columns are not exactly the block's columns, naming any planning or count
  column;
- a row whose ID is not an id of its block (a sub-block written as a row);
- a high-water line not of the form ``Last id: `<block>-NN` ``, a second one, or a row whose
  id is above it;
- a duplicate id, a duplicate tracker key or filed URL;
- an empty title or source, a class outside the block's vocabulary;
- an ADF record without plugin, version, change or body file, or with a filed value that is
  not a URL;
- a count of entries in an index's prose or headings;
- an id of a block named anywhere in the tree that no row carries, the high-water line aside.
