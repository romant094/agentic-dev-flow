<!-- sources:
- plugins/adf-postgres/scripts/*.mjs
- plugins/adf-postgres/scripts/lib/*.mjs
- plugins/adf-postgres/adf-extension.json
-->

# `adf-postgres`

`adf-postgres` provides the `provision` and `teardown` hooks for PostgreSQL. A change or group worktree that needs a database gets its own, named from its branch. Its copy of the env file points at it. Teardown drops it. The core calls the plugin. You do not run it by hand.

## What it does

| Operation | Does |
|---|---|
| `provision` | For a `change` or `group` worktree whose `needs` names `database`: creates the database `<prefix>_<branch slug>_<hash>`. Then rewrites `config.url.key` in the worktree's copy of `config.url.file` to point at it. It keeps a database that already exists and still rewrites the env file. For every other kind, or with no `database` in `needs`, it is done, creates nothing, and a note says why. |
| `teardown` | For a `change` or `group` worktree: runs `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)`, with the name recomputed from `branch`. For a `base-check` or `proof` worktree, or with no config, it is done and drops nothing. |

### The database name

1. Take the branch in lower case.
2. Replace every run of other characters with `_`.
3. Put `config.prefix` and `_` before it.
4. Cut it so that the whole name stays within the 63-byte identifier limit of Postgres. The whole name includes `_` and the first 8 hex digits of the SHA-256 of the full branch name.

The hash keeps two long branches with a common prefix apart. Teardown finds the same name again. A `null` branch, which is a detached HEAD, is refused: it gives no name.

The server and the credentials are those of the main checkout. The plugin takes the value of `config.url.key` in `config.url.file` of the main checkout, with the database `postgres`. You configure nothing new.

## Install and enable

```
claude plugin install adf-postgres@agentic-dev-flow --scope project
/adf:add adf-postgres@agentic-dev-flow '{"prefix":"myapp","url":{"file":".env","key":"DATABASE_URL"}}'
```

The Codex form is on [the Codex page](../getting-started/codex.md).

To set or change the config of the enabled plugin and keep its place in the registry, run `/adf:add` again with a config. The script form is `extensions.mjs config adf-postgres --config '<json>'`.

## Configure

| Field | Required | Meaning |
|---|---|---|
| `prefix` | yes | the first part of every database name: lower-case letters, digits and `_`, starting with a letter |
| `url.file` | yes | the env file, relative to the checkout root |
| `url.key` | yes | the variable in it that holds the connection string, `postgres://` or `postgresql://` |
| `exec` | no | `{ "docker": "<container>" }` runs `psql` in that container; `"local"`, the default, runs `psql` of the host |

The plugin checks the config only when a database is needed.

- A provision whose `kind` or `needs` asks for no database is done, whatever the config holds.
- A teardown with no config (`{}`) is done and drops nothing, because provision made no database.
- When a database is needed, a missing or malformed field is refused, and the error names it.

The declaration lists `prefix` and `url` as `requiredConfig`. So `/adf:add` warns when the config lacks them.

An example, for a project whose Postgres runs in the Docker container `db` and whose `.env` holds `DATABASE_URL`:

```json
{ "prefix": "myapp", "url": { "file": ".env", "key": "DATABASE_URL" }, "exec": { "docker": "db" } }
```

## Order in the registry

The env file must be in the worktree before this plugin runs. The core copies the files that `## Worktree copies` of the planning guide names. This plugin only rewrites the copy. It refuses a missing copy with `the core's ## Worktree copies must name <file>`.

Put this plugin after `adf-npm-workspaces` and before `adf-prisma`. The database must exist before `adf-prisma` runs `migrate deploy` against the URL that this plugin wrote.

## Safety

- The password never appears in an argument vector. It goes to `psql` through `PGPASSWORD`, as in `docker exec -e PGPASSWORD <container> psql ...`. Every error has it cut out.
- The plugin never writes the env file through a symbolic link. It refuses a link in the worktree and does not follow it, so the file of the main checkout never changes. Every line but the rewritten assignment stays byte-identical. Its `export `, quotes and comment stay.
- A database made for a worktree is disposable. Teardown drops it with the worktree. Keep no data in it that you need later.

## Results

| State | When |
|---|---|
| `done` | The operation happened, or there was nothing to do. `actions` (`create-database`, `write`, `drop-database`) and `notes` say which. |
| `degraded` | Provision cannot reach Docker, the container or `psql`: missing, stopped, or refusing connections. Nothing was created, the env file is unchanged, and `hint` says what to start. |
| `refused` | A config or input problem, a missing or linked env file, or another `psql` error, with the tail of its output. The exit code is 1. |

At teardown, an unreachable server is `done` with a note. Teardown runs for every change, also for one that never had a database. A stopped server must not stop it.

## Calling convention

The core runs `node <plugin>/scripts/postgres.mjs provision|teardown` with the working directory set to the host root. It writes one JSON object to stdin: `{ "root": "<host root>", "config": { ... }, "input": { ... } }`.

The plugin prints one JSON object. Its `state` is `done`, `degraded` or `refused`. A refusal carries `error`. The exit code is 0 for `done` and `degraded`, and 1 for `refused`.

| Operation | Input |
|---|---|
| `provision` | `{ worktree, main, kind, change, branch \| null, base: { ref, commit }, files, needs }` |
| `teardown` | `{ worktree, main, kind, change, branch }` |

## Points it provides

- [`provision`](../extension-points/contract/provision-teardown.md): the operation `provision`.
- [`teardown`](../extension-points/contract/provision-teardown.md): the operation `teardown`.
