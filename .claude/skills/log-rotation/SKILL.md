---
name: log-rotation
description: Rotate .claude/memory/log.md — move entries from months older than the current one into .claude/memory/log-archive/YYYY-MM.md, without duplicating or losing entries even when a prior rotation was left half-done. Self-triggering per CLAUDE.md §4 before any log.md prepend (ingest/query/lint/task workflows); also safe to invoke standalone to check or fix drift. Triggers on "rotate the log", "check log rotation", "fix log rotation", "почини ротацию log.md".
---

# Log Rotation

## Overview

`.claude/memory/log.md` is reverse-chronological and current-month-only by convention
(CLAUDE.md §4). This skill is the one place that convention is enforced: it moves every
entry older than the current month into `.claude/memory/log-archive/YYYY-MM.md`, and it
is idempotent — running it when nothing needs rotating is a no-op, and running it after a
prior rotation left entries duplicated or half-moved repairs that state rather than
compounding it.

Only entries matching the header format `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>`
participate. Any other content in `log.md` (a differently-formatted legacy block, stray
prose) is out of scope — never move, edit, or delete it.

## When this runs

- **Self-triggering**, per CLAUDE.md §4's Ingest/Task Completion/Lint workflows: invoked
  as "Log Rotation Check" immediately before any new entry is prepended to `log.md`.
- **On request**, standalone, to audit or repair `log.md`'s state without prepending
  anything new.

## Steps

**1. Determine the current month and scan `log.md`**

```bash
date '+%Y-%m'
grep -n '^## \[' .claude/memory/log.md
```

Extract the `YYYY-MM` from each matched header. If every header's month equals the
current month (or there are no headers at all), there is nothing to rotate — report that
and stop.

**2. For each month older than the current one present in `log.md`**

Process months oldest-to-newest or newest-to-oldest — order between months does not
matter, since each month's entries move as a self-contained block.

For month `YYYY-MM`:

a. Ensure the archive file exists:
   ```bash
   ls .claude/memory/log-archive/YYYY-MM.md 2>&1
   ```
   If missing, it will be created in step (c) with a `# Log Archive — YYYY-MM` header.

b. **Check for entries already archived** (the exact drift this skill exists to repair —
   a prior rotation that copied without deleting, or deleted without copying). For every
   `## [YYYY-MM-...] ...` header line in `log.md` for this month, grep for the identical
   header line in the archive file:
   ```bash
   grep -n '^## \[' .claude/memory/log-archive/YYYY-MM.md
   ```
   Diff the two header lists (log.md's month-`YYYY-MM` headers vs. the archive's headers).
   Three outcomes per entry:
   - **In log.md only** → needs copying to the archive (c), then removing from `log.md` (d).
   - **In both** → already archived correctly; only needs removing from `log.md` (d), not
     re-copied (re-copying would create a duplicate header in the archive).
   - **In the archive only** → already fully rotated for this entry; nothing to do.

c. **Copy entries found "in log.md only"** into the archive file, full text (header
   through the line before the next `## [` header or end of that entry), preserving
   reverse-chronological order. Read each entry's full body from `log.md` with the Read
   tool (do not paraphrase or summarize it), then find its correct insertion point in the
   archive by comparing its timestamp against the archive's existing headers — insert
   immediately before the first existing archive entry whose timestamp is older, or at
   the end of the month's block if it is the oldest. If the archive file does not exist
   yet, create it with a `# Log Archive — YYYY-MM` header followed by all of this month's
   entries in their `log.md` order (which is already reverse-chronological).

d. **Remove every entry for this month from `log.md`** — both the ones just copied and
   the ones already archived. `log.md` keeps only the heading, the rotation note, and
   entries whose month equals the current month.

**3. Verify no entry was lost or duplicated**

For each month rotated, re-run the header grep against the archive file and confirm:
- every header that was in `log.md` for that month now appears in the archive exactly
  once (not zero, not two-or-more times).
- `log.md` no longer contains any header for that month.

```bash
grep -c '^## \[' .claude/memory/log-archive/YYYY-MM.md
grep '^## \[' .claude/memory/log-archive/YYYY-MM.md | sort | uniq -d   # expect no output
grep -c '^## \[YYYY-MM' .claude/memory/log.md                          # expect 0
```

If a duplicate or a loss is found, stop and report it rather than guessing at a fix —
this is exactly the state a half-done rotation left before, and the fix needs the same
careful entry-by-entry comparison as step 2b, not a blind re-run.

**4. Report**

State which months were rotated, how many entries were newly copied vs. already
archived (and thus only removed), and confirm the verification in step 3 passed. If
nothing needed rotating, say so plainly.

## Rules

- Never touch content in `log.md` that does not match the `## [YYYY-MM-DD HH:MM] <type> |
  <title> | <author>` header format — it is out of this skill's scope, not a rotation bug.
- Never re-copy an entry whose header already exists in the target archive file — check
  first (step 2b). A blind append is exactly how the archive/log.md drift this skill fixes
  was created in the first place.
- Preserve each entry's exact text — this is a move, not a rewrite. Do not summarize,
  merge, or reformat entries while relocating them.
- `log-archive/*.md` files are otherwise read-only per CLAUDE.md §4 ("grep it, don't Read
  it whole") — this skill is the one sanctioned writer.
