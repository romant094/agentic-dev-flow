// quick.mjs and lib/quick.mjs: the quick task's large-item filter and estimate, on a scope
// record written into a real git repository in a temp directory. No tracker plugin runs: the
// scope is the one `scope.mjs gather` would have written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { largeItems, Refusal } from '../lib/quick.mjs'
import { readScope, writeScope } from '../lib/scope.mjs'
import { run } from '../quick.mjs'
import { run as scopeRun } from '../scope.mjs'

const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
const tracker = (key, kind, extra = {}) => ({ source: 'tracker', key, title: `${kind} ${key}`, kind, state: 'candidate', reason: null, verdict: null, check: null, flags: [], file: `.superpowers/sdd/fix-it/tracker/${key}.json`, ...extra })
const debt = (key, cls, anchors) => ({ source: 'debt', key, title: `debt ${key}`, kind: 'debt', class: cls, anchors, state: 'candidate', reason: null, verdict: null, check: null, flags: [], files: ['docs/debt/a/index.md'], matched: 'text' })

function host({ keys = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-quick-')))
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: root })
  writeScope(root, 'fix-it', {
    version: 1,
    change: 'fix-it',
    from: { keys, text: null },
    tracker: { state: 'done', plugin: 't', notes: [] },
    items: [
      tracker('P-1', 'epic'),
      tracker('P-2', 'story'),
      tracker('P-3', 'bug'),
      debt('d-1', 'debt', ['a.ts:1']),
      debt('d-2', 'defect', ['a.ts:1', 'b.ts:2', 'c.ts:3', 'd.ts:4', 'd.ts:9']),
      debt('d-3', 'defect', ['a.ts:1', 'a.ts:7'])
    ],
    precedents: [],
    inFlight: [],
    flagsShown: [],
    base: null,
    start: null,
    retest: null
  })
  return root
}

const quick = (root, ...args) => run([...args, '--root', root])
const reply = (root, body) => {
  const file = join(root, 'reply.json')
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}
const est = (key, over = {}) => ({ key, fit: 'quick', reason: 'one local change', files: ['src/a.ts'], behaviourChange: false, ...over })
const full = (over = {}) => ({
  items: [est('P-1', { fit: 'propose' }), est('P-2', { fit: 'propose' }), est('P-3', { verdict: 'current' }), est('d-1'), est('d-2'), est('d-3')].map((i) => ({ ...i, ...(over[i.key] ?? {}) }))
})
const stateOf = (root, key) => readScope(root, 'fix-it').items.find((i) => i.key === key)

test('largeItems gives the epic, the story, the non-defect debt and the defect with four files, with their reasons', () => {
  const root = host()
  assert.deepEqual(largeItems(readScope(root, 'fix-it')), [
    { key: 'P-1', reason: 'kind epic' },
    { key: 'P-2', reason: 'kind story' },
    { key: 'd-1', reason: 'class debt' },
    { key: 'd-2', reason: '4 files' }
  ])
})

test('filter excludes the large candidates as select --exclude does', () => {
  const root = host()
  const out = quick(root, 'filter', '--change', 'fix-it')
  assert.equal(out.ok, true)
  assert.deepEqual(out.candidates, ['P-3', 'd-3'])
  assert.deepEqual(out.excluded.map((e) => e.key), ['P-1', 'P-2', 'd-1', 'd-2'])
  const item = stateOf(root, 'd-2')
  assert.equal(item.state, 'excluded')
  assert.equal(item.reason, 'too large for a quick task (4 files)')
  assert.equal(stateOf(root, 'P-3').state, 'candidate')
})

test('filter keeps a named key and flags it', () => {
  const root = host({ keys: ['P-1'] })
  const out = quick(root, 'filter', '--change', 'fix-it')
  assert.deepEqual(out.flagged, [{ key: 'P-1', flag: 'P-1 looks too large for a quick task (kind epic)' }])
  assert.equal(stateOf(root, 'P-1').state, 'candidate')
  assert.deepEqual(stateOf(root, 'P-1').flags, ['P-1 looks too large for a quick task (kind epic)'])
  assert.equal(stateOf(root, 'P-2').state, 'excluded')
  quick(root, 'filter', '--change', 'fix-it')
  assert.equal(stateOf(root, 'P-1').flags.length, 1, 'a second filter adds no second flag')
})

