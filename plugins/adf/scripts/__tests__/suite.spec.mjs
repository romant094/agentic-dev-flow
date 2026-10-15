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
import { commandIn, countLines, failingIn, readCommand, runSuite, writeCommand } from '../lib/suite.mjs'
import { computeVerdict, runChecks, verifyDir } from '../lib/verify.mjs'
import { create } from '../lib/workspace.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'suite.mjs')
const CHANGE = 'add-x'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const changeFile = (file) => `openspec/changes/${CHANGE}/${file}`

// mode.txt: `pass`, `fail:a,b` (TAP names the failures), `anon` (fails, names nothing); a
// `+junk` suffix leaves an untracked file behind, which makes git refuse to remove a worktree.
const FAKE_SUITE = `import { readFileSync, writeFileSync } from 'node:fs'
const [mode, extra] = readFileSync('mode.txt', 'utf8').trim().split('+')
if (extra === 'junk') writeFileSync('junk.txt', 'x')
console.log('MARKER-RAW-OUTPUT')
if (mode === 'anon') { console.error('Error: boom'); process.exit(1) }
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
