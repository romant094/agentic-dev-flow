// lib/metrics-records.mjs over SDD directories written by the real writers: the attempts log
// (recordDispatch, recordReply), the test-run records (runCovering), the review stage
// (review.mjs), the verify run (runChecks) and the ledger (appendRecord); and each source absent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDispatch, recordReply } from '../lib/attempts.mjs'
import { archiveChange } from '../lib/changes.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import {
  FANOUT_RULE,
  readCompliance,
  readFindings,
  readImpl,
  readLedger,
  readReplies,
  readReview,
  readSddRecords,
  readTests,
  readVerify,
  removalCandidates,
  SEVERITY_MAP
} from '../lib/metrics-records.mjs'
import { runCovering } from '../lib/suite.mjs'
import { runChecks } from '../lib/verify.mjs'
import { run as review } from '../review.mjs'
import { commitIn, git, host } from './git-host.mjs'

const CHANGE = 'add-x'
const sdd = (root, file) => join(root, '.superpowers', 'sdd', CHANGE, file)
const graph = (rows) => `# Plan\n\n## Execution Graph\n\n| Group | Tasks | Wave |\n|---|---|---|\n${rows.map(([g, t, w]) => `| ${g} | ${t} | ${w} |`).join('\n')}\n\n### Task 1: A\n\n**Level:** mechanical\n`
const PLAN = graph([
  ['A', '1', '1'],
  ['B', '2', '1'],
  ['C', '3', '2']
])

let tick = 0
const at = () => `2026-10-19T10:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`
const dispatch = (root, name) => recordDispatch(root, CHANGE, name, { now: at() })
const valid = (root, name, result) => recordReply(root, CHANGE, { name, file: `replies/${name}.json`, result, now: at() })
const invalid = (root, name) => recordReply(root, CHANGE, { name, file: `replies/${name}.json`, errors: ['$.role: required'], now: at() })
const finding = (severity) => ({ id: 'F1', severity, kind: 'quality', category: 'quality', file: 'a.txt', line: 1, title: 't', body: 'b' })

// The apply log of a change with two wave-1 groups, both merge-reviewed.
function applyLog(root, { merged = ['A', 'B'] } = {}) {
  dispatch(root, 'T1 impl')
  valid(root, 'T1 impl', { status: 'DONE' })
  dispatch(root, 'T2 impl')
  invalid(root, 'T2 impl')
  dispatch(root, 'T2 impl')
  valid(root, 'T2 impl', { status: 'DONE_WITH_CONCERNS' })
  dispatch(root, 'T3 impl')
  invalid(root, 'T3 impl')
  dispatch(root, 'T3 impl')
  invalid(root, 'T3 impl')
  dispatch(root, 'T1 review')
  valid(root, 'T1 review', { findings: [finding('critical'), finding('minor'), finding('minor')] })
  dispatch(root, 'T1 review r1')
  invalid(root, 'T1 review r1')
  for (const g of merged) {
    dispatch(root, `merge-review ${g}`)
    valid(root, `merge-review ${g}`, { findings: g === 'A' ? [finding('important')] : [] })
  }
  dispatch(root, 'final-review')
  valid(root, 'final-review', { findings: [] })
  for (const name of ['sweep p1', 'sweep p2']) {
    dispatch(root, name)
    valid(root, name, { verdict: 'FINDINGS', findings: [{ introduced: 'x', existing: 'y', why: 'z' }], dropped: [] })
  }
  dispatch(root, 'investigate flaky')
  valid(root, 'investigate flaky', undefined)
}

test('the severity map puts the Superpowers scale on the review stage scale', () => {
  assert.deepEqual(SEVERITY_MAP, { critical: 'CRITICAL', important: 'HIGH', minor: 'MEDIUM' })
})

