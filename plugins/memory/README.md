# memory

The wiki memory of the Agentic Dev Flow. It provides the `knowledge` role (contract 1.3): an
indexed knowledge base in the host at `.claude/memory/`, a log of what each session learned,
rotated monthly, and the instructions of the ingest, query and lint workflows.

## What it adds to the host

`/adf:add memory@agentic-dev-flow` copies the skeleton when a file is missing; a host that
edited its copy keeps it.

| File | Holds |
|---|---|
| `.claude/memory/index.md` | one line per page, grouped by subject |
| `.claude/memory/system.md` | the overview of the system |
| `.claude/memory/log.md` | the current month's entries, newest first |

Pages go under `.claude/memory/entities/` (modules, components, services) and
`.claude/memory/concepts/` (patterns, protocols, workflows, decisions). `log-archive/` is made
by the rotation; it is read-only: grep it, never read it whole.

## The role

`scripts/memory.mjs <operation>` reads `{ root, config, input }` on stdin, as the core calls
it, or flags when run by hand. It prints one JSON object; exit 0 `done`, 1 `refused`, 2 a usage
error.

| Operation | Input | Result when `done` |
|---|---|---|
| `context` | `{}` | `base`, `index` (host-relative path of the index), `exists`, `instructions` (absolute paths of `ingest`, `query`, `lint`, `fix`), `paths` (`[".claude/memory/**"]`, the globs an ingest may write) |
| `log` | `type` (`ingest`, `query`, `lint`, `task`), `title`, and `bullets` or `commit` + `reason`; `amend` | `entry` (the text written), `rotated` (the months moved to `log-archive/`), `amended`, `path` |
| `check` | `{}` | `findings` (`unindexed`, `broken-link`, `malformed-header`, `out-of-order`, `missing`), `pages` |

## The log

- The header is `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>`. **The time is UTC**, read
  from the clock, never typed. The author is `git config user.name`; with none set, `log` is
  refused.
- Every `log` call rotates first: entries from a month before the current (UTC) one move to
  `log-archive/YYYY-MM.md`, newest first, each copied once. The directory is created when
  missing. A legacy header with a zone suffix (`[2026-07-13 15:40 +03]`) starts an entry too.
- The entry goes below the heading and its rotation note, at its timestamp's place: above the
  first entry that is not newer. A log whose order a merge broke is reported by `check`.
- No blank line inside an entry: a bullet holding one is refused.
- `--commit <sha>[,<sha>] --reason <text>` writes the one-line form
  `- see commit <sha> — <reason>`, for a mechanical task a commit already explains.
- `--amend` replaces the entry with the same title that is not committed at `HEAD` yet, at
  the new time; with no such entry it is refused and nothing is written.

## Instructions

`instructions/ingest.md`, `query.md`, `lint.md` and `fix.md` (a direct fix without the change
cycle). `<plugin>` in them is this plugin's directory: the parent of the `instructions/` path
`context` returns.
