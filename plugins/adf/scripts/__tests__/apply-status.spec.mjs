// apply-status.mjs: where apply stands, from the graph, git, the ticks, the ledger and the record.
import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { blockedNames, pushLine, suiteOf } from '../lib/apply-status.mjs'
import { addGroup, finishGroup, mergeGroup } from '../lib/groups.mjs'
import { recordReply } from '../lib/attempts.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { commitTick, tickTask } from '../lib/tasks.mjs'
import { run } from '../apply-status.mjs'
import { commitIn, git, host } from './git-host.mjs'

const task = (n, item) =>
  [`### Task ${n}: task ${n}`, '', `> Implements \`tasks.md\` ${item}.`, '', '**Files:**', `- Modify: \`src/t${n}.ts\``, '', '**Level:** integration', '', '---', ''].join('\n')
const GRAPH = [
  '## Execution Graph',
  '',
  '| Group | Tasks | Files | Wave |',
  '|---|---|---|---|',
  '| A | 1 | `src/t1.ts` | 1 |',
  '| B | 2 | `src/t2.ts` | 1 |',
  '| C | 3 | `src/t3.ts` | 2 |',
  '',
  '| Group A | Group B | Coupling | Reasoning (required if medium) |',
  '|---|---|---|---|',
  '',
  'Group C (wave 2) depends on: Group B.',
  '',
  '---',
  ''
].join('\n')
const PLAN = `# Plan\n\n${GRAPH}\n${[task(1, '1.1'), task(2, '1.2'), task(3, '2.1')].join('\n')}`
const TASKS = '## 1. One\n\n- [ ] 1.1 first\n- [ ] 1.2 second\n\n## 2. Two\n\n- [ ] 2.1 third\n'
const env = { CLAUDE_CODE_SESSION_ID: 's1' }
const core = { coreContract: '1.2', points: { forge: { operations: ['push'] }, teardown: { kind: 'hook', operations: ['teardown'] } } }

function tick(change, item) {
  tickTask(change, 'add-x', item)
  commitTick(change, 'add-x', item)
}