test('estimate-input writes the prompt, each candidate with its file and the reply schema', () => {
  const root = host()
  quick(root, 'filter', '--change', 'fix-it')
  const out = quick(root, 'estimate-input', '--change', 'fix-it')
  assert.equal(out.name, 'quick-estimate')
  assert.equal(out.file, join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'estimate-input.md'))
  assert.deepEqual(out.candidates, ['P-3', 'd-3'])
  const text = readFileSync(out.file, 'utf8')
  assert.match(text, /dispatched as `quick-estimate`/)
  assert.match(text, /- `P-3` \(tracker, bug\): bug P-3; file .*P-3\.json/)
  assert.match(text, /- `d-3` \(debt, debt, defect\)|- `d-3` \(debt, defect\)/)
  assert.match(text, /"\$id": "adf\/quick-estimate\.schema\.json"/)
})

test('estimate-input writes marks.json with the time it ran', () => {
  const root = host()
  quick(root, 'filter', '--change', 'fix-it')
  const before = Date.now()
  quick(root, 'estimate-input', '--change', 'fix-it')
  const marks = JSON.parse(readFileSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'marks.json'), 'utf8'))
  assert.deepEqual(Object.keys(marks), ['estimate'])
  assert.ok(Date.parse(marks.estimate) >= before - 1000)
})

const prepared = () => {
  const root = host()
  quick(root, 'filter', '--change', 'fix-it')
  return root
}
const onlyCandidates = (...keys) => ({ items: [est('P-3', { verdict: 'current' }), est('d-3')].filter((i) => keys.includes(i.key)) })

test('estimate-check refuses a missing candidate, and records nothing', () => {
  const root = prepared()
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, onlyCandidates('P-3')))
  assert.equal(out.ok, false)
  assert.match(out.errors.join('\n'), /candidate d-3 is not estimated/)
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'estimate.json')), false)
  assert.equal(stateOf(root, 'P-3').verdict, null)
})

test('estimate-check refuses an unknown key and a key twice', () => {
  const root = prepared()
  const body = { items: [...onlyCandidates('P-3', 'd-3').items, est('X-9'), est('d-3')] }
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, body))
  assert.equal(out.ok, false)
  assert.match(out.errors.join('\n'), /X-9, which is not a candidate/)
  assert.match(out.errors.join('\n'), /d-3 is estimated twice/)
})

test('estimate-check refuses a quick tracker item with no verdict', () => {
  const root = prepared()
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, { items: [est('P-3'), est('d-3')] }))
  assert.equal(out.ok, false)
  assert.match(out.errors.join('\n'), /P-3 is a tracker issue marked quick and has no verdict/)
})

test('estimate-check refuses a reply that breaks the schema', () => {
  const root = prepared()
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, { items: [{ key: 'P-3', fit: 'maybe' }] }))
  assert.equal(out.ok, false)
  assert.ok(out.errors.length > 0)
})

test('estimate-check turns a behaviour change into propose', () => {
  const root = prepared()
  const body = { items: [est('P-3', { verdict: 'current' }), est('d-3', { behaviourChange: true })] }
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, body))
  assert.equal(out.ok, true)
  assert.deepEqual(out.items.map((i) => [i.key, i.fit]), [['P-3', 'quick'], ['d-3', 'propose']])
  assert.equal(JSON.parse(readFileSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'estimate.json'), 'utf8')).items[1].fit, 'propose')
})

test('estimate-check records the verdicts that scope.mjs start requires', () => {
  const root = prepared()
  scopeRun(['select', '--change', 'fix-it', '--take', 'P-3,d-3', '--root', root])
  const start = () => scopeRun(['start', '--change', 'fix-it', '--root', root, '--home', home])
  assert.throws(start, /check and settle every taken or partial issue before start: P-3 \(not checked\)/)
  const body = { items: [est('P-3', { verdict: 'corrected', corrections: ['the pool closes on reconnect'] }), est('d-3')] }
  assert.equal(quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, body)).ok, true)
  const item = stateOf(root, 'P-3')
  assert.equal(item.verdict, 'corrected')
  assert.deepEqual(item.check.corrections, [{ what: 'the pool closes on reconnect', was: '', now: 'the pool closes on reconnect' }])
  // start now passes the verdict check; it stops at the missing worktree, which a later step makes.
  assert.throws(start, /start runs after the branch and the worktree exist/)
})

test('estimate-check excludes an obsolete tracker item with the estimate\'s reason', () => {
  const root = prepared()
  const body = { items: [est('P-3', { fit: 'propose', reason: 'fixed in 1.2', verdict: 'obsolete' }), est('d-3')] }
  assert.equal(quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, body)).ok, true)
  assert.deepEqual([stateOf(root, 'P-3').state, stateOf(root, 'P-3').reason], ['excluded', 'fixed in 1.2'])
})

