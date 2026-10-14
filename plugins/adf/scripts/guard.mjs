#!/usr/bin/env node
// CLI over lib/guard.mjs. Prints one JSON object; exit 1 on a refusal or when `compare` finds
// a change outside the dispatch targets.
//
//   guard.mjs snapshot --change <name> --targets <root1,root2> [--root <change worktree>]
//       before a dispatch: record every other checkout of the repository
//   guard.mjs compare --change <name> [--root <change worktree>]
//       after it: every recorded checkout must be unchanged
import { compare, snapshot } from './lib/guard.mjs'
import { isMain } from './lib/main.mjs'

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
  const targets = option(args, '--targets')
  const [command] = args
  if (!change || args.length !== 1) throw new Error('usage: guard.mjs snapshot|compare --change <name> [--targets <roots>] [--root <dir>]')
  if (command === 'snapshot') return snapshot(root, { change, targets: targets?.split(',').map((t) => t.trim()).filter(Boolean) })
  if (command === 'compare') return compare(root, { change })
  throw new Error('usage: guard.mjs snapshot|compare --change <name>')
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
