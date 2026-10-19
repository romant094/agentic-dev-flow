#!/usr/bin/env node
// CLI over lib/retro-run.mjs: /adf:retro's deterministic steps, each resumable. Prints one JSON
// object on stdout; exit 1 on a refusal or a failed step, exit 2 on a usage error. --root is the
// host checkout or the retro worktree (default: the current directory); --home names the Claude
// Code home where the plugins are found. A retrospective is named by its id, `<date>-window`,
// `<date>-period` or `<date>-<change>`: start makes it from --date (default today) and the mode;
// every other step takes --id, default the newest retrospective started in the main checkout.
//
// The steps, in this order; each runs once every step before it is settled (done, degraded or
// skipped), a done or skipped step is reported as it is, a failed or degraded one runs again:
//   retro.mjs start [--date <d>] [--mode window|change|period] [--change <name>] [--from <d> --to <d>]
//       the integration ref fetched; branch chore/retro/<id> and its worktree
//       .claude/worktrees/retro-<id> made from the integration branch; the mode kept. The
//       mode defaults to window, or to change with --change, or to period with --from and --to;
//       window takes none of them, change takes --change only, period both dates only
//   retro.mjs window
//       the sidecar (lib/window.mjs buildSidecar) over the fetched ref, the knowledge provider's
//       paths excluded from the diff figures; the agent's input written to its input file, the
//       prompt to detail.dispatch.promptFile, the dispatch recorded; detail.dispatch is the plan
//       the orchestrator dispatches (name, agent, worktree, inputFile, replyFile, promptFile)
//   retro.mjs reply --file <reply json> [--resume yes|no]
//       the reply checked and recorded (lib/retro.mjs recordRetroReply); refused: failed with
//       detail.next retry, the retry's dispatch recorded and its plan in detail.dispatch, then
//       stop; valid: detail.result, the computed reply, kept in the state
//   retro.mjs render
//       .adf/retro/<id>.json (the sidecar and the computed reply) and .md in the worktree
//   retro.mjs record
//       commit.mjs --only those two files: `docs(retro): <mode> retrospective <date>`, with
//       ` of <change>` for one change
//   retro.mjs publish [--yes]
//       the forge's open with draft false and ci false into the integration branch, never merged;
//       no forge: held (pending, the commands) until --yes, then a local merge in the main
//       checkout, nothing pushed, the branch kept
//   retro.mjs file [--yes] [--findings R1,R2]
//       the upstream role's file with { report, findings } (default every finding) after --yes;
//       without it pending, with `would`; no provider: skipped, the findings stay in the sidecar
//   retro.mjs remove
//       the retro worktree removed from the main checkout (lib/workspace.mjs remove): a dirty
//       tree refused, never forced, the branch kept; later calls take --root <main>
// Each prints { ok, id, date, mode, step, state, detail, next, already?, pending?, refusal? }.
//
// Read-only:
//   retro.mjs since       { ok, fetch, ref, fetchedAt, previous, count, changes, lintDue }: the
//                         changes archived since the last window retrospective, after a fetch
//   retro.mjs state       { ok, id, date, mode, scope, startedAt, steps, next }
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMain } from './lib/main.mjs'
import { fileStep, publishStep, recordStep, Refusal, removeStep, renderStep, replyStep, retroContext, since, startStep, stateOf, windowStep } from './lib/retro-run.mjs'
import { RETRO_ID } from './lib/dispatch.mjs'
import { MergeRefusal } from './lib/local-merge.mjs'
import { MODES } from './lib/window.mjs'

