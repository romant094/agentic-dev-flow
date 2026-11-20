import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { recordReply } from '../lib/attempts.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { lintTasks, tickTask } from '../lib/tasks.mjs'
import { run } from '../tasks.mjs'

function host(text) {
  const root = mkdtempSync(join(tmpdir(), 'adf-tasks-'))
  mkdirSync(join(root, 'adf', 'changes', 'c'), { recursive: true })
  writeFileSync(join(root, 'adf', 'changes', 'c', 'tasks.md'), text)
  return root
}
const read = (root) => readFileSync(join(root, 'adf', 'changes', 'c', 'tasks.md'), 'utf8')

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

test('lint: origin wording with a path shape that names no source file is not a path warning', () => {
  const text = [
    '## 1. Wording',
    '',
    '- [ ] 1.1 reports an endpoint declared for a form `N/A` where the model does not serve it',
    '- [ ] 1.2 walks each model directory (`.imgs` at the root, `archived/`, `unreleased/`)',
    '- [ ] 1.3 records the pass in `verify.md`',
    '- [ ] 1.4 writes `infra/scripts/generate-firmware-manifest.ts` and `storage/downloads/tftp-files/`',
    '- [ ] 1.5 updates `system.md` and `entities/shared-library.md`',
    ''
  ].join('\n')
  assert.deepEqual(
    lintTasks(text).map((f) => [f.kind, f.line, f.message.split(' ')[0]]),
    [
      ['path', 6, '`infra/scripts/generate-firmware-manifest.ts`'],
      ['path', 6, '`storage/downloads/tftp-files/`'],
      ['path', 7, '`system.md`'],
      ['path', 7, '`entities/shared-library.md`']
    ]
  )
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const PLAN = '## Execution Graph\n\nsingle group\n\n### Task 1: a\n\n> Implements `tasks.md` 1.2.\n\n### Task 2: b\n\n'

function repo() {
  const root = host('## 1. G\n\n- [ ] 1.1 one\n- [ ] 1.2 two\n')
  const real = realpathSync(root)
  writeFileSync(join(real, 'adf', 'changes', 'c', 'plan.md'), PLAN)
  writeFileSync(join(real, '.gitignore'), '.superpowers/\n')
  git(real, 'init', '-q', '-b', 'main')
  git(real, 'config', 'user.email', 't@example.com')
  git(real, 'config', 'user.name', 'T')
  git(real, 'add', '.')
  git(real, 'commit', '-q', '-m', 'init')
  return real
}

// An accepted review of T<n> in the events log, with its computed result.
const reviewed = (root, n, over = {}, name = `T${n} review`) =>
  recordReply(root, 'c', { name, file: `${name}.json`, result: { subject: `T${n}`, findings: [], open: [], toRule: [], deferred: [], unverifiable: [], result: 'clean', ...over } })

test('tick --plan-task resolves the item from the back-reference and --commit commits by path', () => {
  const root = repo()
  reviewed(root, 1)
  writeFileSync(join(root, 'adf', 'changes', 'c', 'plan.md'), `${PLAN}- added line\n`)
  writeFileSync(join(root, 'unrelated.txt'), 'left alone\n')
  const out = run(['tick', '--plan-task', '1', '--change', 'c', '--root', root, '--commit'])
  assert.equal(out.code, 0)
  assert.equal(out.result.item, '1.2')
  assert.deepEqual(out.result.paths, ['adf/changes/c/tasks.md', 'adf/changes/c/plan.md'])
  assert.equal(out.result.sha, git(root, 'rev-parse', 'HEAD'))
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(adf): tick 1.2 of c')
  assert.equal(git(root, 'status', '--porcelain'), '?? unrelated.txt')
  assert.equal(read(root), '## 1. G\n\n- [ ] 1.1 one\n- [x] 1.2 two\n')
  // Ticked already and nothing changed: no commit.
  assert.deepEqual(run(['tick', '1.2', '--change', 'c', '--root', root, '--commit']).result, { item: '1.2', ticked: false, already: true, sha: null, paths: [] })
  // A task with no back-reference, and both forms at once.
  assert.match(run(['tick', '--plan-task', '2', '--change', 'c', '--root', root]).result.error, /no "> Implements/)
  assert.equal(run(['tick', '1.1', '--plan-task', '1', '--change', 'c', '--root', root]).code, 2)
})

// #48: a task with no code, such as the developer's bench pass, has no review to wait for.
test('a verification-only task closes on a recorded evidence file, committed with its tick', () => {
  const root = repo()
  const bench = "## Execution Graph\n\nsingle group\n\n### Task 1: bench\n\n> Implements `tasks.md` 1.2.\n\n- [ ] **Step 1: Commit** — none: the developer's bench pass\n\n### Task 2: b\n\n"
  writeFileSync(join(root, 'adf', 'changes', 'c', 'plan.md'), bench)
  git(root, 'commit', '-q', '-am', 'plan')
  const tick = (...extra) => run(['tick', '--plan-task', '1', '--change', 'c', '--root', root, ...extra])
  const evidence = 'adf/changes/c/bench.md'
  assert.match(tick().result.error, /no accepted review of T1 is recorded/)
  assert.match(tick('--evidence', evidence).result.error, /bench\.md does not exist/)
  writeFileSync(join(root, evidence), '\n')
  assert.match(tick('--evidence', evidence).result.error, /bench\.md is empty/)
  writeFileSync(join(root, 'notes.md'), 'passed\n')
  assert.match(tick('--evidence', 'notes.md').result.error, /lies outside adf\/changes\/c\//)
  writeFileSync(join(root, evidence), 'Passed on the Windows bench.\n')
  const out = tick('--evidence', evidence, '--commit')
  assert.equal(out.code, 0, JSON.stringify(out.result))
  assert.deepEqual([out.result.item, out.result.evidence, out.result.paths], ['1.2', evidence, ['adf/changes/c/tasks.md', evidence]])
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(adf): tick 1.2 of c')
  assert.equal(git(root, 'status', '--porcelain'), '?? notes.md')
  // A task that commits code closes on its review, never on evidence; evidence names a plan task.
  const coded = repo()
  writeFileSync(join(coded, evidence), 'passed\n')
  assert.match(run(['tick', '--plan-task', '1', '--change', 'c', '--root', coded, '--evidence', evidence]).result.error, /Task 1's Commit step does not say none/)
  assert.equal(run(['tick', '1.2', '--change', 'c', '--root', coded, '--evidence', evidence]).code, 2)
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

test('tick --commit commits through the index: a pre-commit hook that formats and re-stages leaves nothing behind (#1)', () => {
  const root = repo()
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  mkdirSync(dirname(hook), { recursive: true })
  writeFileSync(hook, "#!/bin/sh\nprintf '# formatted\\n' >> adf/changes/c/tasks.md\ngit add adf/changes/c/tasks.md\n")
  chmodSync(hook, 0o755)
  const out = run(['tick', '1.1', '--change', 'c', '--root', root, '--commit'])
  assert.equal(out.code, 0)
  assert.match(git(root, 'show', 'HEAD:adf/changes/c/tasks.md'), /- \[x\] 1\.1 one\n- \[ \] 1\.2 two\n# formatted$/)
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('tick --commit runs the settings\' format command on the tick\'s paths first (#2)', () => {
  const root = repo()
  writeFileSync(join(root, 'adf', 'settings.json'), JSON.stringify({ formatCommand: "perl -pi -e 's/^- \\[x\\]/- [X]/' {files}" }))
  git(root, 'add', 'adf/settings.json')
  git(root, 'commit', '-q', '-m', 'guide')
  const out = run(['tick', '1.1', '--change', 'c', '--root', root, '--commit'])
  assert.equal(out.code, 0)
  assert.equal(git(root, 'show', 'HEAD:adf/changes/c/tasks.md'), '## 1. G\n\n- [X] 1.1 one\n- [ ] 1.2 two')
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('tasks.mjs lint exits 1 on an error finding and 0 on warnings alone', () => {
  const root = host('## 1. G\n\n- [ ] 1.1 runs `npm test`\n')
  assert.deepEqual([run(['lint', '--change', 'c', '--root', root]).code, run(['lint', '--change', 'c', '--root', root]).result.ok], [0, true])
  const bad = host('- [ ] 1.1 no group\n')
  assert.equal(run(['lint', '--change', 'c', '--root', bad]).code, 1)
  assert.equal(run(['lint', '--root', bad]).code, 2)
})

test('tasks.mjs lint refuses a taken or partial scope key that no task names, by the rule verify uses', () => {
  const root = host('## 1. G\n\n- [ ] 1.1 greet the user (PROJ-1)\n- [ ] 1.2 wave\n')
  const items = [
    { source: 'tracker', key: 'PROJ-1', state: 'taken' },
    { source: 'debt', key: 'snmp-01', state: 'taken' },
    { source: 'tracker', key: 'PROJ-12', state: 'partial' },
    { source: 'tracker', key: 'PROJ-3', state: 'excluded', reason: 'later' }
  ]
  writeFileSync(join(root, 'adf', 'changes', 'c', 'scope.json'), JSON.stringify({ version: 1, change: 'c', tracker: { state: 'done', plugin: 't' }, items }))
  const out = run(['lint', '--change', 'c', '--root', root])
  assert.equal(out.code, 1)
  assert.deepEqual(
    out.result.findings.filter((f) => f.kind === 'scope-key').map((f) => [f.severity, f.message]),
    [
      ['error', 'snmp-01 (taken) is named by no task: name it, as a whole word, on the task that addresses it'],
      ['error', 'PROJ-12 (partial) is named by no task: name it, as a whole word, on the task that addresses it']
    ]
  )
  writeFileSync(join(root, 'adf', 'changes', 'c', 'tasks.md'), '## 1. G\n\n- [ ] 1.1 greet the user (PROJ-1)\n- [ ] 1.2 wave for snmp-01\n- [ ] 1.3 the rest of PROJ-12\n')
  assert.deepEqual([run(['lint', '--change', 'c', '--root', root]).code, run(['lint', '--change', 'c', '--root', root]).result.findings], [0, []])
})

test('tick --plan-task refuses until the task review loop is clean or a ruling closes each item left', () => {
  const root = repo()
  const tick = () => run(['tick', '--plan-task', '1', '--change', 'c', '--root', root])
  const refused = (pattern) => {
    const out = tick()
    assert.equal(out.code, 1)
    assert.match(out.result.error, pattern)
    assert.equal(read(root), '## 1. G\n\n- [ ] 1.1 one\n- [ ] 1.2 two\n')
  }
  refused(/Task 1 is not ticked: no accepted review of T1 is recorded/)
  const f = (id, over = {}) => ({ id, severity: 'important', kind: 'quality', category: 'quality', file: 'src/a.mjs', line: 3, title: 't', body: 'b', planMandated: false, ...over })
  reviewed(root, 1, { findings: [f('F1'), f('F2', { planMandated: true })], open: ['F1'], toRule: ['F2'], unverifiable: [{ requirement: 'R1', check: 'on the bench' }], result: 'rule' })
  refused(/T1 is not clean \(open F1; to rule F2; unverifiable U1\): .*ledger\.mjs ruling --change c --subject T1 --finding <id>/)
  const rule = (finding, as) => appendRecord(root, 'c', 'ruling', { subject: 'T1', finding, as, decision: 'why' })
  rule('F2', 'accepted')
  rule('U1', 'accepted')
  refused(/open F1\)/)
  // A re-review that leaves F1 open keeps the task open; a ruling accepting it closes it.
  reviewed(root, 1, { previous: [{ id: 'F1', status: 'not-addressed' }], addressed: [], open: ['F1'], result: 'fix' }, 'T1 re-review r1')
  refused(/open F1\)/)
  rule('F1', 'accepted')
  assert.deepEqual(tick().result, { item: '1.2', ticked: true, already: false, planTask: 1 })
  // A ruling on another subject or a fix ruling does not close an item.
  const other = repo()
  recordReply(other, 'c', { name: 'T1 review', file: 'r.json', result: { subject: 'T1', findings: [f('F1')], open: ['F1'], toRule: [], deferred: [], unverifiable: [], result: 'fix' } })
  appendRecord(other, 'c', 'ruling', { subject: 'T2', finding: 'F1', as: 'accepted', decision: 'x' })
  appendRecord(other, 'c', 'ruling', { subject: 'T1', finding: 'F1', as: 'fix', decision: 'x' })
  assert.match(run(['tick', '--plan-task', '1', '--change', 'c', '--root', other]).result.error, /open F1\)/)
})
