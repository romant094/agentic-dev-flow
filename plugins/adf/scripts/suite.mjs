#!/usr/bin/env node
// CLI over lib/suite.mjs. Prints one JSON object on stdout; exit 1 on a refusal, or when a run
// is not a pass (a blocking failure, or the suite not run), exit 2 on a usage error.
//
//   suite.mjs command [--root <dir>]
//       the whole-suite command of <root>/openspec/planning.md: { file, command | null, reason? }
//   suite.mjs set --command "<cmd>" [--root <dir>]
//       write the command under `## Whole-suite command`, creating the file or the section when
//       absent: { file, command }. Committing it is the caller's job.
//   suite.mjs run --change <name> [--root <change worktree>] [--base-check] [--record]
//                 [--section test-record]
//       run the command in <root> through the platform shell, its output to
//       .superpowers/sdd/<change>/suite/<stamp>.txt, never to stdout:
//       { status, exit, counts, outputFile, failing, base?, preExisting, newFailures, blocking,
//         comparison, ok, record?, section? }
//       --base-check on a failure runs it again in a worktree of the change's base, then
//       removes that worktree (never forced) to tell a pre-existing failure from a new one
//       --record writes openspec/changes/<change>/.apply-test-record.md; commit it as apply's
//       final commit
//       --section test-record writes verify/test-record.json and its output file, the re-run
//       of a stale record
//   With no command in the guide, run reports `status: "not-run"` with the reason; never a pass.
import { isMain } from './lib/main.mjs'
import { readCommand, runSuite, writeCommand } from './lib/suite.mjs'

export const USAGE =
  'usage: suite.mjs command [--root <dir>] | suite.mjs set --command "<cmd>" [--root <dir>] | suite.mjs run --change <name> [--root <dir>] [--base-check] [--record] [--section test-record]'

export class UsageError extends Error {}

const VALUED = ['--change', '--root', '--command', '--section']
const FLAGS = ['--base-check', '--record']

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (FLAGS.includes(arg)) {
      values[arg.slice(2)] = true
      continue
    }
    if (!VALUED.includes(arg)) {
      if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  const root = values.root ?? cwd
  if (extra.length > 0) throw new UsageError(USAGE)
  const only = (allowed) => {
    const stray = Object.keys(values).filter((k) => k !== 'root' && !allowed.includes(k))
    if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  }
  switch (sub) {
    case 'command':
      only([])
      return readCommand(root)
    case 'set':
      only(['command'])
      if (!values.command) throw new UsageError('set needs --command')
      return writeCommand(root, values.command)
    case 'run':
      only(['change', 'base-check', 'record', 'section'])
      if (!values.change) throw new UsageError('run needs --change')
      if (values.section !== undefined && values.section !== 'test-record') throw new UsageError('--section must be test-record')
      return runSuite(root, { change: values.change, baseCheck: Boolean(values['base-check']), record: Boolean(values.record), section: values.section ?? null })
    default:
      throw new UsageError(USAGE)
  }
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
