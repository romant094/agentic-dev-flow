# sdd-plus-superpowers Schema

An OpenSpec project schema that integrates OpenSpec's artifact governance with
Superpowers' execution skills into a single workflow.

## Artifacts

Eight artifacts, produced in order:

1. **brainstorm** — produced by `superpowers:brainstorming`
2. **proposal** — plain OpenSpec, no skill
3. **design** (optional) — plain OpenSpec, no skill
4. **specs** — plain OpenSpec, no skill
5. **tasks** — plain OpenSpec, no skill
6. **plan** — produced by `superpowers:writing-plans`
7. **verify** — produced by the `/opsx:verify` command
8. **review** — produced by the `/opsx:review` command

Apply is blocked until `plan` exists: `tasks.md` tracks coarse-grained
progress, but the apply phase's executor needs `plan.md`'s micro-steps to
work from.

## Adaptations made to the upstream copy

This schema was copied from `JiangWay/OpenSpec` at commit `f053e3fe` and
adapted for this project:

1. **English-only** — all templates and instructions were rewritten in
   English; the upstream copy was written in Chinese.
2. **No silent fallback** — the two upstream "fall back to manual
   implementation" instructions were replaced with a hard stop: if a required
   Superpowers skill cannot be invoked, the workflow stops and prints
   `claude plugin install superpowers@claude-plugins-official` instead of
   improvising the skill's work by hand.
3. **`develop` branch model** — the upstream `main`/`master` apply pre-flight
   check was removed, because this project branches from `develop`, not
   `main`.
4. **No unavailable skills** — references to `openspec-continue-change` and
   `workflow-retrospective` were removed; this project does not have those
   skills. The retrospective step is replaced by an ingest into
   `.claude/memory/`, per this project's Wiki Memory workflow.

## Rationale

See `openspec/changes/integrate-superpowers-workflow/design.md` for why this
schema exists and the alternatives considered.
