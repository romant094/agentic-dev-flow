#!/usr/bin/env node
// CLI over lib/suite.mjs. Prints one JSON object on stdout; exit 1 on a refusal, or when a run
// is not a pass (a blocking failure, or the suite not run), exit 2 on a usage error.
//
//   suite.mjs command [--root <dir>]
//       the whole-suite command of <root>/openspec/planning.md: { file, command | null, reason? }
//   suite.mjs set --command "<cmd>" [--root <dir>] [--commit]
//       write the command under `## Whole-suite command`, creating the file or the section when
//       absent: { file, command }. --commit then commits that file alone through lib/commit.mjs
//       with the message SET_MESSAGE: { ..., commit }
//   suite.mjs run --change <name> [--root <change worktree>] [--base-check] [--record [--commit]]
//                 [--section test-record|review] [--timeout <minutes>]
//       run the command in <root> through the platform shell, its output to
//       .superpowers/sdd/<change>/suite/<stamp>.txt, never to stdout:
//       { status, exit, counts, outputFile, failing, base?, preExisting, newFailures, blocking,
//         comparison, ok, record?, section? }
//       --base-check on a failure runs it again in a worktree of the change's base, then
//       removes that worktree (never forced) to tell a pre-existing failure from a new one
//       --record writes openspec/changes/<change>/.apply-test-record.md, apply's final commit;
//       --commit then commits that record alone through lib/commit.mjs with the message
//       recordMessage(<change>), whatever the run's status: { ..., commit }
//       --section test-record writes verify/test-record.json and its output file, the re-run
//       of a stale record; --section review writes .superpowers/sdd/<change>/review/suite.json,
//       the run after the review stage's last fix, always with the base check (as if
//       --base-check were given), which review.mjs assemble requires when a fix landed
//       --timeout stops each run after that many minutes (default 30, DEFAULT_TIMEOUT_MINUTES);
//       a stopped run is cannotRun with timedOut: true, a failure and never a pass
//   With no command in the guide, run reports `status: "not-run"` with the reason; never a pass.
import { commitPaths } from './lib/commit.mjs'
import { isMain } from './lib/main.mjs'
import { DEFAULT_TIMEOUT_MINUTES, readCommand, recordMessage, runSuite, SECTIONS, SET_MESSAGE, writeCommand } from './lib/suite.mjs'

export const USAGE =
  'usage: suite.mjs command [--root <dir>] | suite.mjs set --command "<cmd>" [--root <dir>] [--commit] | suite.mjs run --change <name> [--root <dir>] [--base-check] [--record [--commit]] [--section test-record|review] [--timeout <minutes>]'

export class UsageError extends Error {}

const VALUED = ['--change', '--root', '--command', '--section', '--timeout']
const FLAGS = ['--base-check', '--record', '--commit']

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
    case 'set': {
      only(['command', 'commit'])
      if (!values.command) throw new UsageError('set needs --command')
      const written = writeCommand(root, values.command)
      if (!values.commit) return written
      return { ...written, commit: commitPaths(root, { only: [written.file], message: SET_MESSAGE }).commit }
    }
    case 'run': {
      only(['change', 'base-check', 'record', 'section', 'timeout', 'commit'])
      if (!values.change) throw new UsageError('run needs --change')
      if (values.commit && !values.record) throw new UsageError('--commit commits the record; pass --record')
      if (values.section !== undefined && !SECTIONS.includes(values.section)) throw new UsageError(`--section must be one of ${SECTIONS.join(', ')}`)
      const timeoutMinutes = values.timeout === undefined ? DEFAULT_TIMEOUT_MINUTES : Number(values.timeout)
      if (!(timeoutMinutes > 0 && Number.isFinite(timeoutMinutes))) throw new UsageError('--timeout must be a positive number of minutes')
      const out = runSuite(root, { change: values.change, baseCheck: Boolean(values['base-check']), record: Boolean(values.record), section: values.section ?? null, timeoutMinutes })
      if (!values.commit) return out
      return { ...out, commit: commitPaths(root, { only: [out.record], message: recordMessage(values.change) }).commit }
    }
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
