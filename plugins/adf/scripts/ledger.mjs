#!/usr/bin/env node
// CLI over lib/ledger.mjs. Every subcommand prints one JSON object on stdout and exits 1 on
// a refusal.
//
//   ledger.mjs <kind> --change <name> [--field value ...]   append one record
//   ledger.mjs list --change <name> [--unresolved-debt]      the records, or the open debt
//
// --root <dir> names the host project (default: the current directory); --repo <dir> is
// kept as its older spelling. The session id is read from CLAUDE_CODE_SESSION_ID.
import { fileURLToPath } from 'node:url'
import { appendRecord, KINDS, listRecords, parseFlags } from './lib/ledger.mjs'

export const USAGE = `Usage:
  ledger.mjs <kind> --change <name> [--field value ...] [--root <dir>]
  ledger.mjs list --change <name> [--unresolved-debt] [--root <dir>]
Kinds: ${Object.entries(KINDS)
  .map(
    ([k, v]) =>
      `${k} (${v.required.map((f) => `--${f}`).join(' ')}${v.optional.length ? ` [${v.optional.map((f) => `--${f}`).join(' ')}]` : ''})`
  )
  .join('; ')}`

export function run(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const [kind, ...rest] = argv
  if (!kind) throw new Error('a kind is required')
  const unresolvedOnly = rest.includes('--unresolved-debt')
  const { change, root, repo, ...fields } = parseFlags(rest.filter((a) => a !== '--unresolved-debt'))
  if (!change) throw new Error('--change is required')
  const dir = root ?? repo ?? cwd
  if (kind === 'list') return { ok: true, records: listRecords(dir, change, { unresolvedOnly }) }
  const { record, path } = appendRecord(dir, change, kind, fields, { env })
  return { ok: true, record, path }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, usage: USAGE })}\n`)
    process.exitCode = 1
  }
}
