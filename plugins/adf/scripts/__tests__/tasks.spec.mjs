import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { lintTasks, tickTask } from '../lib/tasks.mjs'
import { run } from '../tasks.mjs'

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

test('lint: the grammar apply parses, numbers against their group, duplicates, paths and commands', () => {
  const text = [
    '<!-- - [ ] guidance inside a comment is not content -->',
    '## 1. One',
    '',
    '- [ ] 1.1 first',
    '- [x] 1.2 second, with `a-flag` mentioned',
    '- [] 1.3 malformed',
    '- 1.4 no checkbox',
    '- [ ] 2.1 under the wrong group',
    '- [ ] 1.1 again',
    '## Notes',
    '- [ ] 2.2 edits `src/a.ts` and runs `npm test`',
    ''
  ].join('\n')
  assert.deepEqual(
    lintTasks(text).map((f) => [f.severity, f.kind, f.line]),
    [
      ['error', 'checkbox-grammar', 6],
      ['error', 'untracked-item', 7],
      ['error', 'group-mismatch', 8],
      ['error', 'duplicate', 9],
      ['error', 'group-heading', 10],
      ['error', 'group-mismatch', 11],
      ['warning', 'path', 11],
      ['warning', 'command', 11]
    ]
  )
  assert.deepEqual(lintTasks('## 1. A\n\n- [ ] 1.1 a\n- [x] 1.2 b\n'), [])
  assert.deepEqual(lintTasks('# nothing\n').map((f) => f.kind), ['no-items'])
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const PLAN = '## Execution Graph\n\nsingle group\n\n### Task 1: a\n\n> Implements `tasks.md` 1.2.\n\n### Task 2: b\n\n'

function repo() {
  const root = host('## 1. G\n\n- [ ] 1.1 one\n- [ ] 1.2 two\n')
  const real = realpathSync(root)
  writeFileSync(join(real, 'openspec', 'changes', 'c', 'plan.md'), PLAN)
  git(real, 'init', '-q', '-b', 'main')
  git(real, 'config', 'user.email', 't@example.com')
  git(real, 'config', 'user.name', 'T')
  git(real, 'add', '.')
  git(real, 'commit', '-q', '-m', 'init')
  return real
}

test('tick --plan-task resolves the item from the back-reference and --commit commits by path', () => {
  const root = repo()
  writeFileSync(join(root, 'openspec', 'changes', 'c', 'plan.md'), `${PLAN}- added line\n`)
  writeFileSync(join(root, 'unrelated.txt'), 'left alone\n')
  const out = run(['tick', '--plan-task', '1', '--change', 'c', '--root', root, '--commit'])
  assert.equal(out.code, 0)
  assert.equal(out.result.item, '1.2')
  assert.deepEqual(out.result.paths, ['openspec/changes/c/tasks.md', 'openspec/changes/c/plan.md'])
  assert.equal(out.result.sha, git(root, 'rev-parse', 'HEAD'))
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(openspec): tick 1.2 of c')
  assert.equal(git(root, 'status', '--porcelain'), '?? unrelated.txt')
  assert.equal(read(root), '## 1. G\n\n- [ ] 1.1 one\n- [x] 1.2 two\n')
  // Ticked already and nothing changed: no commit.
  assert.deepEqual(run(['tick', '1.2', '--change', 'c', '--root', root, '--commit']).result, { item: '1.2', ticked: false, already: true, sha: null, paths: [] })
  // A task with no back-reference, and both forms at once.
  assert.match(run(['tick', '--plan-task', '2', '--change', 'c', '--root', root]).result.error, /no "> Implements/)
  assert.equal(run(['tick', '1.1', '--plan-task', '1', '--change', 'c', '--root', root]).code, 2)
})

test('tick --commit refuses, and ticks nothing, while another path is staged', () => {
  const root = repo()
  writeFileSync(join(root, 'other.txt'), 'x\n')
  git(root, 'add', 'other.txt')
  const out = run(['tick', '1.1', '--change', 'c', '--root', root, '--commit'])
  assert.equal(out.code, 1)
  assert.match(out.result.error, /other paths are staged.*other\.txt/)
  assert.equal(read(root), '## 1. G\n\n- [ ] 1.1 one\n- [ ] 1.2 two\n')
})

test('tasks.mjs lint exits 1 on an error finding and 0 on warnings alone', () => {
  const root = host('## 1. G\n\n- [ ] 1.1 runs `npm test`\n')
  assert.deepEqual([run(['lint', '--change', 'c', '--root', root]).code, run(['lint', '--change', 'c', '--root', root]).result.ok], [0, true])
  const bad = host('- [ ] 1.1 no group\n')
  assert.equal(run(['lint', '--change', 'c', '--root', bad]).code, 1)
  assert.equal(run(['lint', '--root', bad]).code, 2)
})
