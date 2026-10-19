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
import { initRegistry } from '../lib/registry.mjs'
import { commandIn, countLines, countsOf, failingIn, readCommand, readTestRecord, runCovering, runSuite, writeCommand } from '../lib/suite.mjs'
import { computeVerdict, runChecks, verifyDir } from '../lib/verify.mjs'
import { create } from '../lib/workspace.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'suite.mjs')
const CHANGE = 'add-x'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const changeFile = (file) => `openspec/changes/${CHANGE}/${file}`

// mode.txt: `pass`, `fail:a,b` (TAP names the failures), `spec:a,b` (the node:test spec reporter
// names them, twice, under its "failing tests:" header), `anon` (fails, names nothing); a
// `+junk` suffix leaves an untracked file behind, which makes git refuse to remove a worktree.
const FAKE_SUITE = `import { readFileSync, writeFileSync } from 'node:fs'
const [mode, extra] = readFileSync('mode.txt', 'utf8').trim().split('+')
if (extra === 'junk') writeFileSync('junk.txt', 'x')
console.log('MARKER-RAW-OUTPUT')
if (mode === 'anon') { console.error('Error: boom'); process.exit(1) }
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
const failing = mode.startsWith('fail:') ? mode.slice(5).split(',') : []
console.log('TAP version 13')
console.log('ok 1 - stays')
failing.forEach((name, i) => console.log('not ok ' + (i + 2) + ' - ' + name))
console.log('# tests ' + (failing.length + 1))
console.log('# pass 1')
console.log('# fail ' + failing.length)
process.exit(failing.length ? 1 : 0)
`

const PLANNING = `# Planning guide

## Whole-suite command

<!-- The one command that runs every test. -->

## Checks that need the developer

<!-- none -->
`

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
// `headMode`. `command: null` leaves the guide's section empty.
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
  write(main, 'openspec/planning.md', PLANNING)
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

// ---------------------------------------------------------------- the planning guide

test('the command reads from a fence, an inline code span or a plain line, never a comment', () => {
  assert.equal(commandIn(PLANNING), null)
  assert.equal(commandIn('## Whole-suite command\n\n```bash\nnpm test -- --no-cache\n```\n'), 'npm test -- --no-cache')
  assert.equal(commandIn('## Whole-suite command\n\n`make test`\n\n## Next\n\nnot this\n'), 'make test')
  assert.equal(commandIn('## Whole-suite command\r\n\r\n<!-- note -->\r\npytest -p no:cacheprovider\r\n'), 'pytest -p no:cacheprovider')
  assert.equal(commandIn('# Guide\n'), null)
  assert.throws(() => commandIn('## Whole-suite command\n\nnpm test\nnpm run e2e\n'), /holds 2 lines; it must hold one command/)
})

test('set writes under the heading, keeps its comment, replaces an earlier command, and creates the file', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-set-')))
  assert.deepEqual(readCommand(root), { file: join(root, 'openspec/planning.md'), command: null, reason: 'openspec/planning.md does not exist' })
  write(root, 'openspec/planning.md', PLANNING)
  assert.match(readCommand(root).reason, /holds no command under ## Whole-suite command/)
  writeCommand(root, 'npm test')
  writeCommand(root, 'npm run test:all')
  const text = readFileSync(join(root, 'openspec/planning.md'), 'utf8')
  assert.equal(text, PLANNING.replace('<!-- The one command that runs every test. -->\n', '<!-- The one command that runs every test. -->\n\n```sh\nnpm run test:all\n```\n'))
  assert.equal(readCommand(root).command, 'npm run test:all')

  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'adf-suite-set-')))
  const out = cli(['set', '--root', bare, '--command', 'go test -count=1 ./...'])
  assert.equal(out.code, 0)
  assert.equal(readFileSync(join(bare, 'openspec/planning.md'), 'utf8'), '## Whole-suite command\n\n```sh\ngo test -count=1 ./...\n```\n')
  assert.deepEqual(cli(['command', '--root', bare]).json, { file: join(bare, 'openspec/planning.md'), command: 'go test -count=1 ./...' })
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
  for (const id of ['c4', 'c8']) {
    write(root, `.superpowers/sdd/${CHANGE}/verify/${id}-agent.txt`, 'agent output\n')
    write(root, `.superpowers/sdd/${CHANGE}/verify/${id}.json`, JSON.stringify({ id, title: id, verdict: 'pass', summary: 's', output: `.superpowers/sdd/${CHANGE}/verify/${id}-agent.txt` }))
  }
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.equal(verdict.refusals, undefined)
  const section = verdict.checks.find((c) => c.id === 'test-record')
  assert.equal(section.verdict, 'pass')
  assert.equal(section.output, `.superpowers/sdd/${CHANGE}/verify/test-record-suite.txt`)
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

test('no command in the guide is not-run with the reason, never a pass', () => {
  const { root } = host({ command: null })
  const out = cli(['run', '--change', CHANGE, '--root', root, '--record', '--section', 'test-record'])
  assert.equal(out.code, 1)
  assert.equal(out.json.status, 'not-run')
  assert.match(out.json.reason, /holds no command/)
  const record = readFileSync(join(root, out.json.record), 'utf8')
  assert.doesNotMatch(record, /\*\*Commit:\*\*/)
  assert.match(record, /The whole suite was not run: .*holds no command/)
  commit(root, { [changeFile('.apply-test-record.md')]: record }, 'record')
  runChecks(root, { change: CHANGE, now: 'T' })
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.equal(verdict.checks.find((c) => c.id === 'test-record').verdict, 'not-run')
  assert.ok(verdict.refusals.some((x) => /^test-record was not run and has no ruling/.test(x)))
})

test('usage errors exit 2', () => {
  assert.equal(cli([]).code, 2)
  assert.equal(cli(['run']).code, 2)
  assert.equal(cli(['set']).code, 2)
  assert.equal(cli(['run', '--change', 'x', '--section', 'c4']).code, 2)
  assert.equal(cli(['command', '--record']).code, 2)
  assert.equal(cli(['run', '--change', 'nope', '--root', tmpdir()]).code, 1)
})

test('--commit commits the test record, or the planning guide, alone with the fixed message', () => {
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
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), 'openspec/planning.md')
  assert.equal(git(root, 'status', '--porcelain', '--', 'stray.txt'), '?? stray.txt')
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
