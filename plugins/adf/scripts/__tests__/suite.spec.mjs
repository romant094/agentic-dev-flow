// The whole-suite command, its run, the base check and both writers, against real git
// repositories and a fake suite: a node script whose behaviour a committed mode.txt sets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { baseCheckPath } from '../lib/groups.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { initRegistry, readRegistry } from '../lib/registry.mjs'
import { countLines, countsOf, failingIn, readCommand, readTestRecord, runCovering, runSuite, writeCommand } from '../lib/suite.mjs'
import { isStale, readMarker, runMarker, waitForRun } from '../lib/suite-run.mjs'
import { computeVerdict, runChecks, verifyDir } from '../lib/verify.mjs'
import { create } from '../lib/workspace.mjs'
import { judged } from './verify-replies.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'suite.mjs')
const CHANGE = 'add-x'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const changeFile = (file) => `openspec/changes/${CHANGE}/${file}`

// mode.txt: `pass`, `fail:a,b` (TAP names the failures), `spec:a,b` (the node:test spec reporter
// names them, twice, under its "failing tests:" header), `anon` (fails, names nothing); a
// `+junk` suffix leaves an untracked file behind, which makes git refuse to remove a worktree.
const FAKE_SUITE = `import { readFileSync, writeFileSync } from 'node:fs'
const [mode, extra] = readFileSync('mode.txt', 'utf8').trim().split('+')
const picked = process.argv.slice(2)
if (process.env.ADF_PEEK) console.log('PEEK ' + readFileSync(process.env.ADF_PEEK, 'utf8').replace(/\\s+/g, ' '))
if (picked.length) console.log('SELECTED ' + picked.join(' '))
if (extra === 'junk') writeFileSync('junk.txt', 'x')
console.log('MARKER-RAW-OUTPUT')
if (mode === 'anon') { console.error('Error: boom'); process.exit(1) }
if (mode.startsWith('env:')) {
  const n = Number(mode.slice(4))
  for (let i = 1; i <= n; i++) {
    console.log('FAIL src/t' + i + '.spec.ts')
    console.log("  src/t" + i + ".spec.ts:1:1 - error TS2307: Cannot find module '@w/shared' or its corresponding type declarations.")
  }
  console.log('Test Suites: ' + n + ' failed, ' + n + ' total')
  process.exit(1)
}
if (mode.startsWith('turbo:')) {
  mode.slice(6).split(',').forEach((name, i) => console.log('not ok ' + (i + 1) + ' - ' + name))
  console.log(' Tasks:    1 successful, 3 total')
  console.log('Failed:    server#test')
  process.exit(1)
}
if (mode.startsWith('spec:')) {
  const names = mode.slice(5).split(',')
  console.log('\u2714 stays (0.1ms)')
  for (const name of names) console.log('\u2716 ' + name + ' (0.2ms)')
  console.log('\u2139 tests ' + (names.length + 1))
  console.log('\u2139 pass 1')
  console.log('\u2139 fail ' + names.length)
  console.log('\u2716 failing tests:')
  for (const name of names) console.log('\u2716 ' + name + ' (0.2ms)')
  process.exit(1)
}
const failing = (mode.startsWith('fail:') ? mode.slice(5).split(',') : []).filter((name) => !picked.length || picked.includes(name))
console.log('TAP version 13')
console.log('ok 1 - stays')
failing.forEach((name, i) => console.log('not ok ' + (i + 2) + ' - ' + name))
console.log('# tests ' + (failing.length + 1))
console.log('# pass 1')
console.log('# fail ' + failing.length)
process.exit(failing.length ? 1 : 0)
`

// The change's settings with one more key, committed.
function withSetting(root, key, value, message) {
  const file = 'openspec/settings.json'
  commit(root, { [file]: `${JSON.stringify({ ...JSON.parse(readFileSync(join(root, file), 'utf8')), [key]: value })}\n` }, message)
}

function write(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

function commit(root, files, message = Object.keys(files)[0]) {
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  git(root, 'add', '--', ...Object.keys(files))
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

// A host on develop whose suite runs in `baseMode`, and a change worktree that moves it to
// `headMode`. `command: null` leaves the settings without a whole-suite command.
function host({ baseMode = 'pass', headMode = 'pass', command = 'node suite.mjs' } = {}) {
  const main = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', main])
  git(main, 'config', 'user.email', 't@example.com')
  git(main, 'config', 'user.name', 'T')
  initRegistry(main, '1.2')
  setBranches(main, { integration: 'develop', protected: [] })
  ignoreLocalDirs(main)
  write(main, 'suite.mjs', FAKE_SUITE)
  write(main, 'mode.txt', `${baseMode}\n`)
  write(main, 'openspec/settings.json', '{}\n')
  if (command) writeCommand(main, command)
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'init')
  const root = create(main, { change: CHANGE, branch: `feat/${CHANGE}`, base: 'integration' }).root
  commit(root, {
    [changeFile('.adf.json')]: `${JSON.stringify({ schema: 'adf', base: 'develop' })}\n`,
    [changeFile('proposal.md')]: '# Proposal\n',
    [changeFile('tasks.md')]: '- [x] 1.1 do it\n',
    [changeFile('plan.md')]: '# Plan\n\n### Task 1: Do\n\n**Files:**\n- Modify: `mode.txt`\n- Create: `src.txt`\n'
  }, 'propose')
  const head = commit(root, { 'mode.txt': `${headMode}\n`, 'src.txt': 'code\n' }, 'code')
  return { main, root, head }
}

const cli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, json: JSON.parse(r.stdout) }
}

