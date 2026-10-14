#!/usr/bin/env node
// Dev tool: compares the reply validator (plugins/adf/scripts/reply.mjs) with the origin's
// .claude/scripts/check-reply.mjs. Both scripts run as child processes on the same files in
// one temporary directory under the system temp directory; nothing is written in the origin.
//
//   node scripts/parity/origin-reply.mjs <origin project root>
//
// A generated matrix, per role: the valid reply, then every field omitted, replaced by a value
// of each wrong type, and every nested object mutated the same way; an unknown key at the top
// and in each nested object; the role key missing, wrong and of another role; every enum and
// cross-field rule broken and kept. Beside it: non-object and non-JSON files, an unknown
// role, a missing flag or file, and an unreadable file. After each case the exit code and the
// refusal reasons (or the wrong-call message) are compared. The one deliberate difference is
// the output form:
//   json-output   the origin prints nothing on success and prose on stderr otherwise; ours
//                 prints one JSON object on stdout ({ ok, role, file } / { ok, error, reasons }
//                 / { ok, error, usage }); its usage line names reply.mjs and --root
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES } from '../../plugins/adf/scripts/lib/reply.mjs'

const origin = process.argv[2]
const originScript = origin && join(origin, '.claude', 'scripts', 'check-reply.mjs')
if (!originScript || !existsSync(originScript)) {
  console.error('usage: origin-reply.mjs <origin project root with .claude/scripts/check-reply.mjs>')
  process.exit(2)
}
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'reply.mjs')
const dir = mkdtempSync(join(tmpdir(), 'adf-parity-reply-'))

const impl = (role) => ({
  role,
  status: 'DONE',
  commits: [{ sha: 'abc1234', subject: 'feat: x' }],
  tests: { command: 'node --test', result: 'pass', summary: '3 passed' },
  concerns: ['c'],
  report: '/tmp/r.md'
})
const review = (role) => ({ role, verdict: 'pass', findings: [{ severity: 'minor', file: 'a.mjs', line: 3, summary: 's' }] })
const valid = {
  impl: impl('impl'),
  fix: impl('fix'),
  review: review('review'),
  're-review': review('re-review'),
  'final-review': review('final-review'),
  'merge-review': review('merge-review'),
  sweep: {
    role: 'sweep',
    verdict: 'FINDINGS',
    findings: [{ introduced: 'a.mjs', existing: 'b.mjs', why: 'dup' }],
    dispositions: [{ requirement: 'R', disposition: 'kept' }]
  },
  investigate: { role: 'investigate', answer: 'yes', evidence: [{ file: 'a.mjs', line: 1 }, { file: 'b.mjs' }] },
  'spec-merge': { role: 'spec-merge', capabilities: [{ name: 'c', added: 1, modified: 0, removed: 2, renamed: 0 }] }
}
const WRONG = [null, true, 0, -1, 1.5, 'x', '', [], {}, [1], { a: 1 }]

// Every mutation of an object value: each key omitted, each key replaced by every wrong value
// (recursing into nested objects and the first element of arrays), and an unknown key added.
function mutations(value) {
  const out = []
  for (const key of Object.keys(value)) {
    const { [key]: _drop, ...rest } = value
    out.push(rest)
    for (const w of WRONG) out.push({ ...value, [key]: w })
    const v = value[key]
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const m of mutations(v)) out.push({ ...value, [key]: m })
    if (Array.isArray(v) && v[0] && typeof v[0] === 'object') {
      for (const m of mutations(v[0])) out.push({ ...value, [key]: [m, ...v.slice(1)] })
      out.push({ ...value, [key]: [...v, ...v] })
    }
  }
  out.push({ ...value, extra: 1 })
  return out
}

