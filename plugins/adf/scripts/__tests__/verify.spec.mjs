// verify's mechanical checks and its verdict, against real git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { globToRegExp } from '../lib/changes.mjs'
import { addGroup, baseCheckPath } from '../lib/groups.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { appendRecord, buildRecord } from '../lib/ledger.mjs'
import { initRegistry, readRegistry, validateRegistry, writeRegistry } from '../lib/registry.mjs'
import { computeVerdict, countsIn, deltaState, pathMatcher, plannedPaths, runChecks, verifyDir } from '../lib/verify.mjs'
import { create } from '../lib/workspace.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify.mjs')
const CHANGE = 'add-x'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const REQUIREMENT = `### Requirement: Greeting
The system SHALL greet the user.

#### Scenario: Greets
- **WHEN** the user arrives
- **THEN** the system greets them`

const DELTA = `## ADDED Requirements\n\n${REQUIREMENT}\n`
const MAIN = `# greeting Specification

## Purpose
The greeting capability describes how the system greets every user who arrives.

## Requirements

${REQUIREMENT}
`
const PLAN = `# Plan

### Task 1: Greet

**Files:**
- Create: \`src/a.mjs\`
- Modify: \`lib/\`
- Modify: \`src/late.mjs\` — Added during apply, 2026-10-15: a fix round

**Steps:**
- [ ] write it
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

const changeFile = (file) => `openspec/changes/${CHANGE}/${file}`

// A host on develop with a synced main spec, and one complete change in its own worktree: a
// code commit in the plan, then the apply test record naming that commit.
function host({ outsidePlan, plan = PLAN, tasks = '- [x] 1.1 greet\n', record = true } = {}) {
  const main = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-verify-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', main])
  git(main, 'config', 'user.email', 't@example.com')
  git(main, 'config', 'user.name', 'T')
  initRegistry(main, '1.2')
  setBranches(main, { integration: 'develop', protected: [] })
  if (outsidePlan) writeRegistry(main, { ...readRegistry(main), outsidePlan })
  ignoreLocalDirs(main)
  write(main, 'openspec/specs/greeting/spec.md', MAIN)
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'init')
  const root = create(main, { change: CHANGE, branch: `feat/${CHANGE}`, base: 'integration' }).root
  commit(root, {
    [changeFile('.adf.json')]: `${JSON.stringify({ schema: 'adf', base: 'develop' })}\n`,
    [changeFile('proposal.md')]: '# Proposal\n',
    [changeFile('specs/greeting/spec.md')]: DELTA,
    [changeFile('tasks.md')]: tasks,
    [changeFile('plan.md')]: plan
  }, 'propose')
  const code = commit(root, { 'src/a.mjs': 'export const a = 1\n' })
  if (record) commit(root, { [changeFile('.apply-test-record.md')]: `**Commit:** \`${code}\`\n\n# tests 4\n# pass 4\n` }, 'record')
  return { main, root }
}

const byId = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c]))
const runIn = (root, opts = {}) => byId(runChecks(root, { change: CHANGE, now: 'T', ...opts }))

function reply(root, name, value) {
  write(root, `.superpowers/sdd/${CHANGE}/replies/${name}.json`, JSON.stringify(value))
}

const impl = (summary) => ({ role: 'impl', status: 'DONE', commits: [], tests: { command: 'npm test', result: 'pass', summary }, concerns: [], report: 'r' })

function section(root, id, verdict, { output = `.superpowers/sdd/${CHANGE}/verify/${id}-agent.txt`, writeOutput = true } = {}) {
  if (writeOutput) write(root, output, 'agent output\n')
  write(root, `.superpowers/sdd/${CHANGE}/verify/${id}.json`, JSON.stringify({ id, title: `Agent ${id}`, verdict, summary: `${id} summary`, output }))
}

