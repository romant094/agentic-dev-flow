#!/usr/bin/env node
// Dev tool: compares the reply checker of the port (plugins/adf/scripts/lib/reply.mjs, v2: JSON
// Schema under plugins/adf/schema/, every verdict computed) with the origin's
// .claude/scripts/check-reply.mjs (v1: the agent states the verdict). The origin's script is
// copied to a temporary directory and run there as a child process on each reply file; the reply
// goes through the v1 -> v2 converter (lib/reply-v1.mjs) and the port's checkReply, with the
// context read by replyContext from a git fixture (the change range, the test-run records, the
// events log, the delta). Nothing is written in the origin.
//
//   node scripts/parity/origin-reply.mjs <origin project root>
//
// A generated matrix, per v1 role: the valid reply, then every field omitted, replaced by a value
// of each wrong type, and every nested object mutated the same way; an unknown key at the top
// and in each nested object; the role key missing, wrong and of another role; every enum and
// cross-field rule broken and kept; non-object and non-JSON text. For each case the origin's
// accept or refuse is compared with the port's. Beside it, the wrong calls (no role or name, no
// file, a missing or unreadable file, an unknown role, a stray argument) through both CLIs, the
// exit codes compared.
//
// Every difference must fall in a class of lib/reply-v1.mjs CLASSES (verdict-computed,
// tests-structured, commits-from-git, text-nonempty, line-integer, blocker-required,
// dispositions-checked, role-removed, cli-form): every reason of the refusing side must match the
// class. For a reply both accept, a stated status or verdict the port computes differently is
// counted (status-computed, verdict-computed), not failed. Exit 1 on an unexplained difference.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGE, classify, computedDiffers, makeFixture, NAMES, portCheck, V1_ROLES } from './lib/reply-v1.mjs'

const origin = process.argv[2]
const originSource = origin && join(origin, '.claude', 'scripts', 'check-reply.mjs')
if (!originSource || !existsSync(originSource)) {
  console.error('usage: origin-reply.mjs <origin project root with .claude/scripts/check-reply.mjs>')
  process.exit(2)
}
const ourScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'adf', 'scripts', 'reply.mjs')
// The real path: the origin's script runs only when its own URL is the path it was started as.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-reply-')))
const originScript = join(dir, 'check-reply.mjs')
copyFileSync(originSource, originScript)
const fixture = makeFixture()
// The matrix's valid sweep disposes of R, so the fixture's change removes R.
fixture.removals(['R'])

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

