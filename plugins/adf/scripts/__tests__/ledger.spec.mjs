import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendRecord,
  buildRecord,
  ledgerPath,
  listRecords,
  parseFlags,
  readLedger,
  skillEditShas,
  unresolvedDebt
} from '../lib/ledger.mjs'
import { run } from '../ledger.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'ledger.mjs')
const host = () => mkdtempSync(join(tmpdir(), 'adf-ledger-'))
const now = '2026-10-01T10:00:00Z'

test('records a deviation with its rule and reason, numbered within its kind', () => {
  const r = buildRecord('deviation', { rule: 'wave-1 fan-out', reason: 'groups share a migration', task: '3' }, { now })
  assert.deepEqual(r, {
    id: 'deviation-1',
    kind: 'deviation',
    at: now,
    rule: 'wave-1 fan-out',
    reason: 'groups share a migration',
    task: '3'
  })
  const second = buildRecord('deviation', { rule: 'a', reason: 'b' }, { existing: [r, { id: 'debt-1', kind: 'debt' }], now })
  assert.equal(second.id, 'deviation-2')
})

test('refuses a record missing a field its kind requires, naming the field', () => {
  assert.throws(() => buildRecord('debt', { what: 'stubbed retry' }), /debt needs --reason/)
  assert.throws(() => buildRecord('deviation', { rule: 'x', reason: '   ' }), /needs --reason/)
})

test('refuses a field its kind does not take, instead of keeping prose it cannot place', () => {
  assert.throws(() => buildRecord('debt', { what: 'a', reason: 'b', note: 'c' }), /debt takes no --note; it takes --what, --reason, --task, --accepted/)
})

test('a ruling on a review finding names what the developer decided, dismissed or accepted', () => {
  const r = buildRecord('ruling', { finding: 'F3', as: 'dismissed', decision: 'the value is a constant' }, { now })
  assert.deepEqual([r.id, r.finding, r.as], ['ruling-1', 'F3', 'dismissed'])
  assert.throws(() => buildRecord('ruling', { finding: 'F3', as: 'fixed', decision: 'd' }), /--as must be one of: dismissed, accepted/)
  assert.throws(() => buildRecord('ruling', { check: 'review-slices', reason: 'r', as: 'accepted' }), /ruling takes no --as; it takes --check, --reason/)
  assert.throws(() => buildRecord('ruling', { finding: 'F3', decision: 'd', note: 'x' }), /ruling takes no --note; it takes --finding, --decision, --task/)
  assert.equal(buildRecord('ruling', { check: 'review-round-4', reason: 'one more' }).check, 'review-round-4')
})

test('refuses an unknown kind and a task that is not a task number', () => {
  assert.throws(() => buildRecord('dispatch', {}), /unknown kind "dispatch"; one of: session, deviation, debt, ruling, handoff, resolve/)
  assert.throws(
    () => buildRecord('debt', { what: 'a', reason: 'b', task: 'Task three' }),
    /--task must be a task number/
  )
  assert.throws(() => buildRecord('debt', { what: 'a', reason: 'b', task: '1.2.3' }), /--task must be a task number/)
  assert.equal(buildRecord('debt', { what: 'a', reason: 'b', task: '2.10' }, { now }).task, '2.10')
})

test('takes the session id from the environment, never from the caller', () => {
  assert.throws(() => buildRecord('session', { phase: 'apply' }), /CLAUDE_CODE_SESSION_ID/)
  assert.throws(() => buildRecord('session', { phase: 'apply', sessionId: 'typed' }, { sessionId: 'abc' }), /session takes no --sessionId/)
  const r = buildRecord('session', { phase: 'apply' }, { sessionId: 'abc', now })
  assert.equal(r.sessionId, 'abc')
  assert.equal(buildRecord('debt', { what: 'a', reason: 'b' }, { sessionId: 'abc', now }).sessionId, 'abc')
})

test('resolves only a debt record that exists, to one of the named destinations', () => {
  const debt = buildRecord('debt', { what: 'a', reason: 'b' }, { now })
  assert.throws(
    () => buildRecord('resolve', { debt: 'debt-9', as: 'tech-debt', where: 'x' }, { existing: [debt] }),
    /no debt record/
  )
  assert.throws(
    () => buildRecord('resolve', { debt: 'debt-1', as: 'later', where: 'x' }, { existing: [debt] }),
    /--as must be one of: tech-debt, flow-debt, follow-up, accepted/
  )
  const resolve = buildRecord(
    'resolve',
    { debt: 'debt-1', as: 'tech-debt', where: 'tracker/T-12' },
    { existing: [debt], now }
  )
  assert.deepEqual(unresolvedDebt([debt, resolve]), [])
  assert.deepEqual(unresolvedDebt([debt]), [debt])
})

test('reads the ledger back line by line', () => {
  const text = `${JSON.stringify({ id: 'debt-1', kind: 'debt' })}\n\n${JSON.stringify({ id: 'session-1', kind: 'session' })}\n`
  assert.deepEqual(
    readLedger(text).map((r) => r.id),
    ['debt-1', 'session-1']
  )
  assert.throws(() => readLedger('not json\n'), SyntaxError)
})

