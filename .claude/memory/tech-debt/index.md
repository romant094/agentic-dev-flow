# Technical Debt

Open technical debt, one entry per unit of work. This tree owns the **content** of the debt;
the issue tracker owns its **planning** — priority, estimate, assignee and status are set
there and never written here.

This file ships as a scaffold: the format below is the flow's, the blocks are yours. A host
project creates a block the first time an entry belongs to no existing one.

## How an entry is written

Each block is a directory whose `index.md` is a table:

| ID | Title | Anchors | Class | Source | Tracker |
|---|---|---|---|---|---|
| `<block>-00` | One line naming the action, not the symptom | `service.ts:663`, `service.ts:718`, `other.service.ts` | debt | `<change-name>` | |

- **ID** is a handle for cross-reference. It may change if an entry is re-filed.
- **Anchors** are the code sites this entry covers.
- **Class** is `defect` (the code is wrong), `debt` (a compromise taken knowingly) or
  `decision` (accepted, with the condition that would reopen it).
- **Source** is the change or the store the entry came from.
- **Tracker** is the issue key once the entry has been mirrored, and is the entry's identity.
  It is empty until a mirror exists, and one key belongs to one row — two rows carrying the
  same key identify nothing, and a sync pass reading the tree cannot tell which of them to
  reconcile against the issue. Two entries delivered by one commit are one entry with two
  anchor sets; merge the rows rather than sharing a key.

There is no status column and no counts anywhere in this tree. An entry exists while its
debt is open and is deleted when the debt is resolved; git history and the tracker both
retain what was closed. A field that can disagree with reality is a field this tree does not
carry.

**An empty Tracker cell means "not mirrored yet", and it can only mean that.** The invariant
holding it up is that every open entry is mirrorable work: the moment the tree admits an
entry nobody intends to file, an empty cell becomes ambiguous and every sync pass files
duplicates for the rest. A record that is not work — an accepted decision, a limitation
explained where its mechanism is documented — belongs in `concepts/`, not here.

## What is one entry

One entry is **one action**, not one code site. The same edit at twelve places is one entry
with twelve anchors. Two different edits are two entries even in one file — the test is
whether it can be delivered in one commit and reviewed once.

A **sub-block** is a heading inside a block's table, grouping entries that share a mechanism.
It is not a file and not a row.

A body file beside a block index exists only for an area that needs explaining. An entry that
a title and its anchors already describe gets no file, and an addition to an area that has one
is written into that file.

## Blocks

| Block | Covers |
|---|---|

<!--
One row per block, naming what it covers and linking to its index.md — for example a row
per top-level package, plus a `pre-release` block for work that must be finished before a
release regardless of which area it touches. No block exists until an entry needs it.
-->
