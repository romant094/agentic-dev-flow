#!/usr/bin/env node
// CLI over lib/sweep.mjs: the inputs of apply's code reuse sweep, and the filter over its reply.
// Prints one JSON object on stdout; exit 1 on a refusal, exit 2 on a usage error.
//
//   sweep.mjs inputs --change <name> [--root <change worktree>]
//       { ok, change, base, mergeBase, head, range, secondQuestion,
//         removedOrRenamed: [{ op, requirement, from?, codeDisposition, spec }],
//         missingDisposition, dupMarkers: [{ file, line, existing, reason, wholeFile }] }
//       base is `origin/<base>` when that ref exists, else `<base>`, from the change's .adf.json;
//       range is merge-base..HEAD, the diff the sweep reads. secondQuestion is true when a delta
//       spec carries REMOVED or RENAMED; codeDisposition null is itself a finding.
//   sweep.mjs filter <reply file> [--root <change worktree>]
//       { ok, verdict, findings, dropped, dispositions? }: the validated sweep reply with every
//       finding dropped whose introduced location carries a DUP marker naming its `existing`;
//       verdict is recomputed. A refused reply exits 1: it is no verdict, never CLEAN.
//
// A relative <reply file> is read from --root (default: the current directory).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { filterReply, sweepInputs } from './lib/sweep.mjs'

export const USAGE = 'usage: sweep.mjs inputs --change <name> [--root <dir>] | sweep.mjs filter <reply file> [--root <dir>]'

export class UsageError extends Error {}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--change', '--root'].includes(arg)) {
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

export function run(argv, { cwd = process.cwd() } = {}) {
  const { change, root = cwd, rest } = parse(argv)
  const [command, file, ...extra] = rest
  if (command === 'inputs' && change && file === undefined) return sweepInputs(root, change)
  if (command === 'filter' && file && extra.length === 0 && !change) {
    let text
    try {
      text = readFileSync(resolve(root, file), 'utf8')
    } catch {
      return { ok: false, error: `cannot read ${file}; a sweep with no reply is no verdict` }
    }
    return filterReply(root, text)
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