test('a merged group, a blocked one and the wave-2 group waiting on it', () => {
  const { change } = host({ 'plan.md': PLAN, 'tasks.md': TASKS })
  appendRecord(change, 'add-x', 'session', { phase: 'apply' }, { env })
  const a = addGroup(change, { change: 'add-x', group: 1 })
  const b = addGroup(change, { change: 'add-x', group: 2 })
  commitIn(a.root, 'src/t1.ts', 'one\n')
  commitIn(b.root, 'src/t2.ts', 'two\n')
  tick(change, '1.1')
  mergeGroup(change, { change: 'add-x', group: 1 })
  finishGroup(change, { change: 'add-x', group: 1 }, core)
  appendRecord(change, 'add-x', 'debt', { what: 'a stub', reason: 'later' }, { env })
  appendRecord(change, 'add-x', 'handoff', { merged: 'A', remaining: '1.2, 2.1', next: 'fix B', blocked: 'B' }, { env })

  const s = run(['--change', 'add-x', '--root', change, '--report'])
  assert.equal(s.ok, true, s.error)
  assert.deepEqual(s.groups.map((g) => [g.letter, g.state]), [['A', 'merged'], ['B', 'blocked'], ['C', 'pending']])
  assert.deepEqual([s.merged, s.blocked, s.running, s.startable, s.waitingOnBlocked], [[1], [2], [], [], [3]])
  assert.deepEqual([s.ticked, s.remaining, s.progress], [['1.1'], ['1.2', '2.1'], { done: 1, total: 3 }])
  assert.deepEqual(s.completedThisSession, ['1.1'])
  assert.deepEqual(s.openDebt, { count: 1, ids: ['debt-1'] })
  assert.equal(s.lastHandoff.next, 'fix B')
  assert.equal(s.push.state, 'none')
  assert.equal(s.complete, false)
  assert.match(s.report, /^## Implementation Paused\n\n\*\*Change:\*\* add-x\n\*\*Schema:\*\* adf\n\*\*Progress:\*\* 1\/3 tasks complete/)
  assert.match(s.report, /- \[x\] 1\.1 first/)
  assert.match(s.report, /group B \(2\) is blocked; its worktree is kept\n<the issue>/)
})

test('without a handoff naming it, a kept group is running and holds a slot', () => {
  const { change } = host({ 'plan.md': PLAN, 'tasks.md': TASKS })
  addGroup(change, { change: 'add-x', group: 2 })
  const s = run(['--change', 'add-x', '--root', change, '--cap', '2'])
  assert.deepEqual([s.running, s.startable, s.blocked], [[2], [1], []])
})

test('every group merged and every task ticked renders the Complete block', () => {
  const { change, dir } = host({ 'plan.md': PLAN, 'tasks.md': TASKS })
  appendRecord(change, 'add-x', 'session', { phase: 'apply' }, { env })
  for (const n of [1, 2, 3]) {
    const g = addGroup(change, { change: 'add-x', group: n })
    commitIn(g.root, `src/t${n}.ts`, `${n}\n`)
    mergeGroup(change, { change: 'add-x', group: n })
    finishGroup(change, { change: 'add-x', group: n }, core)
  }
  for (const item of ['1.1', '1.2', '2.1']) tick(change, item)
  writeFileSync(join(dir, '.apply-test-record.md'), '# Apply test record\n\n**Commit:** `abcdef1`\n**Ran on:** `abcdef1`\n**Result:** pass\n')
  const s = run(['--change', 'add-x', '--root', change, '--report'])
  assert.equal(s.complete, true)
  assert.equal(
    s.report,
    [
      '## Implementation Complete',
      '',
      '**Change:** add-x',
      '**Schema:** adf',
      '**Progress:** 3/3 tasks complete',
      '',
      '### Completed This Session',
      '- [x] 1.1 first',
      '- [x] 1.2 second',
      '- [x] 2.1 third',
      '',
      'Whole suite: passed',
      'Pushed: no forge plugin is enabled, nothing was pushed',
      'Open debt: 0',
      '',
      'Run /adf:verify, then the review, before archiving this change.'
    ].join('\n')
  )
})

test('the parts: blocked names, the test record, a refusal', () => {
  assert.deepEqual(blockedNames('B, 3 group-C'), ['B', '3', 'C'])
  assert.deepEqual(blockedNames(undefined), [])
  assert.deepEqual(suiteOf(null), { state: 'absent' })
  assert.deepEqual(suiteOf('**Result:** not run\n\nThe whole suite was not run: no command\n'), { state: 'not-run', commit: null, reason: 'no command' })
  const { change } = host({ 'plan.md': '# Plan\n\n### Task 1: x\n' })
  const s = run(['--change', 'add-x', '--root', change])
  assert.equal(s.ok, false)
  assert.deepEqual(s.findings.map((f) => f.kind), ['graph-missing'])
  assert.throws(() => run(['--root', change]), /usage/)
})

test('a handoff is written from the state, blocks a started group with its reason, and keeps it blocked', () => {
  const { change } = host({ 'plan.md': PLAN, 'tasks.md': TASKS })
  const handoff = (...args) => run(['handoff', '--change', 'add-x', '--root', change, ...args], { env })
  assert.throws(() => handoff('--next', 'fix B', '--block', 'B', '--reason', 'r'), /has not started/)
  const a = addGroup(change, { change: 'add-x', group: 1 })
  addGroup(change, { change: 'add-x', group: 2 })
  commitIn(a.root, 'src/t1.ts', 'one\n')
  tick(change, '1.1')
  mergeGroup(change, { change: 'add-x', group: 1 })
  finishGroup(change, { change: 'add-x', group: 1 }, core)
  assert.throws(() => handoff('--next', 'x', '--block', 'A', '--reason', 'r'), /is merged/)
  assert.throws(() => handoff('--next', 'x', '--block', 'Z', '--reason', 'r'), /not in the plan/)
  assert.throws(() => handoff('--next', 'x', '--block', 'B'), /go together/)
  assert.throws(() => run(['handoff', '--change', 'add-x', '--root', change], { env }), /--next/)

  const blocked = handoff('--next', 'developer rules on B', '--block', 'B', '--reason', 'round 5 left a load-bearing finding')
  assert.deepEqual([blocked.blocked, blocked.handoff.merged, blocked.handoff.remaining, blocked.handoff.blocked], [['B'], 'A', '1.2, 2.1', 'B'])
  assert.equal(blocked.handoff.blockedReason, 'group B: round 5 left a load-bearing finding')
  assert.equal(blocked.ruling, undefined, 'blocking is not a developer ruling')
  assert.deepEqual(run(['--change', 'add-x', '--root', change]).blocked, [2])
  // A later handoff that names no group still carries the blocked one.
  const later = handoff('--next', 'fresh session')
  assert.deepEqual([later.handoff.blocked, later.handoff.blockedReason], ['B', undefined])
  assert.deepEqual(run(['--change', 'add-x', '--root', change]).blocked, [2])
})

test('the status names the test-first tasks, as plan lint does', () => {
  const red = PLAN.replace('**Level:** integration\n\n---\n\n### Task 2', '**Level:** integration\n\n- [ ] **Step 1: RED** — fail\n- [ ] **Step 2: GREEN** — pass\n\n---\n\n### Task 2')
  const { change } = host({ 'plan.md': red, 'tasks.md': TASKS })
  assert.deepEqual(run(['--change', 'add-x', '--root', change]).testFirst, [1])
})

test('an open sweep finding is shown and keeps apply from complete until the developer dismisses it', () => {
  const { change, dir } = host({ 'plan.md': PLAN, 'tasks.md': TASKS })
  for (const n of [1, 2, 3]) {
    const g = addGroup(change, { change: 'add-x', group: n })
    commitIn(g.root, `src/t${n}.ts`, `${n}\n`)
    mergeGroup(change, { change: 'add-x', group: n })
    finishGroup(change, { change: 'add-x', group: n }, core)
  }
  for (const item of ['1.1', '1.2', '2.1']) tick(change, item)
  writeFileSync(join(dir, '.apply-test-record.md'), '**Result:** pass\n')
  assert.deepEqual([run(['--change', 'add-x', '--root', change]).complete, run(['--change', 'add-x', '--root', change]).sweep], [true, { ran: false, open: [], cleared: [] }])
  const finding = { introduced: 'src/t3.ts:1', existing: 'src/t1.ts:1', why: 'Same value.' }
  recordReply(change, 'add-x', { name: 'sweep', file: 'sweep.json', result: { verdict: 'FINDINGS', findings: [finding], dropped: [], head: git(change, 'rev-parse', 'HEAD') } })
  const s = run(['--change', 'add-x', '--root', change, '--report'])
  assert.deepEqual([s.complete, s.sweep.open], [false, [{ id: 'S1', ...finding }]])
  assert.match(s.report, /## Implementation Paused[\s\S]*- sweep finding S1: src\/t3\.ts:1 repeats src\/t1\.ts:1; consolidate it, or the developer dismisses it/)
  appendRecord(change, 'add-x', 'ruling', { subject: 'sweep', finding: 'S1', as: 'dismissed', decision: 'the values differ in meaning' })
  const done = run(['--change', 'add-x', '--root', change])
  assert.deepEqual([done.complete, done.sweep.open, done.sweep.cleared.map((c) => c.by)], [true, [], ['ruling']])
})

test('the push line names where the last push came from: a group merge or the whole-suite record', () => {
  assert.equal(pushLine(null), 'nothing pushed yet')
  assert.equal(pushLine({ state: 'done', group: 2 }), "done, after group 2's merge")
  assert.equal(pushLine({ state: 'done' }), 'done, with the whole-suite record')
  assert.equal(pushLine({ state: 'refused', error: 'no branches' }), 'refused: no branches')
})