// ---------------------------------------------------------------- the settings

test('set records the command in the settings, replaces an earlier one, keeps the other keys, and creates the file', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-set-')))
  assert.deepEqual(readCommand(root), { file: join(root, 'openspec/settings.json'), command: null, reason: 'openspec/settings.json does not exist' })
  write(root, 'openspec/settings.json', '{ "formatCommand": "fmt {files}" }\n')
  assert.equal(readCommand(root).reason, 'openspec/settings.json holds no wholeSuiteCommand')
  writeCommand(root, 'npm test')
  writeCommand(root, 'npm run test:all')
  const text = readFileSync(join(root, 'openspec/settings.json'), 'utf8')
  assert.deepEqual(JSON.parse(text), { wholeSuiteCommand: 'npm run test:all', formatCommand: 'fmt {files}' })
  assert.equal(readCommand(root).command, 'npm run test:all')

  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-set-')))
  const out = cli(['set', '--root', bare, '--command', 'go test -count=1 ./...'])
  assert.equal(out.code, 0)
  assert.equal(readFileSync(join(bare, 'openspec/settings.json'), 'utf8'), '{\n  "wholeSuiteCommand": "go test -count=1 ./..."\n}\n')
  assert.deepEqual(cli(['command', '--root', bare]).json, { file: join(bare, 'openspec/settings.json'), command: 'go test -count=1 ./...' })
  assert.throws(() => writeCommand(bare, 'a\nb'), /must be one line/)
})

// ---------------------------------------------------------------- parsing

test('failing identifiers and count lines come from the runner output', () => {
  const tap = 'ok 1 - a\nnot ok 2 - b # SKIP\n# tests 2\n# pass 1\n'
  assert.deepEqual(failingIn(tap), ['b'])
  assert.deepEqual(failingIn(' FAIL  src/a.test.ts\n  ✕ adds (3 ms)\nFAILED tests/t.py::test_x - assert\n--- FAIL: TestY (0.0s)'), ['src/a.test.ts', 'adds', 'tests/t.py::test_x', 'TestY'])
  assert.deepEqual(countLines(tap), ['# tests 2', '# pass 1'])
  // The node:test spec reporter: each failure once, its "failing tests:" header and colours not.
  const spec = '\u001b[31m✖ adds (1.3ms)\u001b[39m\n  AssertionError\n✔ passes (0.1ms)\n▶ group\n  ✖ inner fails (0.1ms)\n✖ group (0.3ms)\nℹ tests 3\n\n✖ failing tests:\n\ntest at t.test.mjs:3:1\n✖ adds (1.3ms)\n'
  assert.deepEqual(failingIn(spec), ['adds', 'inner fails', 'group'])
})

// ---------------------------------------------------------------- runs

test('a passing run writes the raw output to a file, a record verify accepts, and a section computeVerdict accepts', () => {
  const { root, head } = host()
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--section', 'test-record'])
  assert.equal(out.code, 0)
  assert.doesNotMatch(out.stdout, /MARKER-RAW-OUTPUT/)
  const r = out.json
  assert.equal(r.status, 'pass')
  assert.equal(r.exit, 0)
  assert.equal(r.ok, true)
  assert.deepEqual(r.counts, ['# tests 1', '# pass 1', '# fail 0'])
  assert.deepEqual(r.dirty, [])
  assert.match(r.outputFile, new RegExp(`^\\.superpowers/sdd/${CHANGE}/suite/.+\\.txt$`))
  assert.match(readFileSync(join(root, r.outputFile), 'utf8'), /MARKER-RAW-OUTPUT/)
  const record = readFileSync(join(root, r.record), 'utf8')
  assert.match(record, new RegExp(`^# Apply test record\n\n\\*\\*Commit:\\*\\* \`${head}\`\n\\*\\*Command:\\*\\* \`node suite.mjs\``))
  assert.match(record, /# tests 1\n# pass 1/)

  commit(root, { [changeFile('.apply-test-record.md')]: record }, 'record')
  const checks = Object.fromEntries(runChecks(root, { change: CHANGE, now: 'T' }).checks.map((c) => [c.id, c]))
  assert.equal(checks['test-record'].verdict, 'pass')
  assert.equal(r.section.file, `.superpowers/sdd/${CHANGE}/verify/test-record.json`)
  assert.deepEqual([r.section.preExisting, r.section.countWarnings], [[], []])
  judged(root, CHANGE)
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.equal(verdict.refusals, undefined)
  const section = verdict.checks.find((c) => c.id === 'test-record')
  assert.equal(section.verdict, 'pass')
  assert.equal(section.output, `.superpowers/sdd/${CHANGE}/verify/test-record-suite.txt`)
})

// #29: the run leaves a marker, running while it runs and done with its result, so an agent can
// wait for a background run by script and the next apply step knows the run ended.
test('a run writes its marker: running while the suite runs, done with its result after; the base check its own', () => {
  const { root, head } = host({ headMode: 'fail:b' })
  const marker = runMarker(root, CHANGE)
  process.env.ADF_PEEK = marker
  let r
  try {
    r = runSuite(root, { change: CHANGE, baseCheck: true })
  } finally {
    delete process.env.ADF_PEEK
  }
  assert.equal(marker, join(root, '.superpowers', 'sdd', CHANGE, 'suite', 'run.json'))
  const peek = /^PEEK (.*)$/m.exec(readFileSync(join(root, r.outputFile), 'utf8'))[1]
  assert.deepEqual([JSON.parse(peek).state, JSON.parse(peek).pid, JSON.parse(peek).commit], ['running', process.pid, head])
  const done = readMarker(marker)
  assert.deepEqual([done.state, done.exit, done.timedOut, done.status, done.commit, done.outputFile], ['done', 1, false, 'fail', head, r.outputFile])
  assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 0 && done.endedAt >= done.startedAt)
  const base = readMarker(runMarker(root, CHANGE, 'base'))
  assert.deepEqual([base.state, base.exit, base.timedOut], ['done', 0, false])
})

