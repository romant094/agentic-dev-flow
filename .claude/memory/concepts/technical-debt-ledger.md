# The Technical Debt Ledger

Where product technical debt lives, why it is shaped the way it is, and what the flow owes
it. The tree itself is at [`.claude/memory/tech-debt/`](../tech-debt/index.md); its root
index documents the entry format. This page records what no single file in that tree shows.

Introduced by `deferred-findings-ledger` (archived 2026-09-17) in the project this flow grew
in. The tree ships here as a scaffold — the format, not the entries.

## The loss this closed

`/opsx:review` classifies findings by severity: CRITICAL and HIGH start a fix round, MEDIUM
and LOW are "recorded and never block". What *recorded* meant was a row giving a severity, a
`file.ts:88`, and the word `recorded, non-blocking`. The record template stated the rule it
followed — "It records dispositions, not finding bodies" — with the rationale that a fixed
finding is in its commits and a dismissed one is marked in the code by a `// review-ignore:`
comment.

**That rationale is true of two classes and silently false of a third.** A non-blocking
finding is neither fixed nor dismissed, so no commit and no marker carries it, and its body
existed only in the reviewer's transcript, which is discarded. Across the origin project's
archive at the time of the change there were **61 such rows**.

Archive could not recover them either: its step 6 reads `review.md` for exactly two fields,
the verdict token and the reviewed SHA. A passing record's findings table is never read at
all. The one enforced carry-forward obligation in the flow —
[`apply-execution-ledger`](../../../docs/flow-specs/apply-execution-ledger/spec.md)'s
"Archiving resolves every remaining debt line" — was scoped to the apply ledger's `## Debt`
lines and did not reach review findings. The asymmetry was measurable: a duplicate the reuse
sweep dismissed got a debt line; a MEDIUM the reviewer found got nothing.

What kept debt visible until then was operator discipline — someone wrote it into a
hand-maintained known-issues page during the ingest. **No script, command, schema or spec
named that page.**

## The invariant no single file shows

**An entry's identity is its tracker key, not its `ID`.** The row identifier is a handle for
cross-reference and may change when an entry is re-filed between blocks; the key, once
written, must not. This matters because the key is the idempotency anchor for a mirror:
re-running a push reads the key and updates rather than duplicating. The column is carried
**empty from the first day** for that reason alone — adding it later would mean editing every
row, and no row can acquire an identity retroactively.

Two consequences, both established against real proposals to do otherwise:

- **One key per row.** Letting two rows share a key, so that debt delivered together points
  at one issue, was proposed and rejected: a shared key identifies nothing, and a sync pass
  cannot tell which row to reconcile against the issue. The case it was meant to serve is
  already covered — if two entries ship in one commit and review once, they *are* one entry
  with two anchor sets, and the fix is to merge the rows.
- **An empty cell means "not mirrored yet", and nothing else.** That is load-bearing rather
  than descriptive: it holds only while every open entry is mirrorable work. A marker for
  "deliberately never mirrored" was proposed and dropped on the better question — if nobody
  will ever act on it, why is it in a debt tree? An accepted decision belongs in `concepts/`,
  and an entry that is merely unscoped is still work, because a scoping task is a task and is
  estimable. Admit one unmirrorable entry and every later sync pass files duplicates.

**What makes ids safe to change is also what makes renumbering dangerous.** Dropping one
entry and renumbering a block's remaining ids down by one was done in the origin project
within an hour of the identity rule being written down, and it left five tracker issues whose
descriptions named the id their neighbour now carries, the last pointing at an id that no
longer existed. Nothing caught it: title, anchors and class all still matched, and the only
field that had moved was the back-pointer. That is worse than a dangling reference — a reader
who follows it lands on a real entry describing different work. **A renumbering pass owes the
mirrors a repoint in the same pass**, and a sync that compares only content fields will never
find the breakage.

The milder sibling: an issue that predates the ledger can carry more than a ledger row ever
held — acceptance criteria, a test stand — and regenerating its description from the row
destroys what the ledger never had. The tell is the missing back-pointer, and a sync must
leave those issues alone.

Most repositories adopting this flow have no artifact-to-issue mapping of any kind; the only
link between a repository object and a tracker issue is a branch name.

## The rules that decide what an entry is

Two rules on different axes, and conflating them is the most likely mistake:

- **Collapse** decides what is *one entry*: **one action, not one code site.** The same edit
  at twelve places is one entry with twelve anchors. Two different edits are two entries even
  in one file. The test is whether it can be delivered in one commit and reviewed once.
