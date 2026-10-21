# ADF Prisma

This plugin provides two hooks of the ADF extension contract (version 1.6) for a project that
uses [Prisma](https://www.prisma.io): `provision`, which prepares the Prisma part of every
worktree the core makes, and `verify-check`, which adds the `migration-order` check to verify.
The ADF core calls it; you do not run it by hand.

Install it in the host project, then add it to the registry with `/adf:add`:

```
/plugin install adf-prisma --marketplace romant094/agentic-dev-flow
```

## Registry order

Put `adf-prisma` after the dependency provider and the database provider:

```json
"extensions": [
  { "plugin": "adf-npm-workspaces@agentic-dev-flow", "points": ["provision"] },
  { "plugin": "adf-postgres@agentic-dev-flow", "points": ["provision", "teardown"] },
  { "plugin": "adf-prisma@agentic-dev-flow", "points": ["provision", "verify-check"] }
]
```

The client must exist before `prisma generate`, and the database before `prisma migrate deploy`.
A worktree whose `node_modules` is one link into another checkout is refused: run the
dependency provider first.

## What `provision` does

1. **No schema, nothing to do.** When the worktree has no schema directory (`config.schema`,
   default `prisma`), the hook is `done` with a note and runs nothing.
2. **The generated client.** When a path in the input's `files` matches `config.ownClientWhen`,
   the worktree's links `node_modules/.prisma` and `node_modules/@prisma/client` are replaced
   by real copies of what they point to, and `prisma generate` runs in the worktree. When
   `node_modules/@prisma` is itself one link, it becomes a real directory whose other entries
   link to the same targets. Otherwise the links stay, the client is shared with the main
   checkout, and nothing is generated: a generate through a link would rewrite the main
   checkout's client. A link is always removed before its copy is made; nothing is ever written
   through one.
3. **The database.** Only a worktree's own database is migrated (see below): `prisma migrate
   deploy`, then `prisma db seed`.

A rerun is safe. A worktree that already owns its client (a real copy from an earlier run) is
not copied again; its client is generated again, whatever `files` holds, so it follows the
worktree's schema.

A command that fails refuses the step (exit 1) with the last lines of its output; the database
URL, its password and any other credential in a URL are replaced by `<redacted>`.

## The CLI version

Every command runs as `npx --yes prisma@<version> ...` in the worktree. A bare `npx prisma` is
never run: it resolves the newest major, not the one the project uses.

The version is `config.cli` when set. Otherwise it is the `@prisma/client` version in the
worktree's root `package.json` (`dependencies`, then `devDependencies`), with a leading `^` or
`~` removed. Any other range (`>=6`, `6.x`, `latest`), or no `@prisma/client` at all, is
refused with a hint to set `config.cli`: the CLI and the client must be one version.

## The database rule

The hook reads the database URL from `config.env.file` (default `.env`) at `config.env.key`
(default `DATABASE_URL`), in the worktree and in the main checkout. It migrates only when the
two name different databases: the database provider (`adf-postgres`) gave the worktree its own.

| Worktree URL | Main checkout URL | Result |
|---|---|---|
| another database | present | `migrate deploy`, then `db seed` |
| the same database (scheme, host, port, name and `schema`; the password does not count) | present | no migration: it is the developer's database |
| absent or not a URL | any | no migration |
| present | absent | no migration: nothing proves the database is the worktree's own |

The seed runs only when `config.seed` is not `false` and the host's `package.json` has
`prisma.seed`. Every command gets the worktree's URL in its environment under `config.env.key`,
so a value already in the caller's environment never points it at another database. The URL is
never printed.

## What `verify-check` does

It returns one check, `migration-order`. Prisma applies migrations in the order of their
directory names, which are timestamps. A branch migration that sorts before the newest one the
base gained would apply first on a fresh database and last on the developer's.

| Case | Verdict |
|---|---|
| the base ref (`input.base.ref`) does not exist | `fail`: there is nothing to compare against |
| no migration at the head or at the base | `pass`, "no Prisma migrations" |
| the branch adds no migration, or every one sorts after all the base gained | `pass` |
| the oldest branch migration sorts before the newest one the base gained | `fail`; the text says to recreate the migration so that its timestamp is last |

The migrations are the directories under `<schema>/migrations`, `migration_lock.toml` left out,
read with `git ls-tree` at `input.head` (default `HEAD`) and at the base ref. The check never
fetches and never rewrites anything.

## Configuration

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `schema` | `prisma` | the schema directory; when set, it is also passed to `generate` and `migrate deploy` as `--schema` |
| `ownClientWhen` | `["<schema>/", "package.json", "package-lock.json"]` | paths and globs; a matching changed path gives the worktree its own client. A path ending in `/` is a prefix; `*` matches within a segment, `**` across segments |
| `cli` | derived | the exact Prisma CLI version |
| `seed` | `true` | `false` skips `db seed` |
| `env` | `{ "file": ".env", "key": "DATABASE_URL" }` | where the database URL is |

## Calling convention

The core runs `node <plugin>/scripts/prisma.mjs <hook>` in the host root and writes one JSON
object to stdin: `{ "root": "<host root>", "config": { }, "input": { } }`. The plugin prints one
JSON object with `state` `done` or `refused` (with `error`). The exit code is 0 for `done` and 1
for `refused`.

| Hook | Input | Result when `done` |
|---|---|---|
| `provision` | `{ worktree, main, kind, change, branch, base: { ref, commit }, files, needs }` | `actions`: `{ op, path }` with `op` one of `unlink-scope`, `copy`, `generate`, `migrate-deploy`, `seed`; `notes` |
| `verify-check` | `{ change, base: { ref, commit }, head, files }` | `checks`: `[{ id: "migration-order", title, verdict, summary, text }]` |

Fields the plugin does not use are ignored.
