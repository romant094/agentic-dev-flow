#!/usr/bin/env node
// CLI over lib/sweep.mjs: the inputs of apply's code reuse sweep, and the filter over its reply.
// Prints one JSON object on stdout; exit 1 on a refusal, exit 2 on a usage error.
//
//   sweep.mjs inputs --change <name> [--round <k>] [--root <change worktree>]
//       { ok, change, base, mergeBase, head, round, reSweep?, range, secondQuestion,
//         removedOrRenamed: [{ op, requirement, from?, codeDisposition, spec }],
//         missingDisposition, dupMarkers: [{ file, line, existing, reason, wholeFile }] }
//       base is `origin/<base>` when that ref exists, else `<base>`, from the change's metadata;
//       range is merge-base..HEAD, the diff the sweep reads; in apply round `round` (0 before
//       any, `plan.mjs reopen`) the round's base..HEAD. With --round <k>, the inputs of
//       consolidation k's re-sweep (`sweep r<k>`, `reSweep` k): range is that consolidation's
//       diff, from the HEAD the last accepted sweep before it ran on, and secondQuestion false.
//       The first sweep's two passes (`sweep p1`, `sweep p2`) read the same inputs.
//       secondQuestion is true when a delta spec carries REMOVED or RENAMED; codeDisposition
//       null is itself a finding.
//   sweep.mjs filter <reply file> [--root <change worktree>] [--record --change <name>]
//       { ok, verdict, findings, dropped, dispositions?, debt? }: the validated sweep reply with
//       every finding dropped whose introduced location carries a DUP marker naming its
//       `existing`; the verdict is computed from what is left (the reply states none). A refused reply exits 1: it is no verdict, never
//       CLEAN. --record writes one `debt` ledger record per disposition, the sweep's answer as
//       its reason, once per requirement (lib/sweep.mjs recordDispositions); `debt` lists each
//       id, or why it was skipped.
//   sweep.mjs consolidate --change <name> --reason "<why>" [--root <change worktree>]
//       { ok, round, findings, fix, reReview, sweep, record, already }: a consolidation round over
//       the open sweep findings and the open findings of the consolidation's own review loop,
//       recorded as a `consolidation` ledger record; fix, reReview and sweep are the round's
//       dispatch names (`fix sweep r<k>`, `re-review sweep r<k>`, `sweep r<k>`). A round whose
//       re-sweep has no accepted reply is returned again with already true, nothing recorded.
//       Refused until both passes of the first sweep are accepted on one HEAD, with nothing open, and after the last round (lib/dispatch.mjs MAX_ROUNDS). In an
//       apply round its findings and rounds count from the round's start: round 1 again.
//
// A relative <reply file> is read from --root (default: the current directory).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { consolidate, filterReply, recordDispositions, sweepInputs } from './lib/sweep.mjs'

export const USAGE =
  'usage: sweep.mjs inputs --change <name> [--round <k>] [--root <dir>] | sweep.mjs filter <reply file> [--root <dir>] [--record --change <name>] | sweep.mjs consolidate --change <name> --reason "<why>" [--root <dir>]'

export class UsageError extends Error {}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--record') {
      values.record = true
      continue
    }
    if (!['--change', '--root', '--reason', '--round'].includes(arg)) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    values[arg.slice(2)] = value
    i++
  }
  return { ...values, rest }
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { change, root = cwd, record, reason, round, rest } = parse(argv)
  const [command, file, ...extra] = rest
  if (command === 'consolidate' && change && file === undefined && !record) return consolidate(root, change, { reason, env })
  if (reason !== undefined || (round !== undefined && command !== 'inputs')) throw new UsageError(USAGE)
  if (round !== undefined && !/^[1-9]\d*$/.test(round)) throw new UsageError(`--round is a positive integer, not "${round}"`)
  if (command === 'inputs' && change && file === undefined && !record) return sweepInputs(root, change, { reSweep: round === undefined ? undefined : Number(round) })
  if (command === 'filter' && file && extra.length === 0 && Boolean(change) === Boolean(record)) {
    let text
    try {
      text = readFileSync(resolve(root, file), 'utf8')
    } catch {
      return { ok: false, error: `cannot read ${file}; a sweep with no reply is no verdict` }
    }
    const result = filterReply(root, text)
    if (!record || !result.ok) return result
    return { ...result, debt: recordDispositions(root, change, result.dispositions, { env }) }
  }
  throw new UsageError(USAGE)
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
