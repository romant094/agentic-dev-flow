<!-- sources:
- plugins/adf-prisma/scripts/*.mjs
- plugins/adf-prisma/scripts/lib/*.mjs
- plugins/adf-prisma/adf-extension.json
-->

# `adf-prisma`

`adf-prisma` provides two hooks for a project that uses [Prisma](https://www.prisma.io). The hook `provision` prepares the Prisma part of every worktree that the core makes. The hook `verify-check` adds the `migration-order` check to verify. The core calls the plugin. You do not run it by hand.

## Install and enable

```
claude plugin install adf-prisma@agentic-dev-flow --scope project
/adf:add adf-prisma@agentic-dev-flow
```

The Codex form is on [the Codex page](../getting-started/codex.md).

## Registry order

Put `adf-prisma` after the dependency provider and the database provider:

```json
"extensions": [
  { "plugin": "adf-npm-workspaces@agentic-dev-flow", "points": ["provision"] },
  { "plugin": "adf-postgres@agentic-dev-flow", "points": ["provision", "teardown"] },
  { "plugin": "adf-prisma@agentic-dev-flow", "points": ["provision", "verify-check"] }
]
```

The client must exist before `prisma generate`. The database must exist before `prisma migrate deploy`. The plugin refuses a worktree whose `node_modules` is one link into another checkout. Run the dependency provider first.

## What `provision` does

1. No schema, nothing to do. When the worktree has no schema directory (`config.schema`, default `prisma`), the hook is `done` with a note and runs nothing.
2. The generated client. See below.
3. The database. The hook migrates only the own database of a worktree (see "The database rule"). It runs `prisma migrate deploy`, then `prisma db seed`.

### The generated client

When a path in the `files` of the input matches `config.ownClientWhen`, the hook does these things:

- It replaces the links `node_modules/.prisma` and `node_modules/@prisma/client` in the worktree with real copies of what they point to.
- It runs `prisma generate` in the worktree.
- When `node_modules/@prisma` is itself one link, it becomes a real directory whose other entries link to the same targets.

Otherwise the links stay. The worktree shares the client with the main checkout, and nothing is generated. A generate through a link would rewrite the client of the main checkout. The hook always removes a link before it makes its copy. It never writes through a link.

A rerun is safe. A worktree that already owns its client, a real copy from an earlier run, gets no new copy. The hook generates its client again, whatever `files` holds, so the client follows the schema of the worktree.

A command that fails refuses the step with exit 1 and the last lines of its output. The hook replaces the database URL, its password and any other credential in a URL with `<redacted>`.

## The CLI version

Every command runs as `npx --yes prisma@<version> ...` in the worktree. The hook never runs a bare `npx prisma`, because it resolves the newest major version, not the one that the project uses.

The version is `config.cli` when set. Otherwise it is the `@prisma/client` version in the root `package.json` of the worktree: `dependencies` first, then `devDependencies`. The hook removes a leading `^` or `~`. It refuses any other range (`>=6`, `6.x`, `latest`), and it refuses a project with no `@prisma/client`. The refusal hints to set `config.cli`. The CLI and the client must have one version.

## The database rule

The hook reads the database URL from `config.env.file` (default `.env`) at `config.env.key` (default `DATABASE_URL`). It reads it in the worktree and in the main checkout. It migrates only when the two URLs name different databases. Then the database provider, `adf-postgres`, gave the worktree its own.

| Worktree URL | Main checkout URL | Result |
|---|---|---|
| another database | present | `migrate deploy`, then `db seed` |
| the same database (scheme, host, port, name and `schema`; the password does not count) | present | no migration: it is the developer's database |
| absent or not a URL | any | no migration |
| present | absent | no migration: nothing proves the database is the worktree's own |

The seed runs only when `config.seed` is not `false` and `package.json` of the project has `prisma.seed`. Every command gets the URL of the worktree in its environment, under `config.env.key`. So a value already in the environment of the caller never points it at another database. The hook never prints the URL.

## What `verify-check` does

It returns one check, `migration-order`. Prisma applies migrations in the order of their directory names, which are timestamps. Suppose a branch migration sorts before the newest migration that the base gained. It would apply first on a fresh database. It would apply last on the developer's database.

| Case | Verdict |
|---|---|
| the base ref (`input.base.ref`) does not exist | `fail`: there is nothing to compare against |
| no migration at the head or at the base | `pass`, "no Prisma migrations" |
| the branch adds no migration, or every one sorts after all the base gained | `pass` |
| the oldest branch migration sorts before the newest one the base gained | `fail`; the text says to recreate the migration so that its timestamp is last |

The migrations are the directories under `<schema>/migrations`, without `migration_lock.toml`. The check reads them with `git ls-tree` at `input.head` (default `HEAD`) and at the base ref. The check never fetches and never rewrites anything.

## Configure

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `schema` | `prisma` | the schema directory; when set, it is also passed to `generate` and `migrate deploy` as `--schema` |
| `ownClientWhen` | `["<schema>/", "package.json", "package-lock.json"]` | paths and globs; a matching changed path gives the worktree its own client; a path that ends in `/` is a prefix; `*` matches within a segment, `**` across segments |
| `cli` | derived | the exact Prisma CLI version |
| `seed` | `true` | `false` skips `db seed` |
| `env` | `{ "file": ".env", "key": "DATABASE_URL" }` | where the database URL is |

## Calling convention

The core runs `node <plugin>/scripts/prisma.mjs <hook>` in the host root. It writes one JSON object to stdin: `{ "root": "<host root>", "config": { }, "input": { } }`.

The plugin prints one JSON object. Its `state` is `done` or `refused`. A refusal carries `error`. The exit code is 0 for `done` and 1 for `refused`. The plugin ignores the fields of the input that it does not use.

| Hook | Input | Result when `done` |
|---|---|---|
| `provision` | `{ worktree, main, kind, change, branch, base: { ref, commit }, files, needs }` | `actions`: `{ op, path }`, with `op` one of `unlink-scope`, `copy`, `generate`, `migrate-deploy`, `seed`; `notes` |
| `verify-check` | `{ change, base: { ref, commit }, head, files }` | `checks`: `[{ id: "migration-order", title, verdict, summary, text }]` |

## Points it provides

- [`provision`](../extension-points/contract/provision-teardown.md): the hook `provision`.
- [`verify-check`](../extension-points/contract/verify-check.md): the hook `verify-check`, with the check `migration-order`.
