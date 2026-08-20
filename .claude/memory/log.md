# Log

> Rotated monthly. Entries older than the current month live in `.claude/memory/log-archive/YYYY-MM.md`. New entries prepend directly below this note.

## [2026-08-20 15:20] task | Flow specs moved to docs/flow-specs as historical documentation | Anton Romankov
- The nine capability specs moved from `openspec/specs/` to `docs/flow-specs/`, which now
  ships only a `.gitkeep`. Reason: a host project adopting this flow got nine foreign
  capabilities dropped into its own spec directory, where `/opsx:archive` would later merge
  its deltas alongside them.
- The move splits one path into two roles that were previously conflated: `openspec/specs/`
  is now purely the host project's live spec directory (archive-written, starts empty), and
  `docs/flow-specs/` is read-only documentation nothing resolves at runtime.
- Precedence inverted for the moved documents: while they were live specs, the spec won
  against the commands. As historical documents they can drift, so the commands now win.
  Recorded in `docs/flow-specs/README.md` and `.claude/CLAUDE.md` §3.
- Only references pointing at these nine documents were repointed (README.md,
  `.claude/CLAUDE.md`, `.gitlab-ci.flow.yml`, the two memory pages). Every mechanism
  reference — archive.md, sync.md, verify.md, `openspec-sync-specs`, the schema templates,
  `check-opsx-commands.mjs` — still says `openspec/specs/` and must, because it means the
  host's directory. Confusing the two is the failure mode to watch for here.
- 98/98 tests pass; `check-opsx-commands.mjs` and `check-english.mjs` both exit 0.