test('wait returns a done run at once and records when it was first read; a repeated wait keeps that time', () => {
  const { root } = host()
  runSuite(root, { change: CHANGE })
  // Read right after the run's end: the idle time is short.
  const out = cli(['wait', '--change', CHANGE, '--root', root])
  assert.equal(out.code, 0)
  assert.deepEqual([out.json.ok, out.json.state, out.json.exit, out.json.timedOut, out.json.status, out.json.already], [true, 'done', 0, false, 'pass', false])
  assert.ok(out.json.readAt >= out.json.endedAt && out.json.idleMs >= 0 && out.json.idleMs < 60000, JSON.stringify(out.json))
  assert.equal(readMarker(runMarker(root, CHANGE)).readAt, out.json.readAt)
  // A repeated wait, once no new run started within its grace, returns the same result and time.
  const again = waitForRun(root, CHANGE, { maxMs: 2000, graceMs: 50, pollMs: 10 })
  assert.deepEqual([again.state, again.already, again.readAt, again.idleMs], ['done', true, out.json.readAt, out.json.idleMs])
  assert.equal(readMarker(runMarker(root, CHANGE)).readAt, out.json.readAt)
  // Read with a delay: the idle time is the gap from the run's end.
  const file = runMarker(root, CHANGE)
  const endedAt = new Date(Date.now() - 120000).toISOString()
  writeFileSync(file, JSON.stringify({ state: 'done', startedAt: endedAt, endedAt, durationMs: 0, pid: 1, exit: 0, timedOut: false, status: 'pass' }))
  const late = waitForRun(root, CHANGE, { maxMs: 2000, pollMs: 10 })
  assert.ok(late.idleMs >= 120000 && late.idleMs < 180000, String(late.idleMs))
  const none = cli(['wait', '--change', CHANGE, '--root', host().root, '--max-minutes', '0.01'])
  assert.deepEqual([none.code, none.json.ok], [1, false])
  assert.match(none.json.error, /no whole-suite run is recorded/)
})

test('wait gives up on a running run before the Bash limit, and calls a run with a dead process or past its time stale', () => {
  const { root } = host()
  const file = runMarker(root, CHANGE)
  mkdirSync(dirname(file), { recursive: true })
  const now = Date.now()
  const running = (over) => writeFileSync(file, JSON.stringify({ state: 'running', startedAt: new Date(now).toISOString(), pid: process.pid, timeoutMs: 60000, ...over }))
  running()
  assert.equal(waitForRun(root, CHANGE, { maxMs: 50, pollMs: 10 }).state, 'running')
  const cliOut = cli(['wait', '--change', CHANGE, '--root', root, '--max-minutes', '0.001'])
  assert.deepEqual([cliOut.code, cliOut.json.state], [3, 'running'])
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  running({ pid: dead })
  assert.equal(isStale(readMarker(file)), true)
  assert.throws(() => waitForRun(root, CHANGE, { maxMs: 1000, pollMs: 10 }), /the whole-suite run died/)
  running({ startedAt: new Date(now - 3 * 3600000).toISOString() })
  assert.equal(isStale(readMarker(file)), true)
  running()
  assert.equal(isStale(readMarker(file)), false)
})

