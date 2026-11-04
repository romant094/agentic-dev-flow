#!/usr/bin/env node
// CLI over lib/runlog.mjs: packs a run of the flow into one archive for the maintainer. Prints
// one JSON object on stdout; exit 1 on a refusal, exit 2 on a usage error. The archive format is
// in lib/runlog.mjs's header.
//
//   runlog.mjs collect [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--root <dir>]
//       { ok, archive, bytes, sessions, changes, skipped, warning }: `.adf/runlog/<to>-<runtime>.tar.gz`
//       in the main directory. The default window is the last 7 days, ending today. The warning
//       says the archive holds whole sessions; read it before sending the archive.
import { isMain } from './lib/main.mjs'
import { collect } from './lib/runlog.mjs'

export const USAGE = 'usage: runlog.mjs collect [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--root <dir>]'

export class UsageError extends Error {}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const [command, ...rest] = argv
  if (command !== 'collect') throw new UsageError(USAGE)
  const values = {}
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!['--from', '--to', '--root'].includes(flag)) throw new UsageError(`unknown argument ${flag}`)
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    values[flag.slice(2)] = value
  }
  try {
    return collect(values.root ?? cwd, { from: values.from, to: values.to, env })
  } catch (error) {
    return { ok: false, error: error.message }
  }
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
