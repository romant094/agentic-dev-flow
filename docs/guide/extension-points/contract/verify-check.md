<!-- sources:
- plugins/adf/contract/README.md
- plugins/adf/scripts/lib/verify.mjs
-->

# The verify hook

The Codex form of each command is in [the Codex page](../../getting-started/codex.md).

## What the point is

`verify-check` is a hook. It is a check of the project's own that [/adf:verify](../../cycle/verify.md) runs after the core's checks. The contract is in [the contract README](../../../../plugins/adf/contract/README.md#verify-check-hook-since-16).

The core sends the change name, the base, the verified commit and the paths that changed. Each provider returns a list of checks. A check has an `id`, a `title`, a `verdict`, a `summary` and a `text`. The verdict is `pass`, `warn`, `fail` or `not-run`.

## When it acts

It acts in the verify stage, after the core's own checks. Each returned check is a section of `verify.md`, with the id `ext:<plugin>:<id>`. You can rule on it like a core check.

A provider that refuses, is degraded or returns a malformed check gets a `not-run` section with the id `ext:<plugin>:verify-check`. The section says what happened.

## With no provider

Verify adds no section.

## Providers

| Plugin | Notes |
|---|---|
| [`adf-prisma`](../../plugins/adf-prisma.md) | Provides `verify-check`. It also provides `provision`. |