test('every reader gives null and a reason when its source is absent, never 0', () => {
  const { change } = host()
  const readers = { readReplies, readImpl, readFindings, readCompliance, readTests, readReview, readVerify, readLedger }
  for (const [name, read] of Object.entries(readers)) {
    const got = read(change, CHANGE)
    assert.equal(got.value, null, name)
    assert.equal(typeof got.reason, 'string', name)
    assert.ok(got.reason.length > 0, name)
  }
  assert.match(readReplies(change, CHANGE).reason, /no \.superpowers\/sdd\/add-x\/attempts\.jsonl/)
  assert.match(readCompliance(change, CHANGE).reason, /no openspec\/changes\/add-x\/plan\.md/)
  assert.match(readTests(change, CHANGE).reason, /tests\//)
  assert.match(readReview(change, CHANGE).reason, /did not start/)
  assert.match(readVerify(change, CHANGE).reason, /verify\/run\.json/)
  assert.match(readLedger(change, CHANGE).reason, /ledger\.jsonl/)
  const all = readSddRecords(change, CHANGE)
  for (const group of ['replies', 'impl', 'findings', 'compliance', 'tests', 'review', 'verify', 'ledger']) {
    assert.equal(all[group], null, group)
    assert.ok(all.coverage[group].none, group)
  }
  assert.deepEqual(all.isolation, { filesOutsidePlan: null })
})

test('replies, impl statuses and findings per layer from the attempts log', () => {
  const { change } = host({ 'plan.md': PLAN })
  applyLog(change)
  const replies = readReplies(change, CHANGE).value
  assert.deepEqual(replies.impl, { dispatches: 5, valid: 2, invalid: 3, retries: 2, stops: 1 })
  assert.deepEqual(replies.review, { dispatches: 2, valid: 1, invalid: 1, retries: 1, stops: 0 })
  assert.deepEqual(replies['merge-review'], { dispatches: 2, valid: 2, invalid: 0, retries: 0, stops: 0 })
  assert.deepEqual(replies.investigate, { dispatches: 1, valid: 1, invalid: 0, retries: 0, stops: 0 })

  assert.deepEqual(readImpl(change, CHANGE).value, { DONE: 1, DONE_WITH_CONCERNS: 1, BLOCKED: 0, NEEDS_CONTEXT: 0 })

  const findings = readFindings(change, CHANGE).value
  assert.deepEqual(findings.review, { dispatches: 1, findings: 3, native: { critical: 1, minor: 2 }, mapped: { CRITICAL: 1, HIGH: 0, MEDIUM: 2, LOW: 0 } })
  assert.deepEqual(findings['merge-review'], { dispatches: 2, findings: 1, native: { important: 1 }, mapped: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 } })
  assert.deepEqual(findings['final-review'], { dispatches: 1, findings: 0, native: {}, mapped: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } })
  assert.deepEqual(findings.sweep, { dispatches: 2, findings: 2, native: {}, mapped: null }, 'the sweep is counted per pass, never mapped')
  assert.equal(findings['re-review'], undefined, 'a layer with no accepted reply has no entry')
  assert.equal(findings['ai-review'], undefined)
  assert.equal(findings.investigate, undefined)
})

test('impl is null when the log holds no accepted impl reply', () => {
  const { change } = host()
  dispatch(change, 'T1 impl')
  invalid(change, 'T1 impl')
  assert.deepEqual(readImpl(change, CHANGE), { value: null, reason: 'no accepted impl reply in attempts.jsonl' })
  assert.deepEqual(readFindings(change, CHANGE).value, {})
})

test('wave-1 fan-out: required from the plan groups, performed from the group dispatch names', () => {
  const both = host({ 'plan.md': PLAN }).change
  applyLog(both)
  assert.deepEqual(readCompliance(both, CHANGE).value, [{ rule: FANOUT_RULE, required: ['A', 'B'], performed: ['A', 'B'] }])

  const one = host({ 'plan.md': PLAN }).change
  applyLog(one, { merged: ['A'] })
  assert.deepEqual(readCompliance(one, CHANGE).value, [{ rule: FANOUT_RULE, required: ['A', 'B'], performed: ['A'] }])

  const single = host({
    'plan.md': graph([
      ['A', '1', '1'],
      ['B', '2', '2']
    ])
  }).change
  applyLog(single, { merged: [] })
  assert.deepEqual(readCompliance(single, CHANGE).value, [{ rule: FANOUT_RULE, required: [], performed: [] }], 'one wave-1 group has nothing to fan out')

  const noGraph = host({ 'plan.md': '# Plan\n' }).change
  assert.match(readCompliance(noGraph, CHANGE).reason, /no Execution Graph/)
  const noLog = host({ 'plan.md': PLAN }).change
  assert.match(readCompliance(noLog, CHANGE).reason, /attempts\.jsonl/)
})

test('test runs from the suite records: runs, failed, uncounted, and a file that is no record', () => {
  const { change } = host()
  const runner = (name, command, now) => runCovering(change, { change: CHANGE, name, command, worktree: change, now })
  runner('T1 impl', 'printf "# tests 2\\n# pass 2\\n# fail 0\\n"', '2026-10-19T10:00:00.000Z')
  runner('T1 impl', 'printf "# tests 2\\n# pass 1\\n# fail 1\\n"', '2026-10-19T10:01:00.000Z')
  runner('T2 impl', 'exit 3', '2026-10-19T10:02:00.000Z')
  runner('T3 impl', 'true', '2026-10-19T10:03:00.000Z')
  writeFileSync(sdd(change, 'tests/junk.json'), '{"not":"a record"}\n')
  assert.deepEqual(readTests(change, CHANGE).value, { runs: 4, failed: 2, uncounted: 2, unreadable: ['junk.json'] })
})

