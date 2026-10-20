#!/usr/bin/env node
// Dev tool: compares the execution ledger (plugins/adf/scripts/ledger.mjs) with the origin's
// .claude/scripts/ledger.mjs. Both scripts run as child processes against their own temporary
// directories under the system temp directory; nothing is written in the origin project.
//
//   node scripts/parity/origin-ledger.mjs <origin project root>
//
// A generated corpus of argument vectors — a valid record of every kind with and without its
// optional fields, every refusal, and both list forms — runs in order through both scripts.
// After each step the accept or refuse decision, the refusal reason, the JSONL file (with the
// `at` timestamps normalized) and the listed or recorded records are compared. The deliberate
// differences:
//   json-output          the origin prints prose on success and on stderr on refusal; ours
//                        prints one JSON object on stdout ({ ok, record, path } / { ok, records }
//                        / { ok, error })
//   renamed-resolution   the resolution the origin calls flow-debt is adf-debt here. The origin
//                        is sent `--as flow-debt` where ours is sent `--as adf-debt`, and its
//                        output and ledger read with flow-debt as adf-debt before comparing
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, RESOLUTIONS } from '../../plugins/adf/scripts/lib/ledger.mjs'

const origin = process.argv[2]
const originScript = origin && join(origin, '.claude', 'scripts', 'ledger.mjs')
if (!originScript || !existsSync(originScript)) {
  console.error('usage: origin-ledger.mjs <origin project root with .claude/scripts/ledger.mjs>')
  process.exit(2)
}
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'ledger.mjs')
const theirRoot = mkdtempSync(join(tmpdir(), 'adf-parity-ledger-origin-'))
const ourRoot = mkdtempSync(join(tmpdir(), 'adf-parity-ledger-ours-'))

// The corpus: [argv without the root flag, session id or null, whether to pass the root flag].
// Without the flag both scripts fall back to their working directory, the temporary root.
const corpus = []
const add = (argv, session = null, rootFlag = true) => corpus.push([argv, session, rootFlag])
const value = (field) => (field === 'task' ? '2.1' : field === 'as' ? 'tech-debt' : field === 'debt' ? 'debt-1' : `${field} text`)
const flags = (fields, extra = {}) => fields.flatMap((f) => [`--${f}`, extra[f] ?? value(f)])

for (const change of ['alpha', 'beta']) {
  const c = ['--change', change]
  add(['list', ...c])
  add(['resolve', ...c, ...flags(KINDS.resolve.required)])
  for (const [kind, spec] of Object.entries(KINDS)) {
    const session = kind === 'session' ? null : 'sess-1'
    add([kind, ...c, ...flags(spec.required)], kind === 'session' ? 'sess-1' : null)
    add([kind, ...c, ...flags([...spec.required, ...spec.optional])], session)
    for (const missing of spec.required) {
      add([kind, ...c, ...flags(spec.required.filter((f) => f !== missing))], session)
      add([kind, ...c, ...flags(spec.required, { [missing]: '   ' })], session)
    }
    add([kind, ...c, ...flags(spec.required), '--note', 'stray prose'], session)
    if (spec.optional.includes('task')) {
      for (const task of ['3', '10.2', 'three', '1.2.3', '-1', '2.', ' 4']) add([kind, ...c, ...flags(spec.required, { task }), '--task', task], session)
    }
  }
  add(['session', ...c, '--phase', 'apply'])
  add(['session', ...c, '--phase', 'apply', '--sessionId', 'typed'], 'sess-2')
  for (const as of [...RESOLUTIONS, 'later']) add(['resolve', ...c, '--debt', 'debt-1', '--as', as, '--where', 'x'])
  add(['resolve', ...c, '--debt', 'debt-99', '--as', 'accepted', '--where', 'x'])
  add(['resolve', ...c, '--debt', 'deviation-1', '--as', 'accepted', '--where', 'x'])
  add(['list', ...c])
  add(['list', ...c, '--unresolved-debt'])
  add(['debt', ...c, '--what', 'a', '--reason', 'b', '--unresolved-debt'])
  add(['list', ...c, '--unresolved-debt'])
}
for (const kind of ['dispatch', 'toString', '__proto__', 'Debt']) add([kind, '--change', 'alpha'])
add([])
add([], null, false)
add(['list', '--change', 'alpha'], null, false)
add(['ruling', '--change', 'alpha', '--finding', 'f', '--decision', 'd'], null, false)
add(['debt', '--what', 'a', '--reason', 'b'])
add(['debt', 'stray', '--change', 'alpha'])
add(['debt', '--change', 'alpha', '--what'])
add(['debt', '--change', 'alpha', '--what', '--reason', 'b'])
add(['list'])

