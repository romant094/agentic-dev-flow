#!/usr/bin/env node
// CLI over lib/tasks.mjs. Prints one JSON object; exit 1 on a refusal.
//
//   tasks.mjs tick <item> --change <name> [--root <dir>]   tick task <item>, such as 1.2
import { tickTask } from './lib/tasks.mjs'
import { isMain } from './lib/main.mjs'
import { loadSchema } from './lib/schema.mjs'

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
  const [command, item] = args
  if (command !== 'tick' || !item || !change || args.length > 2) {
    throw new Error('usage: tasks.mjs tick <item> --change <name> [--root <dir>]')
  }
  return tickTask(root, change, item, { tracks: loadSchema().apply?.tracks ?? 'tasks.md' })
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