test('a complete change passes every check, and each check leaves its output and run.json', () => {
  const { root } = host()
  const result = runChecks(root, { change: CHANGE, now: 'T' })
  assert.deepEqual(
    result.checks.map((c) => [c.id, c.verdict]),
    [['validation', 'pass'], ['tasks', 'pass'], ['deltas', 'pass'], ['tree', 'pass'], ['test-record', 'pass'], ['worktrees', 'pass'], ['out-of-plan', 'pass']]
  )
  assert.equal(result.ok, true)
  assert.equal(result.base, 'develop')
  assert.deepEqual(result.checks[2], {
    id: 'deltas',
    title: 'Delta spec sync state',
    verdict: 'pass',
    summary: 'already synced: greeting',
    output: `.superpowers/sdd/${CHANGE}/verify/deltas.txt`
  })
  for (const c of result.checks) assert.equal(existsSync(join(root, c.output)), true, c.id)
  assert.match(readFileSync(join(root, result.checks[3].output), 'utf8'), /range develop\.\.HEAD:\n.* record\n.* src\/a\.mjs\n.* propose/)
  assert.deepEqual(JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'run.json'), 'utf8')).checks, result.checks)
  assert.deepEqual(computeVerdict(root, { change: CHANGE }).line, 'Verdict: PASS')
})

test('a fresh run deletes the sections of an earlier session; a later run keeps them', () => {
  const { root } = host()
  section(root, 'c4', 'fail')
  runChecks(root, { change: CHANGE, now: 'T' })
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'c4.json')), true)
  runChecks(root, { change: CHANGE, now: 'T', fresh: true })
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'c4.json')), false)
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'run.json')), true)
})