export const USAGE = `usage:
  retro.mjs start [--date <YYYY-MM-DD>] [--mode window|change|period] [--change <name>] [--from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--root <dir>] [--home <dir>]
  retro.mjs window|render|record|remove|state [--id <id>] [--root <dir>] [--home <dir>]
  retro.mjs reply --file <reply json> [--resume yes|no] [--id <id>] [--root <dir>]
  retro.mjs publish [--yes] [--id <id>] [--root <dir>] [--home <dir>]
  retro.mjs file [--yes] [--findings R1,R2] [--id <id>] [--root <dir>] [--home <dir>]
  retro.mjs since [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = {
  date: { type: 'string' },
  id: { type: 'string' },
  mode: { type: 'string' },
  change: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  root: { type: 'string' },
  home: { type: 'string' },
  file: { type: 'string' },
  resume: { type: 'string' },
  yes: { type: 'boolean' },
  findings: { type: 'string' }
}
const COMMON = ['root', 'home']
const TAKES = {
  start: ['date', 'mode', 'change', 'from', 'to'],
  window: ['id'],
  reply: ['id', 'file', 'resume'],
  render: ['id'],
  record: ['id'],
  publish: ['id', 'yes'],
  file: ['id', 'yes', 'findings'],
  remove: ['id'],
  since: [],
  state: ['id']
}
const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v) => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const usage = (message) => {
  throw new UsageError(`${message}\n${USAGE}`)
}

// The mode and its arguments: the mode named, or the one the arguments imply.
function scopeOf({ mode, change, from, to }) {
  const m = mode ?? (change !== undefined ? 'change' : from !== undefined || to !== undefined ? 'period' : 'window')
  if (!MODES.includes(m)) usage(`--mode is one of ${MODES.join(', ')}, not "${m}"`)
  if (m === 'window' && (change !== undefined || from !== undefined || to !== undefined)) usage('mode window takes no --change, --from or --to')
  if (m === 'change') {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(change ?? '')) usage('mode change needs --change <name>, kebab-case')
    if (from !== undefined || to !== undefined) usage('mode change takes no --from or --to')
    return { mode: m, change }
  }
  if (m === 'period') {
    if (!isDay(from ?? '') || !isDay(to ?? '')) usage('mode period needs --from and --to as YYYY-MM-DD')
    if (change !== undefined) usage('mode period takes no --change')
    if (from > to) usage(`the period starts after it ends: ${from} > ${to}`)
    return { mode: m, from, to }
  }
  return { mode: m }
}

function findingIds(text) {
  if (text === undefined) return undefined
  const ids = text.split(',').map((s) => s.trim())
  if (ids.length === 0 || !ids.every((id) => /^R[1-9]\d*$/.test(id))) usage(`--findings takes finding ids as R1,R2, not "${text}"`)
  return [...new Set(ids)]
}

// deps: as lib/retro-run.mjs retroContext takes them; the tests inject the roles and the clock.
export function run(argv, { cwd = process.cwd(), deps = {} } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(`${error.message}\n${USAGE}`)
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (!Object.hasOwn(TAKES, command ?? '') || extra.length > 0) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => !COMMON.includes(k) && !TAKES[command].includes(k))
  if (stray.length > 0) usage(`${command} takes no --${stray[0]}`)
  if (values.date !== undefined && !isDay(values.date)) usage(`--date is YYYY-MM-DD, not "${values.date}"`)
  if (values.id !== undefined && !(RETRO_ID.test(values.id) && isDay(values.id.slice(0, 10)))) usage(`--id is <YYYY-MM-DD>-<window | period | change name>, not "${values.id}"`)
  if (values.resume !== undefined && !['yes', 'no'].includes(values.resume)) usage('--resume is yes or no')
  if (command === 'reply' && !values.file) usage('reply needs --file <reply json>')
  const root = values.root ?? cwd
  if (command === 'since') return since(root)
  const scope = command === 'start' ? scopeOf(values) : null
  const findings = findingIds(values.findings)
  const ctx = retroContext(root, { id: values.id, date: values.date, scope, start: command === 'start', deps: { ...(values.home ? { home: values.home } : {}), ...deps } })
  switch (command) {
    case 'start':
      return startStep(ctx, scope)
    case 'window':
      return windowStep(ctx)
    case 'reply':
      return replyStep(ctx, { file: resolve(cwd, values.file), resume: values.resume !== 'no' })
    case 'render':
      return renderStep(ctx)
    case 'record':
      return recordStep(ctx)
    case 'publish':
      return publishStep(ctx, { yes: Boolean(values.yes) })
    case 'file':
      return fileStep(ctx, { yes: Boolean(values.yes), findings })
    case 'remove':
      return removeStep(ctx)
    default:
      return stateOf(ctx)
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const isUsage = error instanceof UsageError
    const extra = error instanceof Refusal || error instanceof MergeRefusal ? error.extra : {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...extra, ...(isUsage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = isUsage ? 2 : 1
  }
}