test('a corrected verdict with no correction is refused', () => {
  const root = prepared()
  const out = quick(root, 'estimate-check', '--change', 'fix-it', '--file', reply(root, { items: [est('P-3', { verdict: 'corrected' }), est('d-3')] }))
  assert.match(out.errors.join('\n'), /P-3 has the verdict corrected and lists no correction/)
})

test('the CLI refuses a usage error', () => {
  assert.throws(() => run(['estimate-check', '--change', 'fix-it']), /needs --file/)
  assert.throws(() => run(['filter']), /needs --change/)
})

// ---------------------------------------------------------------- tests: the affected tests

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const PLANNING = (body) => `# Guide\n\n## Affected tests command\n\n${body}\n\n## Other\n\nx\n`

function worktree(section = '`runner {files}`') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-quick-tests-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, 'openspec', 'changes', 'fix-it'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'changes', 'fix-it', '.adf.json'), JSON.stringify({ base: 'develop' }))
  writeFileSync(join(root, 'openspec', 'planning.md'), PLANNING(section))
  writeFileSync(join(root, 'base.txt'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'fix/it')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-q', '-m', 'a')
  writeFileSync(join(root, 'base.txt'), 'changed\n')
  writeFileSync(join(root, 'it\'s.txt'), 'u\n')
  return root
}
const recorder = (status = 0, stdout = 'ran') => {
  const calls = []
  const runner = (command, options) => {
    calls.push({ command, cwd: options.cwd })
    return { status, stdout, stderr: '' }
  }
  return { calls, runner }
}
const testsOf = (root, runner) => run(['tests', '--change', 'fix-it', '--root', root], { runner })

test('tests replaces {files} with the changed paths', () => {
  const root = worktree()
  const { calls, runner } = recorder()
  const out = testsOf(root, runner)
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, root)
  assert.equal(calls[0].command, `runner 'a.txt' 'base.txt' 'it'\\''s.txt'`)
})

test('the change directory, the planning guide and the state directory are not test input', () => {
  const root = worktree()
  writeFileSync(join(root, 'openspec', 'changes', 'fix-it', 'quick.md'), '# Quick\n')
  writeFileSync(join(root, 'openspec', 'planning.md'), PLANNING('`runner {files}` '))
  mkdirSync(join(root, '.superpowers', 'sdd', 'fix-it'), { recursive: true })
  writeFileSync(join(root, '.superpowers', 'sdd', 'fix-it', 'note.json'), '{}\n')
  git(root, 'add', 'openspec/changes/fix-it/quick.md')
  git(root, 'commit', '-q', '-m', 'quick')
  const { calls, runner } = recorder()
  testsOf(root, runner)
  assert.equal(calls[0].command, `runner 'a.txt' 'base.txt' 'it'\\''s.txt'`)
})

test('an empty section waits and runs nothing', () => {
  const root = worktree('')
  const { calls, runner } = recorder()
  const out = testsOf(root, runner)
  assert.equal(out.ok, true)
  assert.match(out.waiting, /^the affected tests command: propose one from the project's test runner/)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'tests.json')), false)
})

test('a failing command is exit 1 and recorded', () => {
  const root = worktree()
  const { runner } = recorder(3, 'x'.repeat(5000) + 'END')
  const out = testsOf(root, runner)
  assert.equal(out.ok, false)
  assert.equal(out.status, 3)
  const record = JSON.parse(readFileSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'tests.json'), 'utf8'))
  assert.equal(record.status, 3)
  assert.equal(record.output.length, 4000)
  assert.ok(record.output.endsWith('END'))
})

test('the record names HEAD', () => {
  const root = worktree()
  const out = testsOf(root, recorder().runner)
  const record = JSON.parse(readFileSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'tests.json'), 'utf8'))
  assert.equal(record.commit, git(root, 'rev-parse', 'HEAD'))
  assert.equal(out.commit, record.commit)
  assert.equal(record.command, out.command)
  assert.equal(record.status, 0)
})

test('no changed files runs nothing', () => {
  const root = worktree()
  git(root, 'checkout', '-q', 'develop')
  git(root, 'reset', '-q', '--hard')
  git(root, 'clean', '-fdq')
  const { calls, runner } = recorder()
  const out = testsOf(root, runner)
  assert.deepEqual(out, { ok: true, change: 'fix-it', step: 'tests', skipped: 'no changed files' })
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', 'fix-it', 'quick', 'tests.json')), false)
})

test('a section of several lines is a refusal', () => {
  const root = worktree('one\ntwo')
  assert.throws(() => testsOf(root, recorder().runner), (e) => e instanceof Refusal && /must hold one command/.test(e.message))
})
