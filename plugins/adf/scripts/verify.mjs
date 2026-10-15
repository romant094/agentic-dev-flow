#!/usr/bin/env node
// CLI over lib/verify.mjs. Prints one JSON object on stdout; exit 1 on a refusal or a failing
// check (run) or a FAIL verdict (verdict), exit 2 on a usage error.
//
//   verify.mjs run --change <name> [--root <change worktree>] [--fresh] [--skill-edit <sha> ...]
//       run the mechanical checks; each writes its raw output under
//       .superpowers/sdd/<change>/verify/ and the list is kept in verify/run.json.
//       --fresh first deletes that directory: the first run of a verify session
//       --skill-edit names a commit of an approved skill edit, exempt from the out-of-plan
//       check for its files under .claude/skills/
//   verify.mjs verdict --change <name> [--root <change worktree>] [--out <file>]
//       read run.json and the agents' verify/<id>.json sections, apply the developer's
//       rulings from the ledger, and compute the `Verdict:` line; --out also writes the result
//       to a file
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { loadSchema } from './lib/schema.mjs'
import { computeVerdict, runChecks } from './lib/verify.mjs'

export const USAGE =
  'usage: verify.mjs run --change <name> [--root <dir>] [--fresh] [--skill-edit <sha> ...] | verify.mjs verdict --change <name> [--root <dir>] [--out <file>]'

export class UsageError extends Error {}

function parse(argv) {
  const args = [...argv]
  const values = { skillEdits: [], fresh: false }
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--fresh') {
      values.fresh = true
      continue
    }
    if (!['--change', '--root', '--skill-edit', '--out'].includes(arg)) {
      rest.push(arg)
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (arg === '--skill-edit') values.skillEdits.push(value)
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  return { ...values, rest }
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { change, root = cwd, skillEdits, fresh, out, rest } = parse(argv)
  const [command, ...extra] = rest
  if (!change || extra.length > 0 || !['run', 'verdict'].includes(command)) throw new UsageError(USAGE)
  if (command === 'verdict') {
    if (skillEdits.length > 0 || fresh) throw new UsageError('--skill-edit and --fresh belong to run')
    const result = computeVerdict(root, { change })
    if (out) writeFileSync(resolve(cwd, out), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }
  if (out) throw new UsageError('--out belongs to verdict')
  return runChecks(root, { change, skillEdits, fresh, tracks: loadSchema().apply?.tracks ?? 'tasks.md' })
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
