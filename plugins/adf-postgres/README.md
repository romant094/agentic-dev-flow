# ADF Postgres

This plugin provides the `provision` and `teardown` hooks of the ADF extension contract
(version 1.6) for PostgreSQL. A change or group worktree that needs a database gets its own,
named from its branch, and its copy of the env file points at it. Teardown drops it. The ADF
core calls the plugin; you do not run it by hand.

Install it in the host project, then add it to the registry with `/adf:add`:

```
/plugin install adf-postgres --marketplace romant094/agentic-dev-flow
```

## What it does

| Operation | Does |
|---|---|
| `provision` | For a `change` or `group` worktree whose `needs` names `database`: creates the database `<prefix>_<branch slug>_<hash>`, then rewrites `config.url.key` in the worktree's copy of `config.url.file` to point at it. A database that already exists is kept, and the env file is still rewritten. Every other kind, or no `database` in `needs`: done, nothing created, a note says why. |
| `teardown` | For a `change` or `group` worktree: `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)`, the name recomputed from `branch`. A `base-check` or `proof` worktree: done, nothing dropped. |

The name: the branch in lower case, every run of other characters as `_`, after
`config.prefix` and `_`; cut so that the whole name, with `_` and the first 8 hex digits of the
SHA-256 of the full branch name, stays within Postgres's 63-byte identifier limit. The hash
keeps two long branches with a common prefix apart, and teardown finds the same name again.
A `null` branch (a detached HEAD) is refused: it gives no name.

The server and the credentials are those of the main checkout: the value of `config.url.key` in
the main checkout's `config.url.file`, with the database `postgres`. Nothing new is configured.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `prefix` | yes | the first part of every database name: lower-case letters, digits and `_`, starting with a letter |
| `url.file` | yes | the env file, relative to the checkout root |
| `url.key` | yes | the variable in it that holds the connection string (`postgres://` or `postgresql://`) |
| `exec` | no | `{ "docker": "<container>" }` runs `psql` in that container; `"local"` (the default) runs the host's `psql` |

A missing or malformed field is refused, and the error names it. An example, for a project
whose Postgres runs in the Docker container `db` and whose `.env` holds `DATABASE_URL`:

```json
{ "prefix": "xnms", "url": { "file": ".env", "key": "DATABASE_URL" }, "exec": { "docker": "db" } }
```

## Order in the registry

The env file must be in the worktree before this plugin runs: the core copies the files the
guide's `## Worktree copies` names, and this plugin only rewrites the copy. A missing copy is
refused with `the core's ## Worktree copies must name <file>`.

Put this plugin after `adf-npm-workspaces` and before `adf-prisma`: the database must exist
before `adf-prisma` runs `migrate deploy` against the URL this plugin wrote.

## Safety

- The password never appears in an argument vector: it goes to `psql` through `PGPASSWORD`
  (`docker exec -e PGPASSWORD <container> psql ...`), and every error has it cut out.
- The env file is never written through a symbolic link: a link in the worktree is refused,
  not followed, so the main checkout's file is never changed. Every line but the rewritten
  assignment stays byte-identical; its `export `, quotes and comment are kept.
- A database made for a worktree is disposable: teardown drops it with the worktree. Keep no
  data in it that you need later.

## Results

| State | When |
|---|---|
| `done` | the operation happened, or there was nothing to do; `actions` (`create-database`, `write`, `drop-database`) and `notes` say which |
| `degraded` | provision cannot reach Docker, the container or `psql` (missing, stopped, refusing connections): nothing was created, the env file is unchanged, and `hint` says what to start |
| `refused` | a config or input problem, a missing or linked env file, or another `psql` error, with the tail of its output; exit 1 |

At teardown, an unreachable server is `done` with a note: teardown runs for every change, also
for one that never had a database, and a stopped server must not stop it.

## Calling convention

The core runs `node <plugin>/scripts/postgres.mjs provision|teardown` with the working
directory set to the host root and writes one JSON object to stdin:
`{ "root": "<host root>", "config": { ... }, "input": { ... } }`. The plugin prints one JSON
object with `state` set to `done`, `degraded` or `refused` (with `error`). The exit code is 0 for
`done` and `degraded`, 1 for `refused`.

| Operation | Input |
|---|---|
| `provision` | `{ worktree, main, kind, change, branch \| null, base: { ref, commit }, files, needs }` |
| `teardown` | `{ worktree, main, kind, change, branch }` |
