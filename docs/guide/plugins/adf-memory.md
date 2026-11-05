<!-- sources:
- plugins/adf-memory/scripts/*.mjs
- plugins/adf-memory/scripts/lib/*.mjs
- plugins/adf-memory/adf-extension.json
- plugins/adf-memory/instructions/**
- plugins/adf-memory/host/**
-->

# `adf-memory`

`adf-memory` is the wiki memory of the flow. It provides the `knowledge` role. The role has three parts: an indexed knowledge base in the project at `.claude/memory/`, a monthly rotating log of what each session learned, and the instructions of the ingest, query and lint workflows.

## What it does

`/adf:add adf-memory@agentic-dev-flow` copies a skeleton into the project when a file is missing. A project that edited its copy keeps it.

| File | Holds |
|---|---|
| `.claude/memory/index.md` | one line for each page, grouped by subject |
| `.claude/memory/system.md` | the overview of the system |
| `.claude/memory/log.md` | the entries of the current month, newest first |

Pages go under `.claude/memory/entities/` (modules, components, services) and `.claude/memory/concepts/` (patterns, protocols, workflows, decisions). The rotation makes `log-archive/`. It is read-only: search it with grep and never read it whole.

## Install and enable

```
claude plugin install adf-memory@agentic-dev-flow --scope project
/adf:add adf-memory@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md).

## Configure

| Key | Meaning |
|---|---|
| `exclude` | a list of globs, relative to `.claude/memory/`; `check` leaves out every page that a glob matches |

Example: `{ "exclude": ["reports/**"] }`. In a glob, `**` matches at any depth, and `*` and `?` stay inside one path segment. By default `check` excludes only `log.md` and `log-archive/`, which are never pages. An excluded page is not checked for broken links or for its index line.

The core passes the config on every call. When you run the script by hand, use `--exclude <glob>`, once for each glob.

## The role operations

`scripts/memory.mjs <operation>` reads `{ root, config, input }` on stdin when the core calls it. By hand, it reads flags. It prints one JSON object. The exit code is 0 for `done`, 1 for `refused` and 2 for a usage error.

| Operation | Input | Result when `done` |
|---|---|---|
| `context` | `{}` | `base`, `index`, `exists`, `instructions`, `paths`, `log` |
| `log` | `type`, `title`, and `bullets`, or `commit` and `reason`; `amend` | `entry`, `rotated`, `amended`, `path` |
| `check` | `{}` | `findings`, `pages`, `excluded` |

The fields of `context`:

- `index` is the path of the index, relative to the project.
- `instructions` holds the absolute paths of `ingest`, `query`, `lint` and `fix`.
- `paths` is `[".claude/memory/**"]`, the globs that an ingest may edit. Archive applies the edits that the ingest reply carries.
- `log` is `[".claude/memory/log.md", ".claude/memory/log-archive/**"]`, the files that only `log` writes. The ingest check of archive refuses an agent that edited them.

The fields of `log`:

- `type` is `ingest`, `query`, `lint` or `task`.
- `entry` is the text written.
- `rotated` lists the months moved to `log-archive/`.

The `findings` of `check` are `unindexed`, `broken-link`, `malformed-header`, `out-of-order` and `missing`. `pages` is the number of pages checked. `excluded` is the number of pages left out.

### Sort the log

`memory.mjs sort [--root <dir>]` is not a role operation. It puts the entries of `log.md` back in timestamp order, newest first. Use it after a merge of branches that each added entries broke the order. Run it when `check` reports `out-of-order`.

- Entries with the same time keep their order.
- No entry's text changes.
- A log already in order is not written.
- It prints `moved`, the entries whose place changed, and `entries`.
- With no `log.md`, it is refused.

## The log

- The header is `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>`. The time is UTC. The script reads it from the clock; you never type it. The author is `git config user.name`. With none set, `log` is refused.
- Every `log` call rotates first. Entries from a month before the current UTC month move to `log-archive/YYYY-MM.md`, newest first, each copied once. The script creates the directory when it is missing. A legacy header with a zone suffix, such as `[2026-07-13 15:40 +03]`, starts an entry too.
- The entry goes below the heading and its rotation note, at the place of its timestamp: above the first entry that is not newer. `check` reports a log whose order a merge broke.
- An entry has no blank line inside it. `log` refuses a bullet that holds one.
- `--commit <sha>[,<sha>] --reason <text>` writes the one-line form `- see commit <sha> — <reason>`. Use it for a mechanical task that a commit already explains.
- `--amend` replaces the entry with the same title that is not committed at `HEAD` yet, at the new time. With no such entry, it is refused and nothing is written.

## The instructions

The plugin ships `instructions/ingest.md`, `query.md`, `lint.md` and `fix.md`. The file `fix.md` covers a direct fix without the change cycle. In them, `<plugin>` is the directory of this plugin: the parent of the `instructions/` path that `context` returns.

## Points it provides

- [`knowledge`](../extension-points/contract/knowledge.md): the operations `context`, `log` and `check`.