test('validation fails on this change only; the corpus is advisory text', () => {
  const { root } = host()
  commit(root, { [changeFile('specs/greeting/spec.md')]: DELTA.replace('SHALL ', '') })
  write(root, 'openspec/changes/other/proposal.md', '# other\n')
  write(root, 'openspec/changes/other/specs/x/spec.md', 'nothing\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'other change')
  const checks = runIn(root)
  assert.equal(checks.validation.verdict, 'fail')
  assert.equal(checks.validation.summary, 'add-x has 1 validation issue')
  const output = readFileSync(join(root, checks.validation.output), 'utf8')
  assert.match(output, /ERROR greeting\/spec\.md: .*SHALL or MUST/)
  assert.match(output, /advisory, the rest of the corpus \(strict\): 1 invalid\n {2}change other/)

  const clean = host()
  write(clean.root, 'openspec/changes/other/proposal.md', '# other\n')
  assert.equal(runIn(clean.root).validation.verdict, 'pass', 'another invalid change does not fail this one')
})

test('tasks fails and names every open item', () => {
  const { root } = host({ tasks: '- [x] 1.1 greet\n- [ ] 1.2 wave\n- [ ] 1.3 bow\n' })
  const checks = runIn(root)
  assert.equal(checks.tasks.verdict, 'fail')
  assert.equal(checks.tasks.summary, '2 of 3 tasks open')
  assert.equal(readFileSync(join(root, checks.tasks.output), 'utf8'), '1 of 3 ticked\nopen: 1.2 wave\nopen: 1.3 bow\n')
})

test('deltas warns on a capability still to sync and fails on one archive cannot merge', () => {
  const { root } = host()
  commit(root, { [changeFile('specs/farewell/spec.md')]: DELTA.replace(/Greeting/g, 'Farewell') })
  let checks = runIn(root)
  assert.equal(checks.deltas.verdict, 'warn')
  assert.equal(checks.deltas.summary, 'needs sync, expected before archive: farewell')
  assert.match(readFileSync(join(root, checks.deltas.output), 'utf8'), /farewell: needs sync \(no main spec yet\)\n {2}ADDED Farewell/)

  commit(root, { [changeFile('specs/greeting/spec.md')]: `## MODIFIED Requirements\n\n${REQUIREMENT.replace('Greeting', 'Absent')}\n` })
  checks = runIn(root)
  assert.equal(checks.deltas.verdict, 'fail')
  assert.equal(checks.deltas.summary, 'cannot be merged at archive: greeting')
})

test('deltaState reads renames, removals and modifications against the main spec', () => {
  const renamed = `## RENAMED Requirements\n\n- FROM: \`### Requirement: Greeting\`\n- TO: \`### Requirement: Welcome\`\n`
  assert.deepEqual(deltaState(renamed, MAIN), { state: 'needs sync', pending: ['RENAMED Greeting -> Welcome'], conflicts: [] })
  assert.equal(deltaState(renamed, MAIN.replace('Requirement: Greeting', 'Requirement: Welcome')).state, 'synced')
  assert.equal(deltaState(`## REMOVED Requirements\n\n### Requirement: Greeting\n`, MAIN).state, 'needs sync')
  assert.equal(deltaState(`## REMOVED Requirements\n\n### Requirement: Gone\n`, MAIN).state, 'synced')
  assert.equal(deltaState(`## MODIFIED Requirements\n\n${REQUIREMENT}\n`, MAIN).state, 'synced')
  assert.deepEqual(deltaState(`## MODIFIED Requirements\n\n${REQUIREMENT.replace('greet the', 'welcome the')}\n`, MAIN).pending, ['MODIFIED Greeting'])
  assert.deepEqual(deltaState(`## ADDED Requirements\n\n${REQUIREMENT.replace('greet the', 'welcome the')}\n`, MAIN).conflicts, [
    'ADDED Greeting: the main spec already holds it with other text'
  ])
})

test('tree fails on an uncommitted file and on an empty range', () => {
  const { root } = host()
  write(root, 'stray.txt', 'x\n')
  let checks = runIn(root)
  assert.equal(checks.tree.verdict, 'fail')
  assert.equal(checks.tree.summary, '1 uncommitted path(s)')
  rmSync(join(root, 'stray.txt'))

  commit(root, { [changeFile('.adf.json')]: `${JSON.stringify({ schema: 'adf', base: 'later' })}\n` })
  git(root, 'branch', 'later', 'HEAD')
  checks = runIn(root)
  assert.equal(checks.tree.verdict, 'fail')
  assert.equal(checks.tree.summary, 'the range later..HEAD is empty')
})

test('test-record: a code commit after the record is stale; a change-directory commit is not', () => {
  const { root } = host()
  commit(root, { [changeFile('notes.md')]: 'docs only\n' })
  assert.equal(runIn(root)['test-record'].verdict, 'pass')

  const late = commit(root, { 'src/late.mjs': 'export const late = 1\n' })
  const check = runIn(root)['test-record']
  assert.equal(check.verdict, 'fail')
  assert.equal(check.summary, 'stale: re-run the suite')
  assert.match(readFileSync(join(root, check.output), 'utf8'), new RegExp(`outside openspec/changes/add-x/: 1\n {2}${late}\n {4}src/late\\.mjs`))
})

test('test-record fails with no record and with a record naming no commit', () => {
  const { root } = host({ record: false })
  assert.equal(runIn(root)['test-record'].summary, 'no apply test record: run the suite')
  commit(root, { [changeFile('.apply-test-record.md')]: 'The suite passed.\n' })
  assert.equal(runIn(root)['test-record'].summary, 'the apply test record names no commit: run the suite')
})

test('test-record warns on an impl or fix reply with no count, or one the record contradicts', () => {
  const { root } = host()
  reply(root, 'impl-task-1', impl('4 passed'))
  reply(root, 'review-task-1', { role: 'review', verdict: 'pass', findings: [] })
  assert.equal(runIn(root)['test-record'].verdict, 'pass')

  reply(root, 'impl-task-2', impl('PASS'))
  reply(root, 'fix-task-2', { ...impl('17 tests passed'), role: 'fix' })
  const check = runIn(root)['test-record']
  assert.equal(check.verdict, 'warn')
  assert.equal(check.summary.endsWith('2 test count warning(s)'), true)
  const output = readFileSync(join(root, check.output), 'utf8')
  assert.match(output, /impl-task-2\.json: the test summary "PASS" carries no count/)
  assert.match(output, /fix-task-2\.json: the test summary "17 tests passed" counts more than the apply record \(4\)/)
  assert.doesNotMatch(output, /impl-task-1/)
})

test('countsIn reads the shapes a runner summary takes', () => {
  assert.deepEqual(countsIn('15 passed, 0 failed'), [15, 0])
  assert.deepEqual(countsIn('PASS (15)'), [15])
  assert.deepEqual(countsIn('# tests 4\n# pass 4'), [4, 4])
  assert.deepEqual(countsIn('3/3 suites'), [3])
  assert.deepEqual(countsIn('all green on node 20'), [])
})

test('worktrees fails on this change group and its base check, never on another change', () => {
  const { root } = host()
  addGroup(root, { change: 'add-y', group: 1 })
  assert.equal(runIn(root).worktrees.verdict, 'pass')

  const mine = addGroup(root, { change: CHANGE, group: 2 })
  let check = runIn(root).worktrees
  assert.equal(check.verdict, 'fail')
  assert.equal(check.summary, `1 leftover worktree(s): ${mine.root}`)
  git(root, 'worktree', 'remove', mine.root)

  git(root, 'worktree', 'add', '--detach', baseCheckPath(root, CHANGE), 'develop')
  check = runIn(root).worktrees
  assert.equal(check.verdict, 'fail')
  assert.equal(check.summary, `1 leftover worktree(s): ${baseCheckPath(root, CHANGE)}`)
})

test('out-of-plan reports a file no task names, with the sha', () => {
  const { root } = host()
  commit(root, { 'lib/inner/b.mjs': 'b\n', 'src/late.mjs': 'late\n' }, 'in plan: a directory and an Added during apply line')
  assert.equal(runIn(root)['out-of-plan'].verdict, 'pass')
  const sha = commit(root, { 'docs/notes.md': 'n\n' })
  const check = runIn(root)['out-of-plan']
  assert.equal(check.verdict, 'fail')
  assert.equal(check.summary, '1 file(s) outside every task: docs/notes.md')
  assert.match(readFileSync(join(root, check.output), 'utf8'), new RegExp(`${sha} docs/notes\\.md \\(no task names it\\)`))
})

test('out-of-plan skips the registry outsidePlan globs', () => {
  const { root } = host({ outsidePlan: ['docs/**', '*.log'] })
  commit(root, { 'docs/deep/notes.md': 'n\n', 'run.log': 'l\n' })
  assert.equal(runIn(root)['out-of-plan'].verdict, 'pass')
  commit(root, { 'logs/run.log': 'l\n' })
  assert.equal(runIn(root)['out-of-plan'].summary, '1 file(s) outside every task: logs/run.log')
})

test('out-of-plan exempts an approved skill edit only for its files under .claude/skills/', () => {
  const { root } = host()
  const sha = commit(root, { '.claude/skills/s/SKILL.md': 'skill\n' })
  assert.equal(runIn(root)['out-of-plan'].summary, '1 file(s) outside every task: .claude/skills/s/SKILL.md')
  assert.equal(runIn(root, { skillEdits: [sha.slice(0, 8)] })['out-of-plan'].verdict, 'pass')

  const mixed = commit(root, { '.claude/skills/s/README.md': 'r\n', 'other.txt': 'o\n' })
  const check = runIn(root, { skillEdits: [sha, mixed] })['out-of-plan']
  assert.equal(check.summary, '1 file(s) outside every task: other.txt')
  assert.match(readFileSync(join(root, check.output), 'utf8'), /other\.txt \(an approved skill edit touched a file outside \.claude\/skills\/\)/)
  assert.throws(() => runChecks(root, { change: CHANGE, skillEdits: ['0000000'] }), /--skill-edit 0000000 is not a commit/)
})

test('out-of-plan warns naming an unparsed Files bullet', () => {
  const { root } = host({ plan: PLAN.replace('- Modify: `lib/`', '- Modify: lib/ without backticks\n- Modify: `lib/`') })
  const check = runIn(root)['out-of-plan']
  assert.equal(check.verdict, 'warn')
  assert.equal(check.summary, 'every file is in the plan; unparsed Files bullets: Task 1: - Modify: lib/ without backticks')
})

test('plannedPaths takes every backticked path of a Files bullet, past prose and parentheses', () => {
  const plan = `### Task 1: t

**Files:**
- Test: \`src/a/__tests__/x.spec.ts\` (per-model cases), \`src/b/y.spec.ts\`, \`src/c/\`
- Modify: \`src/m/ry-lgso38-10.ts\`, \`src/m/base.ts:12-30\` — seeds (lines 4-9)
- Create: \`forms/a/poe-ports.json\`, \`poe-common.json\`
- Move: \`old/dir/\` → \`new/dir/\` (via \`git mv\`)
- Delete: none.
- Modify: lib/ without backticks

### Task 2: u

**Files:**
- Revert: commits of task 1
`
  const { tasks, paths, unparsed } = plannedPaths(plan)
  assert.equal(tasks, 2)
  assert.deepEqual(paths, [
    'src/a/__tests__/x.spec.ts', 'src/b/y.spec.ts', 'src/c/', 'src/m/ry-lgso38-10.ts', 'src/m/base.ts',
    'forms/a/poe-ports.json', 'forms/a/poe-common.json', 'poe-common.json', 'old/dir/', 'new/dir/'
  ])
  assert.deepEqual(unparsed, [{ task: 1, line: '- Modify: lib/ without backticks' }])
})

test('a placeholder segment of a planned path matches any name in that segment', () => {
  for (const entry of ['prisma/migrations/<timestamp>_add_x/migration.sql', 'prisma/migrations/YYYYMMDDHHMMSS_add_x/migration.sql']) {
    const covers = pathMatcher(entry)
    assert.equal(covers('prisma/migrations/20261007120209_add_x/migration.sql'), true, entry)
    assert.equal(covers('prisma/migrations/20261007120209_add_y/migration.sql'), false, entry)
    assert.equal(covers('prisma/migrations/2026/10_add_x/migration.sql'), false, entry)
  }
  assert.equal(pathMatcher('src/MMIO/a.ts')('src/x/a.ts'), false)
  assert.equal(pathMatcher('lib/')('lib/inner/b.mjs'), true)
})

test('out-of-plan covers a path listed after a parenthesis and a placeholder path', () => {
  const plan = PLAN.replace('- Modify: `lib/`', '- Modify: `lib/` (helpers), `docs/notes.md`\n- Create: `db/<timestamp>_init/up.sql`')
  const { root } = host({ plan })
  commit(root, { 'docs/notes.md': 'n\n', 'db/20261015_init/up.sql': 's\n' })
  assert.equal(runIn(root)['out-of-plan'].verdict, 'pass')
})

test('verdict: warnings, agent sections, and the refusals', () => {
  const { root } = host()
  assert.throws(() => computeVerdict(root, { change: CHANGE }), /no \.superpowers\/sdd\/add-x\/verify\/run\.json/)
  runChecks(root, { change: CHANGE })
  section(root, 'c4', 'warn')
  let result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.verdict, 'PASS WITH WARNINGS')
  assert.deepEqual(result.checks.at(-1), { id: 'c4', title: 'Agent c4', verdict: 'warn', summary: 'c4 summary', output: `.superpowers/sdd/${CHANGE}/verify/c4-agent.txt`, display: 'WARN' })

  section(root, 'c8', 'fail', { writeOutput: false })
  result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.ok, false)
  assert.deepEqual(result.refusals, [`c8.json: its output file .superpowers/sdd/${CHANGE}/verify/c8-agent.txt does not exist`])

  section(root, 'c8', 'not-run')
  assert.deepEqual(computeVerdict(root, { change: CHANGE }).refusals, ['c8 was not run and has no ruling: c8 summary'])

  section(root, 'c8', 'fail')
  assert.equal(computeVerdict(root, { change: CHANGE }).line, 'Verdict: FAIL')
  section(root, 'tree', 'pass')
  assert.match(computeVerdict(root, { change: CHANGE }).refusals[0], /^tree\.json: tree is a script check/)
})

