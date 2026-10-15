#!/usr/bin/env node
// CLI over lib/guard.mjs. Prints one JSON object; exit 1 on a refusal or when `compare` finds
// a change outside the dispatch targets.
//
//   guard.mjs snapshot --change <name> --dispatch "<name>" [--dispatch "<name>" ...]
//                      [--root <change worktree>]
//       before a round: every dispatch of the round by its fixed-form name (the `name` of
//       dispatch.mjs prompt); the targets are their worktrees, computed as dispatch.mjs places
//       them. Records every other checkout of the repository:
//       { dispatches, targets, watched }
//   guard.mjs compare --change <name> [--root <change worktree>]
//       after it: every recorded checkout must be unchanged: { ok, dispatches, targets, changed }
import { compare, snapshot, targetsOf } from './lib/guard.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: guard.mjs snapshot --change <name> --dispatch "<name>" [--dispatch "<name>" ...] [--root <dir>] | guard.mjs compare --change <name> [--root <dir>]'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const change = option(args, '--change')
  const names = []
  for (let name = option(args, '--dispatch'); name !== undefined; name = option(args, '--dispatch')) names.push(name)
  const [command] = args
  if (!change || args.length !== 1) throw new Error(USAGE)
  if (command === 'snapshot') {
    const targets = targetsOf(root, change, names)
    return snapshot(root, { change, dispatches: names, targets: [...new Set(targets.map((t) => t.worktree))] })
  }
  if (command === 'compare' && names.length === 0) return compare(root, { change })
  throw new Error(USAGE)
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
