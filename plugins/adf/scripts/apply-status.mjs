#!/usr/bin/env node
// CLI over lib/apply-status.mjs: where a change's apply stands, read from the plan's Execution
// Graph, git, the tasks file, the execution ledger and the test record. Prints one JSON object
// on stdout; exit 1 on a refusal (no change, no plan, a missing or defective graph), exit 2 on a
// usage error.
//
//   apply-status.mjs --change <name> [--root <change worktree>] [--cap 3] [--report]
//
//   { ok, change, single, cap, groups: [{ n, letter, tasks, wave, dependsOn, state }],
//     merged, running, blocked, startable, waitingOnBlocked, ticked, remaining,
//     progress: { done, total }, testFirst, completedThisSession, openDebt: { count, ids },
//     lastHandoff, push, suite: { state, commit, reason? },
//     sweep: { ran, open: [{ id, introduced, existing, why }], cleared: [{ id, by }], missing?,
//              error? },
//     round: { round, base, checks, tasks, group, frozen } | null, complete, report? }
//
//   apply-status.mjs handoff --change <name> --next "<dispatch>" [--block <G> --reason "<why>"]
//                    [--root <change worktree>]
//       writes the `handoff` ledger record from the state: merged groups, remaining items and
//       every group still blocked, plus --block's group with its reason in `blockedReason`.
//       { ok, handoff, blocked }
//
// `testFirst` lists the plan tasks carrying both a RED and a GREEN step, as plan.mjs lint does.
// `sweep.open` lists the reuse sweep's findings still open (lib/loop.mjs sweepState): S<n> by
// first report, cleared by a DUP marker, by a `ruling --subject sweep --finding S<n> --as
// dismissed`, or by a later sweep's silence after the introduced file changed; `complete` stays
// false while one is open. `sweep.ran` is true once both passes of the first sweep (`sweep p1`,
// `sweep p2`) are accepted; `missing` names a pass not yet accepted, `error` two passes that ran
// on different HEADs. In an apply round (`plan.mjs reopen`) `round` names it, the sweep's
// findings are the round's, and the groups it froze count as merged.
//
// Group numbers are graph rows, the first row 1. `state` is merged, running, blocked or
// pending (done or pending for a single-group graph). `blocked` is read from the last
// `handoff` record's `blocked` field; `startable` are the groups to start now under the cap.
// `completedThisSession` lists the items whose tick commits came after the last apply session
// record. --report adds `report`, the apply command's closing block: Complete in full, or
// Paused with `<the issue>` and `<option>` left for the orchestrator to write.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyStatus, recordHandoff, renderReport } from './lib/apply-status.mjs'
import { changeDir } from './lib/changes.mjs'
import { isMain } from './lib/main.mjs'
import { parseTaskItems } from './lib/plan.mjs'
import { loadSchema } from './lib/schema.mjs'

export const USAGE =
  'usage: apply-status.mjs --change <name> [--root <change worktree>] [--cap <n>] [--report] | apply-status.mjs handoff --change <name> --next "<dispatch>" [--block <G> --reason "<why>"] [--root <dir>]'

export class UsageError extends Error {}

function parse(argv) {
  const values = { report: false }
  if (argv[0] === 'handoff') {
    values.handoff = true
    argv = argv.slice(1)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--report' && !values.handoff) {
      values.report = true
      continue
    }
    const valued = values.handoff ? ['--change', '--root', '--next', '--block', '--reason'] : ['--change', '--root', '--cap']
    if (!valued.includes(arg)) throw new UsageError(`unexpected argument "${arg}"`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return values
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { change, root = cwd, cap: capText, report, handoff, next, block, reason } = parse(argv)
  if (!change) throw new UsageError(USAGE)
  if (handoff) {
    if (!next) throw new UsageError('handoff needs --next')
    const tracks = loadSchema().apply?.tracks ?? 'tasks.md'
    return { ok: true, ...recordHandoff(root, change, { next, block, reason, tracks, env }) }
  }
  const cap = capText === undefined ? undefined : Number(capText)
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) throw new UsageError('--cap must be a positive integer')
  const schema = loadSchema()
  const tracks = schema.apply?.tracks ?? 'tasks.md'
  const status = applyStatus(root, change, { tracks, ...(cap ? { cap } : {}) })
  if (!report || !status.ok) return status
  let items = []
  try {
    items = parseTaskItems(readFileSync(join(changeDir(root, change), tracks), 'utf8'))
  } catch {
    // no tasks file: the report names the items by number
  }
  return { ...status, report: renderReport(status, { schemaName: schema.name, items }) }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