test('verdict: a ruling accepts a failing check; silence and a ruling on tree do not', () => {
  const { root } = host()
  commit(root, { 'docs/notes.md': 'n\n' })
  write(root, 'stray.txt', 'x\n')
  runChecks(root, { change: CHANGE })
  let result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.verdict, 'FAIL')
  assert.deepEqual(result.failing, ['tree', 'test-record', 'out-of-plan'])

  const env = {}
  appendRecord(root, CHANGE, 'ruling', { check: 'out-of-plan', reason: 'the notes belong to no task' }, { env })
  appendRecord(root, CHANGE, 'ruling', { check: 'tree', reason: 'it is only a stray file' }, { env })
  appendRecord(root, CHANGE, 'ruling', { finding: 'other', decision: 'kept' }, { env })
  result = computeVerdict(root, { change: CHANGE })
  assert.deepEqual(result.failing, ['tree', 'test-record'])
  const oop = result.checks.find((c) => c.id === 'out-of-plan')
  assert.equal(oop.display, 'FAIL, accepted by the developer: the notes belong to no task')
  assert.equal(oop.ruling, 'ruling-1')
  assert.deepEqual(result.ignoredRulings, [{ id: 'ruling-2', check: 'tree', reason: 'tree cannot be accepted by a ruling' }])

  rmSync(join(root, 'stray.txt'))
  runChecks(root, { change: CHANGE })
  section(root, 'test-record', 'pass')
  result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.line, 'Verdict: PASS WITH WARNINGS')
  assert.equal(result.checks.find((c) => c.id === 'test-record').title, 'Agent test-record')
})

