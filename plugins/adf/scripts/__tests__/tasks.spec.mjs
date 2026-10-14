import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tickTask } from '../lib/tasks.mjs'

function host(text) {
  const root = mkdtempSync(join(tmpdir(), 'adf-tasks-'))
  mkdirSync(join(root, 'openspec', 'changes', 'c'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'changes', 'c', 'tasks.md'), text)
  return root
}
const read = (root) => readFileSync(join(root, 'openspec', 'changes', 'c', 'tasks.md'), 'utf8')

test('tick marks exactly the named task, not one whose number starts the same', () => {
  const root = host('## 1. G\n\n- [ ] 1.1 one\n- [ ] 1.10 ten\n- [ ] 1.2 two\n')
  assert.deepEqual(tickTask(root, 'c', '1.1'), { item: '1.1', ticked: true, already: false })
  assert.equal(read(root), '## 1. G\n\n- [x] 1.1 one\n- [ ] 1.10 ten\n- [ ] 1.2 two\n')
})

test('a ticked task is reported as already done and the file is unchanged', () => {
  const root = host('- [x] 2.1 done\n')
  assert.deepEqual(tickTask(root, 'c', '2.1'), { item: '2.1', ticked: false, already: true })
  assert.equal(read(root), '- [x] 2.1 done\n')
})

test('an unknown task, a malformed number and a missing file are refused', () => {
  const root = host('- [ ] 1.1 one\n')
  assert.throws(() => tickTask(root, 'c', '3.1'), /has no task 3\.1/)
  assert.throws(() => tickTask(root, 'c', '1.x'), /not a task number/)
  assert.throws(() => tickTask(root, 'other', '1.1'), /other has no tasks\.md/)
})