// The corpus: [argv builder over the reply file path, file content or undefined].
const corpus = []
const add = (role, content) => corpus.push([(f) => ['--role', role, f], content])
for (const role of Object.keys(ROLES)) {
  const v = valid[role]
  add(role, JSON.stringify(v))
  for (const m of mutations(v)) add(role, JSON.stringify(m))
  for (const other of Object.keys(ROLES)) if (other !== role) add(role, JSON.stringify({ ...v, role: other }))
  add(role, JSON.stringify(valid[Object.keys(ROLES).find((r) => r !== role)]))
  add(role, `{"constructor": 1, "__proto__": 2, ${JSON.stringify(v).slice(1)}`)
  for (const text of ['not json', '', '[]', 'null', '5', '"ok"', '{}', '{"role": 1}']) add(role, text)
}
for (const role of ['impl', 'fix']) {
  const { tests: _t, ...rest } = valid[role]
  for (const status of ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT', 'OK']) add(role, JSON.stringify({ ...rest, status }))
  for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) add(role, JSON.stringify({ ...valid[role], status, tests: { ...valid[role].tests, result: 'fail' } }))
}
for (const role of ['review', 're-review', 'final-review', 'merge-review']) {
  for (const verdict of ['pass', 'fail', 'maybe']) {
    for (const severity of ['critical', 'important', 'minor', 'blocker']) {
      add(role, JSON.stringify({ role, verdict, findings: [{ severity, file: 'a', summary: 's' }] }))
      add(role, JSON.stringify({ role, verdict, findings: [{ severity: 'minor', file: 'b', summary: 's' }, { severity, file: 'a', line: 2, summary: 's' }] }))
    }
    add(role, JSON.stringify({ role, verdict, findings: [] }))
    add(role, JSON.stringify({ role, verdict, findings: [null, 'x'] }))
  }
}
for (const verdict of ['CLEAN', 'FINDINGS', 'clean']) {
  add('sweep', JSON.stringify({ role: 'sweep', verdict, findings: [] }))
  add('sweep', JSON.stringify({ role: 'sweep', verdict, findings: valid.sweep.findings }))
  add('sweep', JSON.stringify({ role: 'sweep', verdict, findings: 'none' }))
}
for (const n of [0, 3, -1, 1.5, '1', null, 1e21, Number.MAX_SAFE_INTEGER + 2])
  add('spec-merge', JSON.stringify({ role: 'spec-merge', capabilities: [{ name: 'c', added: n, modified: 0, removed: 0, renamed: 0 }] }))
add('spec-merge', JSON.stringify({ role: 'spec-merge', capabilities: [] }))
add('investigate', JSON.stringify({ role: 'investigate', answer: 'a', evidence: [{ file: 'a', line: 1e308 }] }))
for (const role of ['nope', 'toString', '__proto__', 'IMPL', 'verify']) add(role, '{}')
corpus.push([(f) => [f], '{}'])
corpus.push([() => ['--role', 'impl'], undefined])
corpus.push([(f) => ['--role'], '{}'])
corpus.push([() => [], undefined])
corpus.push([(f) => [f, '--role', 'impl'], JSON.stringify(valid.impl)])
corpus.push([(f) => ['--role', 'impl', f, 'stray'], JSON.stringify(valid.impl)])
corpus.push([(f) => ['--role', 'impl', `${f}.missing`], undefined])
corpus.push([(f) => ['--role', 'impl', dirname(f)], undefined])

function theirOutcome(proc) {
  if (proc.status === 0) return { code: 0, form: 'silent' }
  if (proc.status === 1) {
    const [head, ...lines] = proc.stderr.trimEnd().split('\n')
    return { code: 1, error: head.replace(/^STOP: /, ''), reasons: lines.map((l) => l.replace(/^ {2}/, '')), form: 'stderr-prose' }
  }
  return { code: proc.status, error: proc.stderr.trim(), form: 'stderr-prose' }
}

function ourOutcome(proc) {
  const out = JSON.parse(proc.stdout)
  if (proc.status === 0 && out.ok === true) return { code: 0, form: 'stdout-json' }
  if (proc.status === 1) return { code: 1, error: out.error, reasons: out.reasons, form: 'stdout-json' }
  return { code: proc.status, error: out.error, form: 'stdout-json' }
}

// The wrong-call usage line names the script and the --root flag; the content compared is
// that both are a usage line.
const usage = (o) => (o.code === 2 && /^usage: /.test(o.error) ? { ...o, error: 'usage' } : o)

const differences = []
let compared = 0
let accepted = 0
for (const [args, content] of corpus) {
  compared++
  const caseDir = mkdtempSync(join(dir, 'case-'))
  const file = join(caseDir, 'reply.json')
  if (content !== undefined) writeFileSync(file, content)
  mkdirSync(join(caseDir, 'sub'))
  const argv = args(file)
  const their = theirOutcome(spawnSync('node', [originScript, ...argv], { cwd: caseDir, encoding: 'utf8' }))
  const ours = ourOutcome(spawnSync('node', [ourScript, ...argv, '--root', caseDir], { cwd: caseDir, encoding: 'utf8' }))
  if (their.code === 0) accepted++
  const { form: theirForm, ...theirContent } = usage(their)
  const { form: ourForm, ...ourContent } = usage(ours)
  const sameContent = JSON.stringify(theirContent) === JSON.stringify(ourContent)
  if (sameContent && theirForm === ourForm) continue
  differences.push({ case: { argv, content }, theirs: their, ours, explained: sameContent ? 'json-output' : null })
}

const unexplained = differences.filter((d) => d.explained === null)
const byReason = {}
for (const d of differences) if (d.explained) byReason[d.explained] = (byReason[d.explained] ?? 0) + 1
console.log(JSON.stringify({ compared, accepted, refused: compared - accepted, differences: differences.length, explained: byReason, unexplained }, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