test('the CLI prints one JSON object: exit 0 on a pass, 1 on a failing check, 2 on a usage error', () => {
  const { root } = host()
  const cli = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
  let proc = cli('run', '--change', CHANGE, '--root', root)
  assert.equal(proc.status, 0)
  assert.equal(JSON.parse(proc.stdout).checks.length, 7)
  const out = join(root, '.superpowers', 'sdd', CHANGE, 'verdict.json')
  proc = cli('verdict', '--change', CHANGE, '--root', root, '--out', out)
  assert.equal(JSON.parse(proc.stdout).line, 'Verdict: PASS')
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(proc.stdout))
  assert.equal(cli('run', '--change', CHANGE, '--root', root, '--out', out).status, 2)
  write(root, 'stray.txt', 'x\n')
  assert.equal(cli('verdict', '--change', CHANGE, '--root', root).status, 0, 'verdict reads the saved run')
  assert.equal(cli('run', '--change', CHANGE, '--root', root).status, 1)
  assert.equal(cli('verdict', '--change', CHANGE, '--root', root).status, 1)
  proc = cli('check', '--change', CHANGE)
  assert.equal(proc.status, 2)
  assert.match(JSON.parse(proc.stdout).usage, /^usage: verify\.mjs run/)
  assert.equal(cli('run', '--change').status, 2)
  assert.equal(cli('verdict', '--change', CHANGE, '--root', root, '--skill-edit', 'abc').status, 2)
})

