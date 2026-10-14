import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkReplyText, ROLES, validateReply } from '../lib/reply.mjs'
import { run as runCli, UsageError } from '../reply.mjs'

const SCRIPT = new URL('../reply.mjs', import.meta.url).pathname

const impl = (role) => ({
  role,
  status: 'DONE',
  commits: [{ sha: 'abc1234', subject: 'feat: x' }],
  tests: { command: 'node --test', result: 'pass', summary: '3 passed' },
  concerns: [],
  report: '/tmp/r.md'
})
const review = (role) => ({
  role,
  verdict: 'pass',
  findings: [{ severity: 'minor', file: 'a.mjs', line: 3, summary: 's' }]
})

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
  'spec-merge': { role: 'spec-merge', capabilities: [{ name: 'c', added: 1, modified: 0, removed: 0, renamed: 0 }] }
}

test('the table names every role', () => {
  assert.deepEqual(Object.keys(ROLES).sort(), Object.keys(valid).sort())
})

for (const [role, reply] of Object.entries(valid)) {
  test(`a valid ${role} reply is accepted (catches an over-strict table)`, () => {
    assert.deepEqual(validateReply(role, reply), [])
  })
}

test('a missing required field is refused with the field named', () => {
  const { report, ...rest } = valid.impl
  assert.ok(validateReply('impl', rest).some((r) => r.includes('report')))
})

test('a wrong type is refused with the field named', () => {
  assert.ok(validateReply('impl', { ...valid.impl, concerns: 'none' }).some((r) => r.includes('concerns')))
  assert.ok(
    validateReply('spec-merge', {
      role: 'spec-merge',
      capabilities: [{ name: 'c', added: -1, modified: 0, removed: 0, renamed: 0 }]
    }).some((r) => r.includes('added'))
  )
})

test('an out-of-enum value is refused with the field named', () => {
  assert.ok(validateReply('impl', { ...valid.impl, status: 'OK' }).some((r) => r.includes('status')))
  assert.ok(validateReply('review', { ...valid.review, verdict: 'maybe' }).some((r) => r.includes('verdict')))
})

test('an unknown field is refused with the field named', () => {
  assert.ok(validateReply('impl', { ...valid.impl, extra: 1 }).some((r) => r.includes('extra')))
})

test('an inherited key name such as constructor is refused as unknown', () => {
  const reply = JSON.parse('{"constructor": 1, "__proto__": 2}')
  const out = validateReply('impl', { ...valid.impl, ...reply })
  assert.ok(out.some((r) => r.includes('constructor is not a known field')))
  assert.ok(out.some((r) => r.includes('__proto__ is not a known field')))
})

test('tests may be absent only for BLOCKED and NEEDS_CONTEXT', () => {
  const { tests, ...rest } = valid.impl
  assert.ok(validateReply('impl', { ...rest, status: 'DONE' }).some((r) => r.includes('tests')))
  assert.deepEqual(validateReply('impl', { ...rest, status: 'BLOCKED' }), [])
  assert.deepEqual(validateReply('fix', { ...rest, role: 'fix', status: 'NEEDS_CONTEXT' }), [])
})

test('review pass with an important or critical finding is refused (catches the missing cross-field rule)', () => {
  for (const severity of ['important', 'critical']) {
    const r = { ...valid.review, findings: [{ severity, file: 'a', summary: 's' }] }
    assert.ok(validateReply('review', r).length > 0)
  }
  assert.deepEqual(
    validateReply('review', {
      ...valid.review,
      verdict: 'fail',
      findings: [{ severity: 'critical', file: 'a', summary: 's' }]
    }),
    []
  )
})

test('sweep CLEAN with a finding and FINDINGS with none are refused', () => {
  assert.ok(validateReply('sweep', { role: 'sweep', verdict: 'CLEAN', findings: valid.sweep.findings }).length > 0)
  assert.ok(validateReply('sweep', { role: 'sweep', verdict: 'FINDINGS', findings: [] }).length > 0)
  assert.deepEqual(validateReply('sweep', { role: 'sweep', verdict: 'CLEAN', findings: [] }), [])
})

test('a role mismatch is refused', () => {
  assert.ok(validateReply('impl', { ...valid.impl, role: 'fix' }).some((r) => r.includes('role')))
})

test('a non-object is refused without throwing', () => {
  for (const v of [[], 'ok', null, 5, undefined]) assert.ok(validateReply('impl', v).length > 0)
})

test('an unknown role is refused without throwing', () => {
  assert.ok(validateReply('nope', {}).length > 0)
})

test('reply text that is not JSON is refused with one reason', () => {
  assert.deepEqual(checkReplyText('impl', 'not json'), ['file is not valid JSON'])
  assert.deepEqual(checkReplyText('impl', ''), ['file is not valid JSON'])
  assert.deepEqual(checkReplyText('impl', JSON.stringify(valid.impl)), [])
})

const host = () => mkdtempSync(join(tmpdir(), 'adf-reply-'))

test('run reads a relative file from --root, or from cwd without it', () => {
  const root = host()
  writeFileSync(join(root, 'reply.json'), JSON.stringify(valid.sweep))
  assert.deepEqual(runCli(['--role', 'sweep', 'reply.json', '--root', root]), { ok: true, role: 'sweep', file: 'reply.json' })
  assert.equal(runCli(['--role', 'sweep', 'reply.json'], { cwd: root }).ok, true)
})

test('run returns the reasons of a refused reply and throws UsageError on a wrong call', () => {
  const root = host()
  writeFileSync(join(root, 'reply.json'), JSON.stringify({ ...valid.investigate, extra: 1 }))
  const out = runCli(['--role', 'investigate', 'reply.json', '--root', root])
  assert.equal(out.ok, false)
  assert.equal(out.error, 'reply.json is not a valid investigate reply')
  assert.deepEqual(out.reasons, ['extra is not a known field'])
  assert.throws(() => runCli(['reply.json', '--root', root]), UsageError)
  assert.throws(() => runCli(['--role', 'nope', 'reply.json', '--root', root]), /unknown role nope; known: impl/)
  assert.throws(() => runCli(['--role', 'impl', 'missing.json', '--root', root]), /cannot read missing\.json/)
})

const run = (args, content) => {
  const dir = host()
  const file = join(dir, 'reply.json')
  if (content !== undefined) writeFileSync(file, content)
  return spawnSync(process.execPath, [SCRIPT, ...args(file)], { encoding: 'utf8' })
}

test('the CLI exits 0 on a valid file and prints one JSON object', () => {
  const r = run((f) => ['--role', 'impl', f], JSON.stringify(valid.impl))
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).ok, true)
})

test('the CLI exits 1 on an invalid file, naming the file, the role and each reason', () => {
  const r = run((f) => ['--role', 'impl', f], JSON.stringify({ ...valid.impl, extra: 1 }))
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.match(out.error, /reply\.json is not a valid impl reply$/)
  assert.deepEqual(out.reasons, ['extra is not a known field'])
})

test('the CLI exits 1 on a non-JSON file', () => {
  const r = run((f) => ['--role', 'impl', f], 'not json')
  assert.equal(r.status, 1)
  assert.deepEqual(JSON.parse(r.stdout).reasons, ['file is not valid JSON'])
})

test('the CLI exits 2 on an unknown role, a missing flag and an unreadable file', () => {
  for (const r of [
    run((f) => ['--role', 'nope', f], '{}'),
    run((f) => [f], '{}'),
    run((f) => ['--role', 'impl', `${f}.missing`])
  ]) {
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stdout).ok, false)
  }
})