test('review state: verdict from the assembled record, rounds, dispositions; ai-review from findings.json; after the move too', () => {
  const { change } = host()
  commitIn(change, 'openspec/planning.md', '# Planning\n\n## Whole-suite command\n\ntrue\n')
  commitIn(change, 'src/a.ts', 'line1\nline2\nline3\n')
  const prompt = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-mr-prompt-'))), 'prompt.md')
  writeFileSync(prompt, 'Look for bugs.\n')
  const R = (...args) => review([...args, '--root', change], { cwd: change })
  const replyFile = (name, value) => {
    const file = sdd(change, `replies/${name}.json`)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  assert.equal(R('start', '--change', CHANGE).ok, true)
  assert.deepEqual(readReview(change, CHANGE).value, { verdict: null, rounds: 0, dispositions: {}, stopped: false })
  R('round', '--change', CHANGE)
  R('input', '--round', '1', '--change', CHANGE, '--prompt', prompt)
  assert.equal(R('response', '--change', CHANGE, '--round', '1', '--file', replyFile('ai-review-r1', 'no JSON here')).retry, true)
  const f = (id, severity, line) => ({ id, severity, category: 'Bugs', file: 'src/a.ts', line, title: `t ${id}`, body: `b ${id}` })
  const stored = R('response', '--change', CHANGE, '--round', '1', '--file', replyFile('ai-review-r1-2', { summary: 'Reviewed.', findings: [f('F1', 'MEDIUM', 2), f('F2', 'LOW', 3)] }))
  assert.equal(stored.complete, true, stored.error)
  const why = sdd(change, 'why.txt')
  for (const id of ['F1', 'F2']) {
    writeFileSync(why, 'Left for a later change.\n')
    assert.equal(R('disposition', '--change', CHANGE, '--finding', id, '--as', 'recorded', '--body-file', why).ok, true)
  }
  const record = R('assemble', '--change', CHANGE)
  assert.equal(record.verdict, 'PASS', record.error)

  assert.deepEqual(readReview(change, CHANGE).value, { verdict: 'PASS', rounds: 1, dispositions: { recorded: 2 }, stopped: false })
  const findings = readFindings(change, CHANGE).value
  assert.deepEqual(findings['ai-review'], { dispatches: 1, findings: 2, native: { MEDIUM: 1, LOW: 1 }, mapped: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 1 } })
  assert.deepEqual(readReplies(change, CHANGE).value['ai-review'], { dispatches: 0, valid: 1, invalid: 1, retries: 1, stops: 0 })
  // Archive builds the record after the move: plan.md and review.md are read from the archive.
  writeFileSync(join(change, 'openspec', 'changes', CHANGE, 'plan.md'), PLAN)
  applyLog(change)
  archiveChange(change, CHANGE, { now: new Date('2026-10-19T12:00:00Z') })
  const moved = readSddRecords(change, CHANGE)
  assert.equal(moved.review.verdict, 'PASS')
  assert.deepEqual(moved.compliance, [{ rule: FANOUT_RULE, required: ['A', 'B'], performed: ['A', 'B'] }])
})

test('verify run: each check verdict, a ruled failure, the files outside the plan', () => {
  const { change } = host({ 'plan.md': '# Plan\n\n### Task 1: A\n\n**Files:**\n- Create: `src/a.mjs`\n' })
  commitIn(change, 'src/a.mjs', 'a\n')
  commitIn(change, 'src/stray.mjs', 'b\n')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'adf-mr-home-')))
  const run = runChecks(change, { change: CHANGE, now: 'T', env: {}, home })
  assert.equal(run.checks.find((c) => c.id === 'out-of-plan').verdict, 'fail')

  let got = readVerify(change, CHANGE).value
  assert.equal(got.verdict, null, 'no verdict while the c4 and c8 sections are missing')
  assert.equal(got.checks['out-of-plan'], 'fail')
  assert.deepEqual(Object.keys(got.checks).sort(), ['deltas', 'out-of-plan', 'specs-base', 'tasks', 'test-record', 'tree', 'validation', 'worktrees'])
  assert.deepEqual(got.filesOutsidePlan, ['src/stray.mjs'])
  assert.ok(Array.isArray(got.warnings))

  appendRecord(change, CHANGE, 'ruling', { check: 'out-of-plan', reason: 'the stray file is the fixture' }, { env: {} })
  got = readVerify(change, CHANGE).value
  assert.equal(got.checks['out-of-plan'], 'ruled')
  assert.deepEqual(readSddRecords(change, CHANGE).isolation, { filesOutsidePlan: ['src/stray.mjs'] })

  rmSync(sdd(change, 'verify/out-of-plan.txt'))
  assert.equal(readVerify(change, CHANGE).value.filesOutsidePlan, null, 'unknown, never empty, when the output is gone')
})