test('the ledger takes a check ruling and refuses a malformed one', () => {
  const record = buildRecord('ruling', { check: 'out-of-plan', reason: 'why' }, { now: 'T' })
  assert.deepEqual(record, { id: 'ruling-1', kind: 'ruling', at: 'T', check: 'out-of-plan', reason: 'why' })
  assert.throws(() => buildRecord('ruling', { check: 'out-of-plan' }), /ruling needs --reason/)
  assert.throws(() => buildRecord('ruling', { check: 'Out Of Plan', reason: 'r' }), /--check must be a check id/)
  assert.throws(() => buildRecord('ruling', { check: 'tree', reason: 'r', finding: 'f' }), /ruling takes no --finding; it takes --check, --reason/)
  assert.equal(buildRecord('ruling', { finding: 'f', decision: 'd' }, { now: 'T' }).finding, 'f', 'the adjudication shape is unchanged')
})

test('the registry accepts an optional outsidePlan list of relative globs', () => {
  const base = { contract: '1.2', extensions: [] }
  assert.deepEqual(validateRegistry({ ...base, outsidePlan: ['.claude-reports/**'] }), [])
  const refusal = ['outsidePlan must be a list of glob patterns relative to the project root']
  assert.deepEqual(validateRegistry({ ...base, outsidePlan: '.claude-reports/**' }), refusal)
  assert.deepEqual(validateRegistry({ ...base, outsidePlan: ['/abs/**'] }), refusal)
  assert.deepEqual(validateRegistry({ ...base, outsidePlan: ['../up/**'] }), refusal)
  assert.deepEqual(validateRegistry({ ...base, outsidePlan: [''] }), refusal)
})

test('globToRegExp: ** spans directories, * and ? stay in one segment', () => {
  assert.equal(globToRegExp('.claude-reports/**').test('.claude-reports/a/b.md'), true)
  assert.equal(globToRegExp('docs/**/*.md').test('docs/a.md'), true)
  assert.equal(globToRegExp('*.log').test('logs/run.log'), false)
  assert.equal(globToRegExp('?.log').test('a.log'), true)
  assert.equal(globToRegExp('specs/**/*.md').test('specs/x/spec.md'), true)
})
