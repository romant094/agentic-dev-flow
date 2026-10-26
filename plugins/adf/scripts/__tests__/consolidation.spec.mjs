// The consolidation of a confirmed reuse-sweep duplicate: its dispatch names (`fix sweep r<k>`,
// `re-review sweep r<k>`, the re-sweep `sweep r<k>`), `sweep.mjs consolidate` and its ledger
// record, the fix's prompt and scope, the re-review's open set, and the re-sweep's record.
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { recordReply } from '../lib/attempts.mjs'
import { dispatchName, parseName, roundOf } from '../lib/dispatch.mjs'
import { appendRecord, listRecords } from '../lib/ledger.mjs'
import { checkReply, replyContext } from '../lib/reply.mjs'
import { runCovering } from '../lib/suite.mjs'
import { run as dispatch } from '../dispatch.mjs'
import { run as sweep } from '../sweep.mjs'
import { commitIn, git, host } from './git-host.mjs'

const PLAN = `# Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1 | x | 1 |

### Task 1: the row

> Implements \`tasks.md\` 1.1.

**Files:**
- Create: \`src/b.ts\` — the row

**Level:** integration
`

const RUNNER = "process.stdout.write('ok 1 - row\\n# tests 1\\n# pass 1\\n# fail 0\\n')\n"

// A change whose first sweep reported src/b.ts:1 as a repeat of src/a.ts:1.
function swept() {
  const made = host({ 'plan.md': PLAN })
  const { change } = made
  commitIn(change, 'src/a.ts', 'export const a = 1\n')
  commitIn(change, 'src/b.ts', 'export const b = 1\n')
  commitIn(change, 'runner.cjs', RUNNER)
  const finding = { introduced: 'src/b.ts:1', existing: 'src/a.ts:1', why: 'Same constant.' }
  recordReply(change, 'add-x', { name: 'sweep', file: 'sweep.json', result: { verdict: 'FINDINGS', findings: [finding], dropped: [], head: git(change, 'rev-parse', 'HEAD') } })
  mkdirSync(join(change, 'r'), { recursive: true })
  return { ...made, finding }
}

const call = (root, ...args) => dispatch([...args, '--change', 'add-x', '--root', root], { main: root })

test('the consolidation names: fix and re-review of the sweep, and the re-sweep, each with its round', () => {
  assert.equal(dispatchName({ role: 'fix', subject: 'sweep', round: 1 }), 'fix sweep r1')
  assert.equal(dispatchName({ role: 're-review', subject: 'sweep', round: 2 }), 're-review sweep r2')
  assert.equal(dispatchName({ role: 'sweep', round: 1 }), 'sweep r1')
  assert.deepEqual(parseName('fix sweep r1'), { role: 'fix', subject: 'sweep', round: 1 })
  assert.deepEqual(parseName('re-review sweep r2'), { role: 're-review', subject: 'sweep', round: 2 })
  assert.deepEqual(parseName('sweep r3'), { role: 'sweep', round: 3 })
  assert.throws(() => dispatchName({ role: 'fix', subject: 'sweep' }), /needs --round/)
  assert.throws(() => dispatchName({ role: 'fix', subject: 'sweep', round: 1, task: 2 }), /--subject sweep takes no --task or --group/)
  assert.throws(() => dispatchName({ role: 'review', subject: 'sweep', round: 1 }), /--subject belongs to fix and re-review/)
  assert.throws(() => dispatchName({ role: 'fix', subject: 'final', round: 1 }), /--subject is sweep/)
  // The final review's rounds do not count the consolidation's.
  const text = [{ name: 're-review sweep r1' }, { name: 're-review sweep r2' }].map((e) => JSON.stringify(e)).join('\n')
  assert.equal(roundOf(text, {}).round, 1)
})

test('consolidate opens a round on the open sweep findings, records it, and names its three dispatches', () => {
  const { change } = swept()
  const out = sweep(['consolidate', '--change', 'add-x', '--reason', 'the developer chose to consolidate', '--root', change])
  assert.deepEqual(
    { ...out, record: out.record.id },
    { ok: true, round: 1, findings: ['S1'], fix: 'fix sweep r1', reReview: 're-review sweep r1', sweep: 'sweep r1', record: 'consolidation-1', already: false }
  )
  const [record] = listRecords(change, 'add-x')
  assert.deepEqual([record.kind, record.round, record.findings, record.reason], ['consolidation', '1', 'S1', 'the developer chose to consolidate'])
  // Called again before the re-sweep's reply, it returns the round in flight and records nothing.
  const again = sweep(['consolidate', '--change', 'add-x', '--reason', 'again', '--root', change])
  assert.deepEqual([again.round, again.already, listRecords(change, 'add-x').length], [1, true, 1])
  // With nothing open there is nothing to consolidate.
  appendRecord(change, 'add-x', 'ruling', { subject: 'sweep', finding: 'S1', as: 'dismissed', decision: 'kept' })
  recordReply(change, 'add-x', { name: 'sweep r1', file: 's.json', result: { verdict: 'CLEAN', findings: [], dropped: [], head: git(change, 'rev-parse', 'HEAD') } })
  assert.throws(() => sweep(['consolidate', '--change', 'add-x', '--reason', 'x', '--root', change]), /nothing to consolidate/)
})

