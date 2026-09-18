# Technical Debt Ledger

## Purpose

Defines the one store the repository keeps for open product debt: a three-level tree under
`.claude/memory/tech-debt/` whose block indexes are the machine-readable surface a mirror
reads, and whose entries are units of work rather than units of code.

The requirements below fix what keeps that store usable — the shape of the tree, the rule
that an entry is one action however many code sites it touches, the fields an entry carries
and the planning fields it deliberately does not, the obligation that the flow's own
deferred findings and debt lines land here before a change archives, and the prohibition on
a second parallel list of open debt.

## Requirements

### Requirement: The ledger is a three-level tree with a machine-readable middle level

Technical debt SHALL be recorded in a tree rooted at `.claude/memory/tech-debt/`. The root
`index.md` MUST carry one row per block, naming what the block covers and linking to it.
Each block MUST be a directory whose `index.md` is a table with one row per entry. A body
file beside a block index MAY carry the explanation for an area that needs one, and MUST NOT
be created for an entry that a title and its anchors already describe.

No consolidated table of every entry SHALL be generated or stored. The block indexes are the
machine-readable surface, and a reader that needs every entry reads them.

#### Scenario: A block is added

- **WHEN** a debt entry belongs to no existing block
- **THEN** a directory is created for the new block, its `index.md` carries the entry, and
  the root index gains a row linking to it

#### Scenario: An entry needs no explanation

- **WHEN** an entry is a title and a list of code sites with nothing further to explain
- **THEN** it is a row in its block's index and no body file is created for it

#### Scenario: Something wants the whole ledger

- **WHEN** a reader or a later tool needs every open entry
- **THEN** it reads the block indexes, because no generated roll-up file exists

### Requirement: An entry is one action, not one code site

An entry SHALL cover one action — the work that can be delivered in one commit and reviewed
once. When the same edit applies at several code sites, those sites MUST be anchors on a
single entry rather than separate entries. When two edits differ, they MUST be separate
entries even when they share a file or a mechanism.

A sub-block SHALL group entries that share a mechanism, as a heading within its block's
index, and MUST NOT be a separate file or a separate row.

#### Scenario: One edit repeated across many sites

- **WHEN** the same correction applies at twelve call sites
- **THEN** the ledger carries one entry listing twelve anchors

#### Scenario: Two different edits in one file

- **WHEN** two corrections apply to the same file but neither informs the other
- **THEN** the ledger carries two entries, because neither can be delivered by doing the other

#### Scenario: Entries share a mechanism

- **WHEN** several entries hang off one mechanism within a block
- **THEN** they sit under a sub-block heading inside that block's index, and no file or row
  is created for the sub-block itself

### Requirement: An entry carries the fields a mirror needs and nothing it cannot keep true

An entry row SHALL carry an identifier, a title, its anchors, its class, its source, and a
tracker key. The class MUST be one of `defect`, `debt` or `decision`. The tracker key MUST be
empty until the entry has been mirrored, and once written it is the entry's identity — the
row identifier is a handle for cross-reference and MAY change.

An entry row MUST NOT carry a status, an assignee, a priority or an estimate, and an index
in the tree MUST NOT carry a count of the rows beneath it. An entry exists while its debt is
open and SHALL be deleted when the debt is resolved.

#### Scenario: An entry is resolved

- **WHEN** the debt an entry records has been fixed
- **THEN** the row is deleted from its block index, rather than marked closed

#### Scenario: Planning data is asked for

- **WHEN** a priority or an estimate is set for a debt item
- **THEN** it is set in the tracker and not written into the ledger, because the ledger owns
  the content and the tracker owns the planning

#### Scenario: An entry moves between blocks

- **WHEN** an entry is re-filed under a different block and its identifier changes
- **THEN** its tracker key travels with it unchanged, so the mirror still addresses the same item

### Requirement: The flow's own deferred work reaches the ledger

Archiving a change MUST carry into the tree every finding its review stage recorded as
non-blocking or accepted, and every unresolved debt line its apply ledger carries — as a new
entry, or as an additional anchor on an entry that already covers that action. A change MUST
NOT be archived leaving such an item recorded only where nothing reads it.

Debt in the change workflow itself is not product work and SHALL NOT be recorded in this
tree.

#### Scenario: A review finding is neither fixed nor dismissed

- **WHEN** archiving a change whose review record carries a non-blocking finding with its body
- **THEN** the tree carries an entry for it, or an existing entry gains an anchor for it

#### Scenario: The finding repeats work already tracked

- **WHEN** a recorded finding names the same action as an existing entry at a new code site
- **THEN** that entry gains an anchor, and no second entry is created

#### Scenario: The debt is in the workflow itself

- **WHEN** the deferred item is a defect in a flow command, schema or check script
- **THEN** it is recorded where flow debt is already tracked and not in this tree

### Requirement: Technical debt has one store

The repository SHALL NOT carry a second general-purpose store of open product debt beside
this tree. A page that explains a mechanism MAY describe a limitation in context, and the
ledger entry for that limitation MUST link to it rather than duplicate it.

#### Scenario: A descriptive page explains a limitation

- **WHEN** a memory page documents a mechanism and states a limitation of it
- **THEN** the prose stays on that page and the ledger entry links to it

#### Scenario: A new list of open items is proposed

- **WHEN** work would produce a fresh checklist of open product defects
- **THEN** those items become entries in this tree instead