test('a failure the base does not have blocks; the base-check worktree is removed', () => {
  const { main, root } = host({ headMode: 'fail:b' })
  const out = cli(['run', '--change', CHANGE, '--root', root, '--base-check', '--record', '--section', 'test-record'])
  assert.equal(out.code, 1)
  const r = out.json
  assert.equal(r.status, 'fail')
  assert.deepEqual(r.failing, ['b'])
  assert.equal(r.base.exit, 0)
  assert.equal(r.base.removed, true)
  assert.match(r.base.outputFile, /-base\.txt$/)
  assert.deepEqual(r.newFailures, ['b'])
  assert.deepEqual(r.preExisting, [])
  assert.equal(r.blocking, true)
  assert.equal(existsSync(baseCheckPath(main, CHANGE)), false)
  const record = readFileSync(join(root, r.record), 'utf8')
  assert.doesNotMatch(record, /\*\*Commit:\*\*/)
  assert.match(record, /## Failures that block\n\n- b/)
  const section = JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'test-record.json'), 'utf8'))
  assert.equal(section.verdict, 'fail')
  assert.match(section.summary, /does not reproduce on the base: b/)
})

test('a run names the failures the node:test spec reporter prints, not its header', () => {
  const { root } = host({ headMode: 'spec:adds,subtracts' })
  const r = runSuite(root, { change: CHANGE })
  assert.equal(r.status, 'fail')
  assert.deepEqual(r.failing, ['adds', 'subtracts'])
})