test('the fix of a consolidation is refused before its round is recorded, and then carries the duplicates and their files', () => {
  const { change } = swept()
  assert.throws(() => call(change, 'prompt', '--role', 'fix', '--subject', 'sweep', '--round', '1'), /no consolidation of round 1 is recorded/)
  sweep(['consolidate', '--change', 'add-x', '--reason', 'consolidate', '--root', change])
  const out = call(change, 'prompt', '--role', 'fix', '--subject', 'sweep', '--round', '1')
  assert.deepEqual([out.name, out.agent], ['fix sweep r1', 'adf:integration'])
  assert.ok(out.prompt.includes('- Open findings:\n  - S1 src/b.ts:1 repeats src/a.ts:1: Same constant.'), out.prompt)
  assert.ok(out.prompt.includes(`- Files in scope:\n  - ${join(change, 'src/b.ts')}\n  - ${join(change, 'src/a.ts')}`), out.prompt)
})

test('the fix reply of a consolidation may change the duplicate files outside every task', () => {
  const { change } = swept()
  sweep(['consolidate', '--change', 'add-x', '--reason', 'consolidate', '--root', change])
  const sha = commitIn(change, 'src/a.ts', 'export const a = 1\nexport const shared = 2\n')
  const other = commitIn(change, 'src/c.ts', 'export const c = 1\n')
  const run = runCovering(change, { change: 'add-x', name: 'fix sweep r1', command: 'node runner.cjs', worktree: change }).file
  const reply = (commits) => ({ role: 'fix', outcome: 'done', commits, testRuns: [run], concerns: [], summary: 'Consolidated.' })
  const checked = (commits) => checkReply('fix', JSON.stringify(reply(commits)), () => replyContext(change, 'add-x', 'fix sweep r1'))
  assert.equal(checked([sha]).result.status, 'DONE')
  assert.deepEqual(checked([sha, other]).result.concerns.map((c) => c.file), ['src/c.ts'])
})

test('the re-review of a consolidation answers the open duplicates; its own findings make the loop', () => {
  const { change } = swept()
  sweep(['consolidate', '--change', 'add-x', '--reason', 'consolidate', '--root', change])
  const check = (reply) => checkReply('re-review', JSON.stringify(reply), () => replyContext(change, 'add-x', 're-review sweep r1'))
  const base = { role: 're-review', summary: 'Checked.', findings: [], outOfScope: [] }
  assert.deepEqual(check({ ...base, previous: [] }).errors, ['$.previous: the open finding S1 of sweep is not answered'])
  const broke = { severity: 'important', kind: 'quality', category: 'quality', file: 'src/a.ts', line: 2, title: 'Export unused', body: 'Nothing reads it.' }
  const out = check({ ...base, previous: [{ id: 'S1', status: 'not-addressed', file: 'src/b.ts', line: 1 }], findings: [broke] })
  assert.deepEqual([out.result.subject, out.result.open, out.result.notConsolidated, out.result.result], ['sweep', ['F1'], ['S1'], 'fix'])
  recordReply(change, 'add-x', { name: 're-review sweep r1', file: 'rr.json', result: out.result })
  // The next round's re-review answers the duplicate still open and the fix loop's own finding.
  assert.deepEqual(check({ ...base, previous: [{ id: 'S1', status: 'addressed', file: 'src/b.ts', line: 1 }] }).errors, ['$.previous: the open finding F1 of sweep is not answered'])
})

test('an accepted re-sweep is recorded in the ledger with what it cleared and what stays open', () => {
  const { change } = swept()
  sweep(['consolidate', '--change', 'add-x', '--reason', 'consolidate', '--root', change])
  commitIn(change, 'src/b.ts', "export { a as b } from './a.ts'\n")
  writeFileSync(join(change, 'r/s.json'), JSON.stringify({ role: 'sweep', findings: [] }))
  const out = call(change, 'reply', '--name', 'sweep r1', '--file', 'r/s.json')
  assert.deepEqual([out.valid, out.result.verdict, out.reSweep.id], [true, 'CLEAN', 're-sweep-1'])
  const record = listRecords(change, 'add-x').find((r) => r.kind === 're-sweep')
  assert.deepEqual([record.round, record.cleared, record.open], ['1', 'S1', 'none'])
})