- **Group** decides *where an entry sits*: a sub-block gathers entries sharing a **mechanism**,
  as a heading inside the block's table. Never a file, never a row.

**The rule cuts both ways, and the introducing change's own history proves it.** One task
migrated 80 items into 67 entries and review required four more merges — too little
collapsing. Another folded a seven-item checklist into one entry and review required a split
— too much. The decisive evidence in the second case was a precedent inside the document being
deleted: an equivalent app-wide sweep had already run as a full OpenSpec change, not as one
unit of work.

## What the tree deliberately does not carry

**No status column, no assignee, no priority, no estimate, no counts anywhere.** An entry
exists while its debt is open and is deleted when it closes; git history and the tracker both
retain what was closed.

The reason is empirical rather than aesthetic. A sweep of the origin project's memory tree
found **every existing counter stale**: a TODO tracker's header claimed 74 open against 80
actual checkboxes, the memory index advertised "58 TODOs", an i18n checklist read "Open: TBD".
A field that can disagree with reality is a field this tree does not carry. Keeping a status
current would also require reading the tracker, which nothing here does.

Ownership splits accordingly: **the tree owns content, the tracker owns planning.** Priority
and estimate are set by a person in the tracker and are never written back.

## What belongs in the tree and what does not

**Flow debt is excluded by requirement.** Debt in the `/opsx:*` workflow itself — its
commands, its schema, its check scripts, the skills it dispatches — goes to
[ADF Deferred Findings](adf-deferred-findings.md). Three such entries reached the product tree
during the original migration and were removed in review; the exclusion is stated in
`schema.yaml`'s `archive` block so an archiving agent reading only that surface cannot get it
wrong.

**Pages that carry debt prose incidentally are left alone.** A "Known limitations" section
inside a page explains a mechanism where the mechanism is documented; cutting it out would
damage the page and leave the entry without its explanation. The ledger entry links to it
instead. In the origin project 66 such pages were left as they were — deferred work, not an
omission.

## What a future implementer would most plausibly get wrong

**Deleting an entry because it looks resolved.** The original migration dropped nine items as
stale or already fixed, and review — checking each against the code rather than against the
implementer's reasoning — **rejected two of them**. A tenth was dropped without ever being
declared, because the reconciliation ran against an estimate ("~45 items") rather than an
enumeration; the real count was 54. **Reconcile against an enumeration, and prove a drop with
a file and a line rather than an argument.**

The second trap is subtler: **an entry that names the wrong code is worse than no entry.** One
entry first attributed a validator defect to the wrong function — the behaviour was right, the
function was not, because the code path carried two independent implementations of the same
limitation. A reader chasing the named function would fail to reproduce the failure and
conclude the entry was stale.

## What the flow owes the tree

Three producers, all pre-existing and all previously leaking:

1. `/opsx:review` records the **body** of a finding that was neither fixed nor dismissed, in a
   `## Recorded findings` section, under the dispositions `recorded, non-blocking` and
   `accepted — <reason>`. This is the only moment the body exists.
2. `/opsx:archive` turns each into a tree entry, or an additional anchor on an entry that
   already covers that action.
3. The apply ledger's `## Debt` lines keep their obligation, with the tree named as the memory
   destination instead of any page.

The rule is stated in full only in `openspec/schemas/sdd-plus-superpowers/schema.yaml`; the
two command files and `.claude/CLAUDE.md` §2 carry pointers, and
`openspec/schemas/sdd-plus-superpowers/templates/review.md` carries an authoring instruction.
`.claude/skills/ai-code-review/SKILL.md` — the agent that actually writes the record — was
reconciled to match, and that reconciliation is the one edit without which the feature does
nothing. See [The Four Normative Surfaces](normative-surface-map.md).

## The path that ships unexercised

**The recorded-body half has never run on a real review finding**, and the change that
introduced it could not make it run. `.claude/skills/ai-code-review/SKILL.md` excludes `*.md`
from the diff the tuned review reads, because `infra/claude/review-prompt.md` instructs the
reviewer to skip markdown. That change was markdown: 40 of its 42 files were filtered out, the
two that survived were YAML carrying prose, and the review returned zero findings at every
severity.

The archive-side half *is* proven, on a real input — a genuine pre-existing defect found while
running the change and recorded nowhere before it.

This is [`opsx-workflow`](opsx-workflow.md)'s empty-input lesson arriving in a new form: not a
tool passing on empty input, but a mechanism that **cannot be given a non-empty input by the
kind of change that defines it.** The first change touching executable code is its first real
exercise. Stated in that change's `verify.md` and in its review record rather than left as an
absence, so a later reader can tell "zero findings" from "never ran".