test('ledger: counts per kind, unresolved debt, deviations, handoffs, rulings, sessions', () => {
  const { change } = host()
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-1' }
  appendRecord(change, CHANGE, 'session', { phase: 'apply' }, { env, now: '2026-10-19T10:00:00.000Z' })
  appendRecord(change, CHANGE, 'deviation', { rule: 'fan-out', reason: 'one slot', task: '2' }, { env })
  appendRecord(change, CHANGE, 'debt', { what: 'w1', reason: 'r1' }, { env })
  appendRecord(change, CHANGE, 'debt', { what: 'w2', reason: 'r2', task: '3' }, { env })
  appendRecord(change, CHANGE, 'resolve', { debt: 'debt-1', as: 'tech-debt', where: 'x' }, { env })
  appendRecord(change, CHANGE, 'handoff', { merged: 'A', remaining: 'B', next: 'T2' }, { env })
  appendRecord(change, CHANGE, 'ruling', { finding: 'F1', decision: 'keep' }, { env })
  const got = readLedger(change, CHANGE).value
  assert.deepEqual(got.counts, { session: 1, deviation: 1, debt: 2, resolve: 1, handoff: 1, ruling: 1 })
  assert.deepEqual(got.unresolvedDebt, [{ id: 'debt-2', what: 'w2', reason: 'r2', task: '3' }])
  assert.deepEqual(got.deviations, [{ id: 'deviation-1', rule: 'fan-out', reason: 'one slot', task: '2' }])
  assert.equal(got.handoffs, 1)
  assert.equal(got.rulings, 1)
  assert.deepEqual(got.sessions, [{ id: 'session-1', sessionId: 'sess-1', phase: 'apply', at: '2026-10-19T10:00:00.000Z' }])

  writeFileSync(sdd(change, 'ledger.jsonl'), 'not json\n')
  const bad = readLedger(change, CHANGE)
  assert.equal(bad.value, null)
  assert.match(bad.reason, /does not parse/)
})

test('readSddRecords names the coverage of each group', () => {
  const { change } = host({ 'plan.md': PLAN })
  applyLog(change)
  appendRecord(change, CHANGE, 'session', { phase: 'apply' }, { env: { CLAUDE_CODE_SESSION_ID: 's' } })
  const all = readSddRecords(change, CHANGE)
  for (const group of ['replies', 'impl', 'findings', 'compliance', 'ledger']) assert.equal(all.coverage[group], 'record', group)
  for (const group of ['tests', 'review', 'verify']) assert.ok(all.coverage[group].none, group)
  assert.equal(all.impl.DONE, 1)
  assert.equal(git(change, 'status', '--porcelain', '--untracked-files=no'), '', 'the readers write nothing')
})

test('removal candidates: quiet for three changes, a change without the layer or the check skipped', () => {
  const rec = (generatedAt, findings, verify) => ({ generatedAt, findings, verify })
  const layer = (n) => ({ dispatches: 1, findings: n, native: {}, mapped: null })
  const records = [
    rec('2026-10-01', { review: layer(2), sweep: layer(0), 'final-review': layer(0) }, { tasks: 'pass', 'out-of-plan': 'pass', deltas: 'pass' }),
    rec('2026-10-04', { review: layer(0), sweep: layer(3), 'final-review': layer(0) }, { tasks: 'pass', 'out-of-plan': 'fail', deltas: 'not-run' }),
    rec('2026-10-02', { review: layer(0), 'final-review': layer(0) }, { tasks: 'pass', deltas: 'pass' }),
    rec('2026-10-03', { review: layer(0), sweep: layer(0) }, { checks: { tasks: 'pass', 'out-of-plan': 'pass', deltas: 'pass' } }),
    rec('2026-10-05', { review: layer(0), sweep: layer(0) }, null)
  ]
  // Newest first: 10-05, 10-04, 10-03, 10-02, 10-01.
  assert.deepEqual(removalCandidates(records), { layers: ['review', 'final-review'], checks: ['deltas', 'tasks'] })
  assert.deepEqual(removalCandidates(records.slice(0, 2)), { layers: [], checks: [] })
  assert.deepEqual(removalCandidates([]), { layers: [], checks: [] })
})