const env = (session) => {
  const e = { ...process.env }
  delete e.CLAUDE_CODE_SESSION_ID
  if (session) e.CLAUDE_CODE_SESSION_ID = session
  return e
}
// The origin's spelling of the one renamed resolution: its argv, and ours read from its output.
const toTheirs = (argv) => argv.map((a, i) => (a === 'adf-debt' && argv[i - 1] === '--as' ? 'flow-debt' : a))
const renamed = (text) => text?.replaceAll('flow-debt', 'adf-debt') ?? text
const runIn = (script, argv, root, flag, session) =>
  spawnSync('node', [script, ...argv, ...(flag ? [flag, root] : [])], { cwd: root, env: env(session), encoding: 'utf8' })

// The `at` timestamp differs between any two runs; the root directory differs between ours
// and theirs.
const normalizeRecord = (r) => (r && typeof r === 'object' && 'at' in r ? { ...r, at: '<at>' } : r)
const ledgerText = (root, change) => {
  const path = join(root, '.superpowers', 'sdd', change, 'ledger.jsonl')
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').replace(/"at":"[^"]*"/g, '"at":"<at>"')
}
const changeOf = (argv) => {
  const i = argv.indexOf('--change')
  return i === -1 ? null : argv[i + 1]
}

function theirOutcome(proc, root) {
  if (proc.status !== 0) {
    const match = /^ledger: (.*?)\n\nUsage:/s.exec(proc.stderr)
    return { ok: false, error: (match ? match[1] : proc.stderr.trim()).replace(root, '<root>'), form: 'stderr-prose' }
  }
  const recorded = /^(\S+) recorded in (.+)\n$/.exec(proc.stdout)
  if (recorded) return { ok: true, id: recorded[1], path: recorded[2].replace(root, '<root>'), form: 'stdout-prose' }
  return { ok: true, records: JSON.parse(proc.stdout).map(normalizeRecord), form: 'stdout-json-array' }
}

function ourOutcome(proc, root) {
  const out = JSON.parse(proc.stdout)
  if (proc.status !== 0 || out.ok !== true) return { ok: false, error: out.error.replace(root, '<root>'), form: 'stdout-json' }
  if (out.record) return { ok: true, id: out.record.id, path: out.path.replace(root, '<root>'), form: 'stdout-json' }
  return { ok: true, records: out.records.map(normalizeRecord), form: 'stdout-json' }
}

const differences = []
let compared = 0
let accepted = 0
for (const [argv, session, rootFlag] of corpus) {
  compared++
  const their = theirOutcome(runIn(originScript, toTheirs(argv), theirRoot, rootFlag && '--repo', session), theirRoot)
  const ours = ourOutcome(runIn(ourScript, argv, ourRoot, rootFlag && '--root', session), ourRoot)
  if (their.ok) accepted++
  const change = changeOf(argv)
  const theirLedger = change && ledgerText(theirRoot, change)
  const ourLedger = change && ledgerText(ourRoot, change)
  const { form: theirForm, ...theirContent } = their
  const { form: ourForm, ...ourContent } = ours
  const sameContent = JSON.stringify(theirContent) === JSON.stringify(ourContent) && theirLedger === ourLedger
  if (sameContent && theirForm === ourForm) continue
  const sameRenamed = renamed(JSON.stringify(theirContent)) === JSON.stringify(ourContent) && renamed(theirLedger) === ourLedger
  differences.push({
    case: { argv, ...(toTheirs(argv).join('\0') === argv.join('\0') ? {} : { theirArgv: toTheirs(argv) }), session },
    theirs: their,
    ours,
    ...(theirLedger === ourLedger ? {} : { theirLedger, ourLedger }),
    explained: sameContent ? 'json-output' : sameRenamed ? 'renamed-resolution' : null
  })
}

const unexplained = differences.filter((d) => d.explained === null)
const byReason = {}
for (const d of differences) if (d.explained) byReason[d.explained] = (byReason[d.explained] ?? 0) + 1
console.log(JSON.stringify({
  compared,
  accepted,
  refused: compared - accepted,
  differences: differences.length,
  explained: byReason,
  unexplained
}, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
