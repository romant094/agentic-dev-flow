# Planning Guide

<!--
How this project gathers information for a change's plan. /adf:init created this file; the
team owns it.
-->

## Where to look

1. `.claude/memory/` first: the system page, then the concept pages the change touches.
2. The code under `apps/server/src/` and `apps/client/src/`.
3. A running bench at `http://bench.local:8080` for the SNMP agent.

## Packages

<!-- The project's packages. -->

- `packages/shared` first: both apps import it
- `apps/server`
- `apps/client/`

## How to run the checks

<!-- The commands. -->

- Install: `npm ci`
- Build: `npm run build`
- Test one file: `npx vitest run <file>`

```sh
npm run lint
```

## Whole-suite command

```sh
npm test -- --force
```

## Affected tests command

`npx vitest related --run --passWithNoTests {files}`

## Failed-tests command

`npx vitest run {tests}`

## Fresh-run proof

`Cached:    0 cached`

## Test-first shares

<!-- untracked paths -->
- `.env`
- `node_modules`

## Worktree copies

- `.env`
- `apps/server/.env.local`

## Worktree preparation

<!-- - `node never.mjs` from `nowhere` -->
- `npm run build --workspace @x/shared` from `packages/shared/src`, `packages/shared/tsconfig.json`

## Format command

`npx biome format --write {files}`

## Checks that need the developer

A hardware pass against the bench switch, in the group that lands a device write path. The
developer confirms the switch is free first.

## Release notes

The team's own section: kept as it is.