test('a failure that also fails on the base is pre-existing; a partial overlap blocks on the rest', () => {
  const same = host({ baseMode: 'fail:a', headMode: 'fail:a' })
  const r = runSuite(same.root, { change: CHANGE, baseCheck: true, record: true, section: 'test-record', now: '2026-10-15T10:00:00.000Z' })
  assert.equal(r.status, 'pre-existing')
  assert.equal(r.ok, true)
  assert.deepEqual(r.preExisting, ['a'])
  assert.equal(r.comparison, 'tests')
  assert.equal(r.outputFile, `.superpowers/sdd/${CHANGE}/suite/2026-10-15T10-00-00-000Z.txt`)
  assert.match(readFileSync(join(same.root, r.record), 'utf8'), /\*\*Commit:\*\*[\s\S]*## Pre-existing failures, separate work\n\n- a/)
  assert.equal(r.section.verdict, 'warn')

  const partial = host({ baseMode: 'fail:a', headMode: 'fail:a,b' })
  const p = runSuite(partial.root, { change: CHANGE, baseCheck: true })
  assert.deepEqual([p.preExisting, p.newFailures, p.blocking], [['a'], ['b'], true])
})

// #54: the base check runs after the main run, on the failed tests alone when the runner can
// select them, so it never doubles the load of a whole run.
test('the base check runs the failed tests alone when the settings give a failed-tests command', () => {
  const { main, root } = host({ baseMode: 'fail:a,c', headMode: 'fail:a,b' })
  withSetting(root, 'failedTestsCommand', 'node suite.mjs {tests}', 'guide')
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.deepEqual(r.base.selected, ['a', 'b'])
  assert.match(readFileSync(join(root, r.base.outputFile), 'utf8'), /^SELECTED a b$/m)
  assert.doesNotMatch(readFileSync(join(root, r.outputFile), 'utf8'), /SELECTED/)
  assert.deepEqual([r.base.failing, r.preExisting, r.newFailures, r.status], [['a'], ['a'], ['b'], 'fail'])
  // A main run that names no failing test leaves nothing to select: the whole command runs.
  const anon = host({ baseMode: 'anon', headMode: 'anon' })
  withSetting(anon.root, 'failedTestsCommand', 'node suite.mjs {tests}', 'guide')
  const whole = runSuite(anon.root, { change: CHANGE, baseCheck: true })
  assert.equal(whole.base.selected, undefined)
  assert.doesNotMatch(readFileSync(join(anon.root, whole.base.outputFile), 'utf8'), /SELECTED/)
})

test('a base that fails at scale on one environment error is environment-broken, never pre-existing', () => {
  const { root } = host({ baseMode: 'env:6', headMode: 'env:7' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true, record: true, section: 'test-record' })
  assert.equal(r.status, 'environment-broken')
  assert.deepEqual([r.ok, r.blocking, r.preExisting], [false, true, []])
  assert.deepEqual(r.environment.signature, { id: 'module-not-found', key: '@w/shared', occurrences: 6, failing: 6 })
  assert.match(r.environment.reason, /the base fails at scale on one environment error: module-not-found @w\/shared, 6 times over 6 failures/)
  const record = readFileSync(join(root, r.record), 'utf8')
  assert.doesNotMatch(record, /\*\*Commit:\*\*/)
  assert.match(record, /\*\*Result:\*\* environment-broken/)
  assert.doesNotMatch(record, /Pre-existing/)
  assert.equal(r.section.verdict, 'not-run')
  assert.match(r.section.summary, /not measured/)

  // Verify reads the record as not run: unmeasured until the developer rules, and then accepted
  // as not run, never as a pass.
  commit(root, { [changeFile('.apply-test-record.md')]: record }, 'record')
  rmSync(verifyDir(root, CHANGE), { recursive: true, force: true })
  const check = runChecks(root, { change: CHANGE, now: 'T' }).checks.find((c) => c.id === 'test-record')
  assert.deepEqual([check.verdict, /the whole suite was not measured/.test(check.summary)], ['not-run', true])
  judged(root, CHANGE)
  assert.deepEqual(computeVerdict(root, { change: CHANGE }).needsRuling, ['test-record'])
  appendRecord(root, CHANGE, 'ruling', { check: 'test-record', reason: 'suite not measured: the environment cannot build the shared package' })
  const ruled = computeVerdict(root, { change: CHANGE }).checks.find((c) => c.id === 'test-record')
  assert.deepEqual([ruled.verdict, ruled.accepted], ['not-run', 'suite not measured: the environment cannot build the shared package'])
})

test('an environment error below the scale stays a pre-existing comparison', () => {
  const { root } = host({ baseMode: 'env:2', headMode: 'env:2' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.equal(r.status, 'pre-existing')
  assert.equal(r.environment, undefined)
})

test('a package suite that ran on neither side is environment-broken', () => {
  const { root } = host({ baseMode: 'turbo:a', headMode: 'turbo:a' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.equal(r.status, 'environment-broken')
  assert.deepEqual(r.environment.notRun, { head: 1, base: 1 })
  assert.match(r.environment.reason, /a package's suite ran on neither side: 1 task\(s\) did not run on the branch, 1 on the base/)
})

test('with no failing names, the comparison is of the whole run', () => {
  const { root } = host({ baseMode: 'anon', headMode: 'anon' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.equal(r.comparison, 'whole-run')
  assert.equal(r.blocking, false)
  assert.match(r.preExisting[0], /the base fails too/)
})

test('a failure with no base check blocks', () => {
  const { root } = host({ headMode: 'fail:a' })
  const r = runSuite(root, { change: CHANGE, section: 'test-record' })
  assert.equal(r.blocking, true)
  assert.equal(r.base, undefined)
  assert.match(r.section.summary, /no base check was made/)
})

test('a base-check worktree git refuses to remove is reported and left', () => {
  const { main, root } = host({ baseMode: 'fail:a+junk', headMode: 'fail:a' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.equal(r.base.removed, false)
  assert.match(r.base.removeError, /git refused to remove/)
  assert.equal(existsSync(baseCheckPath(main, CHANGE)), true)
  rmSync(join(baseCheckPath(main, CHANGE), 'junk.txt'))
  git(main, 'worktree', 'remove', baseCheckPath(main, CHANGE))
})

test('a base-check worktree whose provisioning refused runs nothing, cannot run, and is removed', () => {
  const { main, root } = host({ baseMode: 'fail:a', headMode: 'fail:a' })
  const plugin = realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-plugin-')))
  writeFileSync(join(plugin, 'adf-extension.json'), JSON.stringify({ name: 'no', contract: '1.6', provides: { provision: { script: 'p.mjs', operations: ['provision'] } } }))
  writeFileSync(join(plugin, 'p.mjs'), `console.log(JSON.stringify({ state: 'refused', error: 'no tool' }))`)
  commit(root, { '.claude/adf-extensions.json': `${JSON.stringify({ ...readRegistry(root), extensions: [{ path: plugin, points: ['provision'] }] }, null, 2)}\n` }, 'provider')
  const r = runSuite(root, { change: CHANGE, baseCheck: true, section: 'test-record' })
  assert.equal(r.base.cannotRun, true)
  assert.match(r.base.error, /the base-check worktree is made at .*, but provision refused: no tool/)
  assert.equal(r.base.exit, undefined, 'nothing ran on the base')
  assert.equal(r.base.removed, true)
  assert.equal(existsSync(baseCheckPath(main, CHANGE)), false)
  assert.equal(r.blocking, true)
  assert.match(r.section.summary, /the base check could not run/)
})

// ---------------------------------------------------------------- the fresh-run proof

// The change's settings with `line` as the fresh-run proof, committed.
const withProof = (root, line) => withSetting(root, 'freshRunProof', line, 'proof')

test('a run whose output holds the proof line stands; one that lacks it fails, as maybe cached', () => {
  const fresh = host()
  withProof(fresh.root, 'MARKER-RAW-OUTPUT')
  const ok = runSuite(fresh.root, { change: CHANGE, record: true })
  assert.deepEqual([ok.status, ok.ok, ok.fresh], ['pass', true, true])

  const { root } = host()
  withProof(root, 'Cached:    0 cached')
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--section', 'test-record'])
  assert.equal(out.code, 1)
  const r = out.json
  assert.deepEqual([r.status, r.exit, r.ok, r.fresh, r.blocking], ['fail', 0, false, false, true])
  assert.equal(r.reason, 'the output lacks the fresh-run proof line `Cached:    0 cached` of openspec/settings.json: the run may be cached')
  const record = readFileSync(join(root, r.record), 'utf8')
  assert.doesNotMatch(record, /\*\*Commit:\*\*/, 'a run that may be cached is no record verify cites')
  assert.match(record, /\*\*Fresh-run proof:\*\* the output lacks the fresh-run proof line/)
  assert.deepEqual([r.section.verdict, r.section.summary], ['fail', r.reason])
})

test('a failing run that lacks the proof line is not compared with the base', () => {
  const { root } = host({ baseMode: 'fail:a', headMode: 'fail:a' })
  withProof(root, 'Cached:    0 cached')
  const r = runSuite(root, { change: CHANGE, baseCheck: true })
  assert.deepEqual([r.status, r.blocking, r.base, r.preExisting], ['fail', true, undefined, []])
})

test('a suite that cannot run is a failure, not a pass', () => {
  const { root } = host({ command: 'adf-no-such-command-xyz' })
  const r = runSuite(root, { change: CHANGE, baseCheck: true, section: 'test-record' })
  assert.equal(r.cannotRun, true)
  assert.equal(r.status, 'fail')
  assert.equal(r.base, undefined)
  assert.equal(r.section.verdict, 'fail')
  assert.match(r.section.summary, /cannot run in this workspace/)
})

test('a suite that runs past the timeout is stopped and cannot run, never a pass', () => {
  const { root } = host({ command: 'node -e "setTimeout(() => {}, 60000)"' })
  const started = Date.now()
  const r = runSuite(root, { change: CHANGE, baseCheck: true, record: true, section: 'test-record', timeoutMinutes: 0.01 })
  assert.ok(Date.now() - started < 30000)
  assert.deepEqual([r.status, r.cannotRun, r.timedOut, r.ok, r.base], ['fail', true, true, false, undefined])
  assert.equal(r.section.verdict, 'fail')
  assert.match(r.section.summary, /did not finish within 0\.01 minute/)
  assert.doesNotMatch(readFileSync(join(root, r.record), 'utf8'), /\*\*Commit:\*\*/)
  assert.equal(cli(['run', '--change', CHANGE, '--root', root, '--timeout', '0']).code, 2)
  assert.equal(cli(['run', '--change', CHANGE, '--root', root, '--timeout', 'soon']).code, 2)
})

// The suite runs in a process group of its own, so the timeout stops what the shell started too.
test('a timed-out suite is stopped with its grandchildren', { skip: process.platform === 'win32' }, async () => {
  const { root } = host({ command: "sh -c 'sleep 60 & echo $! > grand.pid; wait'" })
  const r = runSuite(root, { change: CHANGE, timeoutMinutes: 0.01 })
  assert.equal(r.timedOut, true)
  const pid = Number(readFileSync(join(root, 'grand.pid'), 'utf8'))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 40 && alive(); i++) await new Promise((done) => setTimeout(done, 50))
  if (alive()) process.kill(pid, 'SIGKILL')
  assert.equal(alive(), false, `the grandchild ${pid} outlived the timeout`)
})

test('no command in the settings is not-run with the reason, never a pass', () => {
  const { root } = host({ command: null })
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--section', 'test-record'])
  assert.equal(out.code, 1)
  assert.equal(out.json.status, 'not-run')
  assert.match(out.json.reason, /holds no wholeSuiteCommand/)
  assert.equal(out.json.record, undefined, 'no record for a suite that has no command')
  assert.equal(existsSync(join(root, changeFile('.apply-test-record.md'))), false)
  runChecks(root, { change: CHANGE, now: 'T' })
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.equal(verdict.checks.find((c) => c.id === 'test-record').verdict, 'not-run')
  assert.ok(verdict.refusals.some((x) => /^test-record was not run and has no ruling/.test(x)))
})

test('no command in the guide: run --record --commit writes, commits and pushes nothing, and names the remedy', () => {
  const { root } = host({ command: null })
  const head = git(root, 'rev-parse', 'HEAD')
  const status = git(root, 'status', '--porcelain', '--untracked-files=all', '--', 'openspec')
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--commit'])
  assert.deepEqual([out.code, out.json.ok, out.json.status], [1, false, 'not-run'])
  assert.deepEqual([out.json.record, out.json.commit, out.json.push], [undefined, undefined, undefined])
  assert.match(out.json.remedy, /suite\.mjs" set --command "<command>" --root .* --commit/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all', '--', 'openspec'), status)
  assert.equal(existsSync(join(root, `.superpowers/sdd/${CHANGE}/push.json`)), false)
})

test('usage errors exit 2', () => {
  assert.equal(cli([]).code, 2)
  assert.equal(cli(['run']).code, 2)
  assert.equal(cli(['set']).code, 2)
  assert.equal(cli(['run', '--change', 'x', '--section', 'c4']).code, 2)
  assert.equal(cli(['command', '--record']).code, 2)
  assert.equal(cli(['run', '--change', 'nope', '--root', tmpdir()]).code, 1)
})

test('--commit commits the test record, or the settings, alone with the fixed message', () => {
  const { root } = host()
  write(root, 'stray.txt', 'not mine\n')
  assert.equal(cli(['run', '--change', CHANGE, '--root', root, '--commit']).code, 2)
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--commit'])
  assert.equal(out.code, 0)
  assert.equal(out.json.commit, git(root, 'rev-parse', 'HEAD'))
  assert.equal(git(root, 'log', '-1', '--format=%s'), `docs(openspec): record the whole-suite run of ${CHANGE}`)
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), changeFile('.apply-test-record.md'))
  const set = cli(['set', '--root', root, '--command', 'node suite.mjs --all', '--commit'])
  assert.equal(set.code, 0)
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(openspec): record the whole-suite command')
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), 'openspec/settings.json')
  assert.equal(git(root, 'status', '--porcelain', '--', 'stray.txt'), '?? stray.txt')
})

test('run --record --commit pushes the change branch once through the forge role, none with no provider', () => {
  const { root } = host()
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--commit'])
  assert.deepEqual(out.json.push, { state: 'none' })
  const kept = JSON.parse(readFileSync(join(root, `.superpowers/sdd/${CHANGE}/push.json`), 'utf8'))
  assert.deepEqual([kept.state, kept.branch, kept.group], ['none', `feat/${CHANGE}`, undefined])
  assert.equal(cli(['run', '--change', CHANGE, '--root', root, '--record']).json.push, undefined)
})

test('run --record --commit with no branch policy refuses at the commit, before any push: nothing is committed', () => {
  const { root } = host()
  const registry = join(root, '.claude/adf-extensions.json')
  const text = readFileSync(registry, 'utf8')
  writeFileSync(registry, JSON.stringify({ ...JSON.parse(text), branches: undefined }))
  const head = git(root, 'rev-parse', 'HEAD')
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--commit'])
  assert.deepEqual([out.code, out.json.ok, out.json.push], [1, false, undefined])
  assert.match(out.json.error, /no branch policy/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
})

// ---------------------------------------------------------------- covering tests

// What each runner prints at its end, as a fake runner replays it.
const RUNNER_OUTPUT = {
  'node-pass': 'TAP version 13\n# Subtest: adds\nok 1 - adds\n# Subtest: skips\nok 2 - skips # SKIP\n1..2\n# tests 2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 12.5\n',
  'node-fail': 'TAP version 13\n# Subtest: adds\nnot ok 1 - adds\n  ---\n  error: boom\n  ...\nok 2 - subtracts\n1..2\n# tests 2\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 9\n',
  'node-spec': '✔ adds (1.2ms)\n✖ subtracts (0.4ms)\nℹ tests 3\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 1\nℹ duration_ms 30\n',
  jest: 'FAIL src/a.test.js\n  ✕ adds (3 ms)\nPASS src/b.test.js\n\nTest Suites: 1 failed, 1 passed, 2 total\nTests:       1 failed, 1 skipped, 4 passed, 6 total\nSnapshots:   0 total\nTime:        1.2 s\n',
  vitest: ' \u001b[31m×\u001b[39m adds 3ms\n\n\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m (3)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m4 passed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m1 skipped (6)\n',
  none: 'compiling...\nall good, 12 files checked\n'
}

const FAKE_RUNNER = `const outputs = ${JSON.stringify(RUNNER_OUTPUT)}
const mode = process.argv[2]
process.stdout.write(outputs[mode])
process.exit(mode === 'node-pass' || mode === 'none' ? 0 : 1)
`

function coveringHost() {
  const h = host()
  h.head = commit(h.root, { 'runner.cjs': FAKE_RUNNER }, 'runner')
  return h
}

test('counts come from the node:test, Jest and Vitest summaries, and none is null, not a guess', () => {
  assert.deepEqual(countsOf(RUNNER_OUTPUT['node-pass']), { pass: 1, fail: 0, skipped: 1, total: 2 })
  assert.deepEqual(countsOf(RUNNER_OUTPUT['node-fail']), { pass: 1, fail: 1, skipped: 0, total: 2 })
  assert.deepEqual(countsOf(RUNNER_OUTPUT['node-spec']), { pass: 1, fail: 1, skipped: 1, total: 3 })
  assert.deepEqual(countsOf(RUNNER_OUTPUT.jest), { pass: 4, fail: 1, skipped: 1, total: 6 })
  assert.deepEqual(countsOf(RUNNER_OUTPUT.vitest), { pass: 4, fail: 1, skipped: 1, total: 6 })
  assert.equal(countsOf(RUNNER_OUTPUT.none), null)
  assert.equal(countsOf('# tests 4\n'), null)
  // Two runs in one output: the last summary stands.
  assert.deepEqual(countsOf(RUNNER_OUTPUT['node-fail'] + RUNNER_OUTPUT['node-pass']), { pass: 1, fail: 0, skipped: 1, total: 2 })
})

test('a passing covering run writes the raw output and a record readTestRecord accepts', () => {
  const { root, head } = coveringHost()
  const out = cli(['covering', '--change', CHANGE, '--name', 'Task 1 impl', '--command', 'node runner.cjs node-pass', '--worktree', root, '--root', root])
  assert.equal(out.code, 0)
  assert.match(out.json.file, new RegExp(`^\\.superpowers/sdd/${CHANGE}/tests/Task-1-impl-.+\\.json$`))
  assert.equal(out.json.outputFile, out.json.file.replace(/\.json$/, '.txt'))
  const record = readTestRecord(join(root, out.json.file))
  assert.deepEqual(record, { command: 'node runner.cjs node-pass', exit: 0, counts: { pass: 1, fail: 0, skipped: 1, total: 2 }, failing: [], outputFile: out.json.outputFile, worktree: root, sha: head })
  assert.equal(readFileSync(join(root, record.outputFile), 'utf8'), RUNNER_OUTPUT['node-pass'])
})

test('a failing covering run is a record that says so, exit 0', () => {
  const { root } = coveringHost()
  const out = cli(['covering', '--change', CHANGE, '--name', 'task-2-fix', '--command', 'node runner.cjs node-fail', '--worktree', root, '--root', root])
  assert.equal(out.code, 0)
  assert.deepEqual([out.json.ok, out.json.exit, out.json.counts, out.json.failing], [true, 1, { pass: 1, fail: 1, skipped: 0, total: 2 }, ['adds']])
  const jest = runCovering(root, { change: CHANGE, name: 'jest', command: 'node runner.cjs jest', worktree: root })
  assert.deepEqual([jest.exit, jest.counts, jest.failing], [1, { pass: 4, fail: 1, skipped: 1, total: 6 }, ['src/a.test.js', 'adds']])
  const spec = runCovering(root, { change: CHANGE, name: 'spec', command: 'node runner.cjs node-spec', worktree: root })
  assert.deepEqual([spec.exit, spec.counts, spec.failing], [1, { pass: 1, fail: 1, skipped: 1, total: 3 }, ['subtracts']])
})

test('a covering run past the timeout is stopped: exit null, no counts, timedOut', () => {
  const { root } = coveringHost()
  const started = Date.now()
  const r = runCovering(root, { change: CHANGE, name: 'slow', command: 'node -e "console.log(\'# tests 1\'); setTimeout(() => {}, 60000)"', worktree: root, timeoutMinutes: 0.01 })
  assert.ok(Date.now() - started < 30000)
  assert.deepEqual([r.exit, r.counts, r.timedOut], [null, null, true])
  assert.match(r.error, /did not finish within 0\.01 minute/)
  assert.equal(readTestRecord(join(root, r.file)).timedOut, true)
})

test('a covering runner with no count line records counts: null', () => {
  const { root } = coveringHost()
  const r = runCovering(root, { change: CHANGE, name: 'lint', command: 'node runner.cjs none', worktree: root })
  assert.deepEqual([r.exit, r.counts, r.failing], [0, null, []])
  assert.equal(readTestRecord(join(root, r.file)).counts, null)
})

test('covering refuses with exit 1, a usage error exits 2, and readTestRecord rejects a bad record', () => {
  const { root } = coveringHost()
  const args = (over = {}) => ['covering', ...Object.entries({ '--change': CHANGE, '--name': 'n', '--command': 'node runner.cjs none', '--worktree': root, '--root': root, ...over }).flat()]
  assert.equal(cli(args({ '--change': 'nope' })).code, 1)
  assert.equal(cli(args({ '--worktree': join(root, 'missing') })).code, 1)
  assert.equal(cli(args({ '--worktree': tmpdir() })).code, 1)
  assert.equal(cli(args({ '--name': '../x' })).code, 2)
  assert.equal(cli(args({ '--timeout': '0' })).code, 2)
  assert.equal(cli(['covering', '--change', CHANGE, '--root', root]).code, 2)
  assert.equal(cli([...args(), '--record']).code, 2)
  const bad = join(root, 'bad.json')
  writeFileSync(bad, JSON.stringify({ command: 'x', exit: 0, counts: { pass: 1 }, failing: [], outputFile: 'o', worktree: root, sha: 'a'.repeat(40) }))
  assert.throws(() => readTestRecord(bad), /bad\.json: not a test-run record \(counts\)/)
  writeFileSync(bad, 'nope')
  assert.throws(() => readTestRecord(bad), /not a test-run record/)
})

test('a covering command that names the worktree or the main checkout by absolute path is refused', () => {
  const { main, root } = coveringHost()
  const args = (command) => ['covering', '--change', CHANGE, '--name', 'Task 1 impl', '--command', command, '--worktree', root, '--root', root]
  for (const command of [`node ${root}/runner.cjs node-pass`, `node runner.cjs node-pass --config '{"rootDir":"${root}"}'`, `node runner.cjs node-pass --config '{"rootDir":"${main}/apps/x"}'`]) {
    const out = cli(args(command))
    assert.equal(out.code, 1, command)
    assert.match(out.json.error, /absolute path .*use worktree-relative paths/, command)
  }
  assert.throws(() => runCovering(root, { change: CHANGE, name: 'abs', command: `node ${root}/runner.cjs node-pass`, worktree: root }), /worktree-relative/)
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', CHANGE, 'tests')), false, 'a refused command runs nothing')
  // A relative path, and an absolute one outside both trees, run.
  assert.equal(cli(args(`node ./runner.cjs node-pass ${tmpdir()}`)).code, 0)
})
