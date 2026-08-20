# log-rotation

Rotates `.claude/memory/log.md` — moves entries from months older than the current one
into `.claude/memory/log-archive/YYYY-MM.md`, without duplicating or losing entries even
when a prior rotation was left half-done.

## Usage

Runs automatically, self-triggered by CLAUDE.md §4's Ingest/Task Completion/Lint
workflows before any new `log.md` entry is prepended. Can also be invoked directly:

> Rotate the log
> Check log rotation
> Fix log rotation

## Output

No report file — this skill edits `.claude/memory/log.md` and
`.claude/memory/log-archive/YYYY-MM.md` directly and reports a short summary in-chat
(months rotated, entries moved vs. already archived, verification result).

## Design

Idempotent by construction: before copying an entry into an archive file, it checks
whether that entry's header already exists there. This specifically repairs the failure
mode found and fixed by hand while archiving `flow-shift-left-and-retro` (2026-08-07) —
several past rotations had copied entries into `log-archive/*.md` without removing them
from `log.md`, so months of entries (May through July 2026) sat duplicated in both
places, and this skill exists so the same repair does not need doing by hand again.