test('parses --field value pairs and refuses a bare word or a flag without a value', () => {
  assert.deepEqual(parseFlags(['--what', 'a', '--reason', 'b']), { what: 'a', reason: 'b' })
  assert.throws(() => parseFlags(['what']), /unexpected argument "what"/)
  assert.throws(() => parseFlags(['--what']), /--what needs a value/)
  assert.throws(() => parseFlags(['--what', '--reason', 'b']), /--what needs a value/)
})

test('appends to .superpowers/sdd/<change>/ledger.jsonl under the root and lists it back', () => {
  const root = host()
  const { record, path } = appendRecord(root, 'add-thing', 'debt', { what: 'a', reason: 'b' }, { env: {}, now })
  assert.equal(path, join(root, '.superpowers', 'sdd', 'add-thing', 'ledger.jsonl'))
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(record)}\n`)
  assert.deepEqual(listRecords(root, 'add-thing'), [record])
  assert.deepEqual(listRecords(root, 'other'), [])
  appendRecord(root, 'add-thing', 'resolve', { debt: 'debt-1', as: 'accepted', where: 'review' }, { env: {}, now })
  assert.deepEqual(listRecords(root, 'add-thing', { unresolvedOnly: true }), [])
  assert.equal(listRecords(root, 'add-thing').length, 2)
})

test('a refused record leaves the ledger untouched', () => {
  const root = host()
  assert.throws(() => appendRecord(root, 'c', 'debt', { what: 'a' }, { env: {} }), /debt needs --reason/)
  assert.equal(existsSync(ledgerPath(root, 'c')), false)
})

test('run refuses a missing kind, a missing --change, and reads the session id from env', () => {
  const root = host()
  assert.throws(() => run([], { env: {} }), /a kind is required/)
  assert.throws(() => run(['debt', '--what', 'a', '--reason', 'b', '--root', root], { env: {} }), /--change is required/)
  assert.throws(() => run(['session', '--change', 'c', '--phase', 'apply', '--root', root], { env: {} }), /CLAUDE_CODE_SESSION_ID/)
  const out = run(['session', '--change', 'c', '--phase', 'apply', '--root', root], { env: { CLAUDE_CODE_SESSION_ID: 's1' } })
  assert.equal(out.record.sessionId, 's1')
  assert.equal(run(['list', '--change', 'c', '--repo', root], { env: {} }).records.length, 1)
  assert.deepEqual(run(['list', '--change', 'c'], { env: {}, cwd: root }).records.map((r) => r.id), ['session-1'])
})

test('the CLI prints JSON and exits 1 on a refusal', () => {
  const root = host()
  const call = (...args) => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }
  const ok = call('debt', '--change', 'c', '--what', 'a', '--reason', 'b', '--task', '2')
  assert.equal(ok.code, 0)
  assert.equal(ok.out.ok, true)
  assert.equal(ok.out.record.id, 'debt-1')
  assert.deepEqual(call('list', '--change', 'c', '--unresolved-debt').out.records.map((r) => r.id), ['debt-1'])
  for (const [args, reason] of [
    [['dispatch', '--change', 'c'], /unknown kind/],
    [['debt', '--change', 'c', '--what', 'a'], /debt needs --reason/],
    [['debt', '--change', 'c', '--what', 'a', '--reason', 'b', '--note', 'n'], /takes no --note/],
    [['debt', '--change', 'c', '--what', 'a', '--reason', 'b', '--task', 'three'], /--task must be a task number/],
    [['session', '--change', 'c', '--phase', 'apply'], /CLAUDE_CODE_SESSION_ID/],
    [['resolve', '--change', 'c', '--debt', 'debt-1', '--as', 'later', '--where', 'x'], /--as must be one of/],
    [['resolve', '--change', 'c', '--debt', 'debt-7', '--as', 'accepted', '--where', 'x'], /no debt record "debt-7"/],
    [['debt', 'stray', '--change', 'c'], /unexpected argument "stray"/],
    [['debt', '--what'], /--what needs a value/],
    [['debt', '--what', 'a', '--reason', 'b'], /--change is required/]
  ]) {
    const refused = call(...args)
    assert.equal(refused.code, 1, args.join(' '))
    assert.equal(refused.out.ok, false)
    assert.match(refused.out.error, reason)
    assert.match(refused.out.usage, /^Usage:/)
  }
  assert.equal(readLedger(readFileSync(ledgerPath(root, 'c'), 'utf8')).length, 1)
})

test('a malformed ledger line is refused, not skipped', () => {
  const root = host()
  mkdirSync(dirname(ledgerPath(root, 'c')), { recursive: true })
  writeFileSync(ledgerPath(root, 'c'), 'not json\n')
  assert.throws(() => run(['list', '--change', 'c', '--root', root], { env: {} }), SyntaxError)
})

test('a skill-edit record carries a commit sha and lists back for verify', () => {
  const root = host()
  const { record } = appendRecord(root, 'c', 'skill-edit', { sha: 'abc1234', message: 'docs(skills): x' }, { env: {}, now })
  assert.deepEqual(record, { id: 'skill-edit-1', kind: 'skill-edit', at: now, sha: 'abc1234', message: 'docs(skills): x' })
  assert.deepEqual(skillEditShas(listRecords(root, 'c')), ['abc1234'])
  assert.throws(() => buildRecord('skill-edit', {}), /skill-edit needs --sha/)
  assert.throws(() => buildRecord('skill-edit', { sha: 'abc1234', reason: 'r' }), /skill-edit takes no --reason/)
})