// The matrix: [v1 role, file content].
const corpus = []
const add = (role, content) => corpus.push([role, content])
for (const role of V1_ROLES) {
  const v = valid[role]
  add(role, JSON.stringify(v))
  for (const m of mutations(v)) add(role, JSON.stringify(m))
  for (const other of V1_ROLES) if (other !== role) add(role, JSON.stringify({ ...v, role: other }))
  add(role, JSON.stringify(valid[V1_ROLES.find((r) => r !== role)]))
  add(role, `{"constructor": 1, "__proto__": 2, ${JSON.stringify(v).slice(1)}`)
  for (const text of ['not json', '', '[]', 'null', '5', '"ok"', '{}', '{"role": 1}']) add(role, text)
}
for (const role of ['impl', 'fix']) {
  const { tests: _t, ...rest } = valid[role]
  for (const status of ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT', 'OK']) add(role, JSON.stringify({ ...rest, status }))
  for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) add(role, JSON.stringify({ ...valid[role], status, tests: { ...valid[role].tests, result: 'fail' } }))
}
// The test evidence: a stated result of pass or fail and a summary with a count line, with none,
// or of no test, under each status; a blocked reply with no text for its blocker.
const SUMMARIES = ['3 passed', '# tests 3\n# pass 3\n# fail 0', '# tests 3\n# pass 2\n# fail 1', '# tests 0\n# pass 0\n# fail 0', 'Tests:       4 passed, 4 total']
for (const role of ['impl', 'fix']) {
  for (const status of ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'])
    for (const result of ['pass', 'fail'])
      for (const summary of SUMMARIES) for (const concerns of [[], ['c']]) add(role, JSON.stringify({ ...valid[role], status, concerns, tests: { ...valid[role].tests, result, summary } }))
  for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) for (const report of ['', 'r.md']) add(role, JSON.stringify({ ...valid[role], status, concerns: [], report }))
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

// The wrong calls: [origin argv, port argv, file content or undefined]; f is the reply file.
const port = (name, f) => ['check', '--change', CHANGE, ...(name === undefined ? [] : ['--name', name]), ...(f === undefined ? [] : ['--file', f])]
const calls = []
for (const role of ['nope', 'toString', '__proto__', 'IMPL', 'verify']) calls.push([(f) => ['--role', role, f], (f) => port(role, f), '{}'])
calls.push([(f) => [f], (f) => port(undefined, f), '{}'])
calls.push([() => ['--role', 'impl'], () => port(NAMES.impl), undefined])
calls.push([() => ['--role'], () => ['check', '--change', CHANGE, '--name'], '{}'])
calls.push([() => [], () => [], undefined])
calls.push([(f) => [f, '--role', 'impl'], (f) => ['--file', f, 'check', '--change', CHANGE, '--name', NAMES.impl], JSON.stringify(valid.impl)])
calls.push([(f) => ['--role', 'impl', f, 'stray'], (f) => [...port(NAMES.impl, f), 'stray'], JSON.stringify(valid.impl)])
calls.push([(f) => ['--role', 'impl', `${f}.missing`], (f) => port(NAMES.impl, `${f}.missing`), undefined])
calls.push([(f) => ['--role', 'impl', dirname(f)], (f) => port(NAMES.impl, dirname(f)), undefined])

function theirOutcome(proc) {
  if (proc.status === 0) return { code: 0, accepted: true, reasons: [] }
  const [, ...lines] = proc.stderr.trimEnd().split('\n')
  return { code: proc.status, accepted: false, reasons: proc.status === 1 ? lines.map((l) => l.replace(/^ {2}/, '')) : [proc.stderr.trim()] }
}
const theirs = (argv, cwd) => theirOutcome(spawnSync('node', [originScript, ...argv], { cwd, encoding: 'utf8' }))

const differences = []
const explained = {}
const computed = {}
const count = (map, key) => (map[key] = (map[key] ?? 0) + 1)
let compared = 0
let accepted = 0
let portAccepted = 0
for (const [role, content] of corpus) {
  compared++
  const caseDir = mkdtempSync(join(dir, 'case-'))
  const file = join(caseDir, 'reply.json')
  writeFileSync(file, content)
  const their = theirs(['--role', role, file], caseDir)
  if (their.accepted) accepted++
  const ours = portCheck(role, content, fixture)
  if (!ours.converted) {
    count(explained, ours.class)
    continue
  }
  if (ours.accepted) portAccepted++
  if (their.accepted === ours.accepted) {
    if (their.accepted) for (const c of computedDiffers(role, JSON.parse(content), ours.result)) count(computed, c)
    continue
  }
  const classes = classify(their, ours)
  if (classes === null) differences.push({ role, content, theirs: their.reasons, ours: ours.errors })
  else for (const c of classes) count(explained, c)
}

// A wrong call through both CLIs: the same exit code, or the cli-form class. The origin reads
// the v1 reply, the port the converted one beside it.
for (const [theirArgs, ourArgs, content] of calls) {
  compared++
  const caseDir = mkdtempSync(join(dir, 'case-'))
  mkdirSync(join(caseDir, 'sub'))
  const v1 = join(caseDir, 'sub', 'reply.json')
  const v2 = join(caseDir, 'reply.json')
  if (content !== undefined) {
    writeFileSync(v1, content)
    const value = JSON.parse(content)
    writeFileSync(v2, JSON.stringify(value.role === 'impl' ? portCheck('impl', content, fixture).value : value))
  }
  const their = theirs(theirArgs(content === undefined ? v2 : v1), caseDir)
  if (their.accepted) accepted++
  const argv = ourArgs(v2)
  const run = spawnSync('node', [ourScript, ...argv, '--root', fixture.root], { cwd: caseDir, encoding: 'utf8' })
  if (their.code === run.status) continue
  if (their.code === 0 && run.status === 2 && argv.at(-1) === 'stray') count(explained, 'cli-form')
  else differences.push({ call: argv, theirs: their.code, ours: run.status, out: run.stdout.slice(0, 500) })
}

fixture.remove()
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ compared, accepted, refused: compared - accepted, portAccepted, explained, computed, unexplained: differences }, null, 2))
process.exitCode = differences.length === 0 ? 0 : 1
