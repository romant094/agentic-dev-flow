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
import { assemble, changedTerms, computeVerdict, countsIn, deltaState, pathMatcher, plannedPaths, renderReport, runChecks, skillCandidates, skillEdit, verifyDir, writeDeveloper } from '../lib/verify.mjs'
import { create } from '../lib/workspace.mjs'
import { runCovering, writeCommand } from '../lib/suite.mjs'
import { recordReply } from '../lib/attempts.mjs'
import { CONTRADICTION, c4Reply, c8Reply, DRIFT, judge, judged as judgedIn } from './verify-replies.mjs'
import { run as verifyCli } from '../verify.mjs'
import { run as dispatchCli } from '../dispatch.mjs'
import { checkVerifyReply, FAIL_KINDS, proseEditsIn, WARN_KINDS } from '../lib/verify-reply.mjs'
import { writeSpecsBase } from '../lib/specs.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(SCRIPTS, 'verify.mjs')
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
function host({ outsidePlan, extensions, plan = PLAN, tasks = '- [x] 1.1 greet\n', record = true } = {}) {
  const main = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-verify-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', main])
  git(main, 'config', 'user.email', 't@example.com')
  git(main, 'config', 'user.name', 'T')
  initRegistry(main, '1.2')
  setBranches(main, { integration: 'develop', protected: [] })
  if (outsidePlan) writeRegistry(main, { ...readRegistry(main), outsidePlan })
  if (extensions) writeRegistry(main, { ...readRegistry(main), extensions })
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

// An accepted impl or fix reply whose covering run printed `out`: the test-run record runCovering
// writes and the valid event dispatch.mjs reply records, with the computed result's tests.
function implRun(root, name, out, status = 'DONE') {
  const printed = join(mkdtempSync(join(tmpdir(), 'adf-out-')), 'out.txt')
  writeFileSync(printed, out ?? '')
  const run = out === null ? null : runCovering(root, { change: CHANGE, name, command: `cat "${printed}"`, worktree: root })
  const runs = run ? [{ file: run.file, command: run.command, exit: run.exit, counts: run.counts, failing: run.failing }] : []
  recordReply(root, CHANGE, { name, file: join(root, `.superpowers/sdd/${CHANGE}/replies/${name.replace(/ /g, '-')}.json`), result: { status, tests: { result: run ? 'pass' : null, counts: run?.counts ?? null, runs } } })
}

function section(root, id, verdict, { output = `.superpowers/sdd/${CHANGE}/verify/${id}-agent.txt`, writeOutput = true } = {}) {
  if (writeOutput) write(root, output, 'agent output\n')
  write(root, `.superpowers/sdd/${CHANGE}/verify/${id}.json`, JSON.stringify({ id, title: `Agent ${id}`, verdict, summary: `${id} summary`, output }))
}

// The two judgement sections every verdict needs, as passes, from recorded replies.
const judged = (root) => judgedIn(root, CHANGE)

test('a complete change passes every check, and each check leaves its output and run.json', () => {
  const { root } = host()
  const result = runChecks(root, { change: CHANGE, now: 'T' })
  assert.deepEqual(
    result.checks.map((c) => [c.id, c.verdict]),
    [['validation', 'pass'], ['tasks', 'pass'], ['deltas', 'pass'], ['specs-base', 'pass'], ['tree', 'pass'], ['test-record', 'pass'], ['worktrees', 'pass'], ['out-of-plan', 'pass']]
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
  assert.match(readFileSync(join(root, result.checks.find((c) => c.id === 'tree').output), 'utf8'), /range develop\.\.HEAD:\n.* record\n.* src\/a\.mjs\n.* propose/)
  assert.deepEqual(JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'run.json'), 'utf8')).checks, result.checks)
  judged(root)
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
  assert.equal(readFileSync(join(root, checks.tasks.output), 'utf8'), '1 of 3 ticked\nopen: 1.2 wave\nopen: 1.3 bow\nscope: the change has no scope.json; no key to map\n')
})

const scopeOf = (items, tracker = { state: 'done', plugin: 't' }) => JSON.stringify({ version: 1, change: CHANGE, tracker, items })

test('tasks fails a taken or partial scope key that no task names, and names the tasks that do', () => {
  const { root } = host({ tasks: '- [x] 1.1 greet the user (PROJ-1)\n- [x] 1.2 wave for snmp-01\n' })
  const items = [
    { source: 'tracker', key: 'PROJ-1', state: 'taken' },
    { source: 'tracker', key: 'PROJ-12', state: 'partial' },
    { source: 'debt', key: 'snmp-01', state: 'taken' },
    { source: 'tracker', key: 'PROJ-3', state: 'excluded', reason: 'later' }
  ]
  commit(root, { [changeFile('scope.json')]: scopeOf(items) })
  const checks = runIn(root)
  assert.equal(checks.tasks.verdict, 'fail')
  assert.equal(checks.tasks.summary, 'all 2 tasks ticked; 1 scope key(s) no task names: PROJ-12')
  assert.equal(
    readFileSync(join(root, checks.tasks.output), 'utf8'),
    '2 of 2 ticked\nscope: PROJ-1 (taken) named by 1.1\nscope: PROJ-12 (partial) named by no task\nscope: snmp-01 (taken) named by 1.2\n'
  )
  commit(root, { [changeFile('tasks.md')]: '- [x] 1.1 greet the user (PROJ-1)\n- [x] 1.2 wave for snmp-01\n- [x] 1.3 the rest of PROJ-12\n' })
  assert.equal(runIn(root).tasks.verdict, 'pass')
})

test('tasks passes a scope whose tracker was skipped, with a note', () => {
  const { root } = host({ tasks: '- [x] 1.1 greet\n' })
  commit(root, { [changeFile('scope.json')]: scopeOf([], { state: 'skipped', reason: 'no token today' }) })
  const checks = runIn(root)
  assert.equal(checks.tasks.verdict, 'pass')
  assert.equal(readFileSync(join(root, checks.tasks.output), 'utf8'), '1 of 1 ticked\nscope: the tracker was skipped for this change (no token today); no tracker key to map\n')
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

test('test-record warns on an impl or fix covering run with no count line, or one the record contradicts', () => {
  const { root } = host()
  implRun(root, 'T1 impl', '# tests 4\n# pass 4\n')
  recordReply(root, CHANGE, { name: 'T1 review', file: 'r.json', result: { result: 'clean' } })
  implRun(root, 'T3 impl', null, 'BLOCKED')
  assert.equal(runIn(root)['test-record'].verdict, 'pass')

  implRun(root, 'T2 impl', 'all green\n')
  implRun(root, 'T2 fix r1', '# tests 17\n# pass 17\n')
  implRun(root, 'T4 impl', null)
  recordReply(root, CHANGE, { name: 'T5 impl', file: 'x.json', errors: ['$.commits: required'] })
  const check = runIn(root)['test-record']
  assert.equal(check.verdict, 'warn')
  assert.equal(check.summary.endsWith('3 test count warning(s)'), true)
  const output = readFileSync(join(root, check.output), 'utf8')
  assert.match(output, /test counts: 5 impl\/fix replies read/)
  assert.match(output, /T2 impl: the covering run \.superpowers\/sdd\/add-x\/tests\/T2-impl-[^ ]+\.json printed no count line/)
  assert.match(output, /T2 fix r1: the covering run [^ ]+ counts 17 tests, more than the apply record \(4\)/)
  assert.match(output, /T4 impl: the reply names no covering test run/)
  assert.doesNotMatch(output, /T1 impl|T3 impl|T5 impl/)
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

test('out-of-plan allows the paths the knowledge provider declares, and says when there is none', () => {
  const { root } = host()
  commit(root, { '.claude/memory/log.md': '# Log\n', '.claude/memory/concepts/x.md': '# X\n' })
  let check = runIn(root)['out-of-plan']
  assert.equal(check.summary, '2 file(s) outside every task: .claude/memory/concepts/x.md, .claude/memory/log.md')
  assert.match(readFileSync(join(root, check.output), 'utf8'), /^knowledge paths: none \(knowledge role none\)$/m)
  // The registry change stays uncommitted: out-of-plan reads commits only.
  const memory = join(SCRIPTS, '..', '..', 'adf-memory')
  writeRegistry(root, { ...readRegistry(root), extensions: [{ path: memory }] })
  check = runIn(root)['out-of-plan']
  assert.equal(check.verdict, 'pass')
  assert.match(readFileSync(join(root, check.output), 'utf8'), /^knowledge paths: \.claude\/memory\/\*\*$/m)
  commit(root, { 'notes/elsewhere.md': 'n\n' })
  assert.equal(runIn(root)['out-of-plan'].summary, '1 file(s) outside every task: notes/elsewhere.md')
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

test('plannedPaths takes the path a bullet names right after its verb, and dotfiles, whatever their shape', () => {
  const plan = ['### Task 1: env', '', '**Files:**', '- Modify: `./.env.example` - one flag', '- Modify: `Dockerfile`', '- Create: `src/a.ts` (exports `helper`)', '- Test: `.gitignore` and `notes`', ''].join('\n')
  const { paths, unparsed } = plannedPaths(plan)
  assert.deepEqual(paths, ['.env.example', 'Dockerfile', 'src/a.ts', '.gitignore'])
  assert.deepEqual(unparsed, [])
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
  judge(root, CHANGE, 'c4', c4Reply({ findings: [DRIFT], summary: 'one drift' }))
  let result = computeVerdict(root, { change: CHANGE })
  assert.deepEqual(result.refusals, ['c8.json is missing: the verify c8 dispatch has not written its section'])
  assert.deepEqual(result.redispatch, ['c8'])
  const c8 = judge(root, CHANGE, 'c8')
  result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.verdict, 'PASS WITH WARNINGS')
  const reply = `.superpowers/sdd/${CHANGE}/replies/verify-c4.json`
  assert.deepEqual(result.checks.find((c) => c.id === 'c4'), {
    id: 'c4',
    title: 'Design and specs coherence',
    verdict: 'warn',
    summary: 'warns: doc-drift at design.md:3, specs/greeting/spec.md:5. one drift',
    output: reply,
    display: 'WARN'
  })

  rmSync(c8.replyFile)
  result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.ok, false)
  assert.deepEqual(result.refusals, [`c8.json: its output file .superpowers/sdd/${CHANGE}/replies/verify-c8.json does not exist`])
  assert.deepEqual([result.redispatch, result.needsRuling, result.rerun], [['c8'], [], false])
  assert.deepEqual(result.redispatchCommands, [{ id: 'c8', command: `node "${SCRIPTS}/dispatch.mjs" prompt --role verify --check c8 --change ${CHANGE} --root "${root}"` }])
  assert.equal(result.rerunCommand, null)

  // A section no recorded reply backs, or one whose verdict is not the computed one, is refused.
  section(root, 'c8', 'pass')
  result = computeVerdict(root, { change: CHANGE })
  assert.match(result.refusals[0], /^c8\.json: it is not the section of the last accepted verify c8 reply \(\.superpowers\/sdd\/add-x\/replies\/verify-c8\.json\)/)
  assert.deepEqual(result.redispatch, ['c8'])
  judge(root, CHANGE, 'c8')
  const forged = JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'c4.json'), 'utf8'))
  write(root, `.superpowers/sdd/${CHANGE}/verify/c4.json`, JSON.stringify({ ...forged, verdict: 'pass' }))
  assert.deepEqual(computeVerdict(root, { change: CHANGE }).refusals, ['c4.json: its verdict pass is not the computed warn'])

  writeDeveloper(root, { change: CHANGE, text: 'The board was not at hand.', verdict: 'not-run' })
  judge(root, CHANGE, 'c4')
  result = computeVerdict(root, { change: CHANGE })
  assert.deepEqual(result.refusals, ['developer was not run and has no ruling: The board was not at hand.'])
  assert.deepEqual([result.redispatch, result.needsRuling], [[], ['developer']])
  assert.deepEqual(result.rulingCommands, [
    { id: 'developer', command: `node "${SCRIPTS}/ledger.mjs" ruling --check developer --reason "<the developer's reason, in their words>" --change ${CHANGE} --root "${root}"` }
  ])
  rmSync(join(verifyDir(root, CHANGE), 'developer.json'))

  judge(root, CHANGE, 'c4', c4Reply({ findings: [CONTRADICTION] }))
  assert.equal(computeVerdict(root, { change: CHANGE }).line, 'Verdict: FAIL')
  section(root, 'tree', 'pass')
  result = computeVerdict(root, { change: CHANGE })
  assert.match(result.refusals[0], /^tree\.json: tree is a script check/)
  assert.deepEqual(result.redispatch, ['tree'])
  assert.deepEqual(result.redispatchCommands, [{ id: 'tree', command: null }])
  rmSync(join(verifyDir(root, CHANGE), 'tree.json'))
  rmSync(join(verifyDir(root, CHANGE), 'tasks.txt'))
  result = computeVerdict(root, { change: CHANGE })
  assert.equal(result.rerun, true)
  assert.equal(result.rerunCommand, `node "${SCRIPTS}/verify.mjs" run --change ${CHANGE} --root "${root}"`)
  write(root, `.superpowers/sdd/${CHANGE}/verify/test-record.json`, '{')
  write(root, `.superpowers/sdd/${CHANGE}/verify/developer.json`, '{')
  const ids = Object.fromEntries(computeVerdict(root, { change: CHANGE }).redispatchCommands.map((c) => [c.id, c.command]))
  assert.equal(ids['test-record'], `node "${SCRIPTS}/verify.mjs" run --suite --change ${CHANGE} --root "${root}"`)
  assert.match(ids.developer, /verify\.mjs" developer --text-file <file> --verdict <pass\|warn\|fail\|not-run> --summary "<text>" --change add-x/)
})

test('verdict: a ruling accepts a failing check; silence and a ruling on tree do not', () => {
  const { root } = host()
  commit(root, { 'docs/notes.md': 'n\n' })
  write(root, 'stray.txt', 'x\n')
  runChecks(root, { change: CHANGE })
  judged(root)
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

test('specs-base passes with no touched requirement, warns with no snapshot, fails a missing or stale entry, and passes a current one', () => {
  const { root } = host()
  assert.equal(runIn(root)['specs-base'].summary, 'N/A: no MODIFIED, REMOVED or RENAMED requirement')
  const modified = `## MODIFIED Requirements\n\n${REQUIREMENT.replace('greet the user.', 'greet the user by name.')}\n`
  commit(root, { [changeFile('specs/greeting/spec.md')]: modified }, 'modify')
  // No specs-base.json at all: a change from before the snapshot; the merge falls back to the
  // merge base, as archive.mjs check warns.
  let check = runIn(root)['specs-base']
  assert.equal(check.verdict, 'warn')
  assert.match(check.summary, /no openspec\/changes\/add-x\/specs-base\.json: .*falls back to the merge base/)
  assert.match(readFileSync(join(root, check.output), 'utf8'), /specs-base\.json: absent; 1 requirement\(s\)[^\n]*\nmissing: greeting: Greeting/)
  commit(root, { [changeFile('specs-base.json')]: '{ "capabilities": {} }\n' }, 'an empty snapshot')
  check = runIn(root)['specs-base']
  assert.equal(check.verdict, 'fail')
  assert.match(check.summary, /no base for greeting "Greeting": run specs\.mjs base --change add-x/)
  assert.equal(writeSpecsBase(root, CHANGE).ok, true)
  commit(root, { [changeFile('specs-base.json')]: readFileSync(join(root, changeFile('specs-base.json')), 'utf8') }, 'snapshot')
  check = runIn(root)['specs-base']
  assert.deepEqual([check.verdict, check.summary], ['pass', 'every base current for 1 requirement(s)'])
  commit(root, { [changeFile('specs/greeting/spec.md')]: modified.replace('by name', 'by first name') }, 'edit the delta')
  check = runIn(root)['specs-base']
  assert.equal(check.verdict, 'fail')
  assert.match(readFileSync(join(root, check.output), 'utf8'), /stale: greeting: Greeting/)
})

test('the CLI prints one JSON object: exit 0 on a pass, 1 on a failing check, 2 on a usage error', () => {
  const { root } = host()
  const cli = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
  let proc = cli('run', '--change', CHANGE, '--root', root)
  assert.equal(proc.status, 0)
  assert.equal(JSON.parse(proc.stdout).checks.length, 8)
  judged(root)
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
  assert.match(JSON.parse(proc.stdout).usage, /^usage:\n {2}verify\.mjs run/)
  assert.equal(cli('run', '--change').status, 2)
  assert.equal(cli('verdict', '--change', CHANGE, '--root', root, '--skill-edit', 'abc').status, 2)
})

test('the ledger takes a check ruling and refuses a malformed one', () => {
  const record = buildRecord('ruling', { check: 'out-of-plan', reason: 'why' }, { now: 'T' })
  assert.deepEqual(record, { id: 'ruling-1', kind: 'ruling', at: 'T', check: 'out-of-plan', reason: 'why' })
  assert.throws(() => buildRecord('ruling', { check: 'out-of-plan' }), /ruling needs --reason/)
  assert.throws(() => buildRecord('ruling', { check: 'Out Of Plan', reason: 'r' }), /--check must be a check id/)
  assert.equal(buildRecord('ruling', { check: 'ext:prisma:migration-order', reason: 'r' }).check, 'ext:prisma:migration-order', 'an extension check is ruled by its id')
  assert.throws(() => buildRecord('ruling', { check: 'ext:Prisma:x', reason: 'r' }), /--check must be a check id/)
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

// ---------------------------------------------------------------- scripts first: wave 2

test('test-record reads the commit only from the **Commit:** field, never from quoted output', () => {
  const { root } = host({ record: false })
  const code = git(root, 'rev-parse', 'HEAD')
  commit(root, { [changeFile('.apply-test-record.md')]: `The suite passed.\n\n\`\`\`text\nHEAD is now at commit ${code}\n\`\`\`\n` })
  assert.equal(runIn(root)['test-record'].summary, 'the apply test record names no commit: run the suite')
  commit(root, { [changeFile('.apply-test-record.md')]: `# Apply test record\n\n**Commit:** \`${code}\`\n\n\`\`\`text\ncommit 0000000 in the output\n\`\`\`\n` })
  assert.equal(runIn(root)['test-record'].summary, `the record is current at ${code.slice(0, 7)}`)
})

test('run clears the sections of another session by itself; --fresh still forces it', () => {
  const { root } = host()
  const dir = verifyDir(root, CHANGE)
  runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's1' } })
  section(root, 'c4', 'pass')
  let run = runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's1' } })
  assert.equal(run.cleared, null)
  assert.equal(existsSync(join(dir, 'c4.json')), true, 'the same session keeps its sections')
  run = runChecks(root, { change: CHANGE, env: {} })
  assert.equal(existsSync(join(dir, 'c4.json')), true, 'no session id: nothing is cleared')
  section(root, 'c4', 'pass')
  run = runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's2' } })
  assert.equal(run.cleared, 'new session')
  assert.equal(run.session, 's2')
  assert.equal(existsSync(join(dir, 'c4.json')), false)
  section(root, 'c4', 'pass')
  assert.equal(runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's2' }, fresh: true }).cleared, 'fresh')
  assert.equal(existsSync(join(dir, 'c4.json')), false)
})

// A section describes the HEAD it was written at, and the verify replies' count restarts with the
// session: HEAD moved by code opens a new one in the same harness session; a commit no review
// reads (the change's own directory, filtered files) does not.
test('run opens a new session by itself when HEAD moved by code, not by the change record', () => {
  const { root } = host()
  const dir = verifyDir(root, CHANGE)
  const env = { CLAUDE_CODE_SESSION_ID: 's1' }
  runChecks(root, { change: CHANGE, env, now: '2020-01-01T00:00:00.000Z' })
  section(root, 'c4', 'pass')
  let run = runChecks(root, { change: CHANGE, env, now: '2020-01-02T00:00:00.000Z' })
  assert.deepEqual([run.cleared, run.started], [null, '2020-01-01T00:00:00.000Z'], 'the same HEAD keeps the session')
  commit(root, { [changeFile('verify.md')]: '# Verification\n' })
  commit(root, { 'docs/notes.md': 'notes\n' })
  run = runChecks(root, { change: CHANGE, env, now: '2020-01-02T12:00:00.000Z' })
  assert.deepEqual([run.cleared, run.started], [null, '2020-01-01T00:00:00.000Z'], 'record and filtered commits keep the session')
  assert.equal(existsSync(join(dir, 'c4.json')), true)
  commit(root, { 'src/a.mjs': 'export const a = 2\n' })
  run = runChecks(root, { change: CHANGE, env, now: '2020-01-03T00:00:00.000Z' })
  assert.deepEqual([run.cleared, run.started], ['head moved', '2020-01-03T00:00:00.000Z'])
  assert.equal(existsSync(join(dir, 'c4.json')), false)
})

test('run reads the approved skill edits from the ledger', () => {
  const { root } = host()
  const sha = commit(root, { '.claude/skills/s/SKILL.md': 'skill\n' })
  assert.equal(runIn(root)['out-of-plan'].verdict, 'fail')
  appendRecord(root, CHANGE, 'skill-edit', { sha, message: 'docs(skills): s' }, { env: {} })
  const run = runChecks(root, { change: CHANGE, now: 'T' })
  assert.deepEqual(run.skillEdits, [sha])
  assert.equal(byId(run)['out-of-plan'].verdict, 'pass')
  assert.throws(() => buildRecord('skill-edit', { sha: 'HEAD' }), /--sha must be a commit sha/)
  appendRecord(root, CHANGE, 'skill-edit', { sha: '1234567' }, { env: {} })
  assert.throws(() => runChecks(root, { change: CHANGE }), /the ledger's skill-edit 1234567 is not a commit/)
})

test('skill-edit commits only skill files, records the sha and runs again', () => {
  const { root } = host()
  write(root, '.claude/skills/s/SKILL.md', 'edited\n')
  write(root, 'other.txt', 'o\n')
  assert.throws(() => skillEdit(root, { change: CHANGE, message: 'docs(skills): s', env: {} }), /paths outside \.claude\/skills\/ are changed: other\.txt/)
  rmSync(join(root, 'other.txt'))
  assert.throws(() => skillEdit(root, { change: CHANGE, message: 'edit the skill', env: {} }), /Conventional Commit/)
  const result = skillEdit(root, { change: CHANGE, message: 'docs(skills): s', env: {} })
  assert.deepEqual(result.files, ['.claude/skills/s/SKILL.md'])
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(skills): s')
  assert.equal(result.record, 'skill-edit-1')
  assert.equal(byId(result.run)['out-of-plan'].verdict, 'pass')
  assert.throws(() => skillEdit(root, { change: CHANGE, message: 'docs(skills): s', env: {} }), /nothing is changed under \.claude\/skills\//)
})

test('skill-edit --diff-file applies the c8 diff with git apply, and refuses one outside the skills or not applying', () => {
  const { root } = host()
  commit(root, { '.claude/skills/s/SKILL.md': 'Run old-command.\n', 'src/b.mjs': 'b\n' })
  write(root, '.claude/skills/s/SKILL.md', 'Run new-command.\n')
  write(root, 'src/b.mjs', 'c\n')
  const skillDiff = git(root, 'diff', '--', '.claude/skills')
  const bothDiff = git(root, 'diff')
  git(root, 'checkout', '--', '.')
  const file = join(root, '.superpowers', 'c8-agent.txt')
  const edit = (text) => {
    write(root, '.superpowers/c8-agent.txt', text)
    return verifyCli(['skill-edit', '--change', CHANGE, '--root', root, '--message', 'docs(skills): s', '--diff-file', file], { env: {} })
  }
  assert.throws(() => edit('CONFIRMED: line 1\n'), /holds no `diff --git` patch/)
  assert.throws(() => edit(`CONFIRMED\n\n${bothDiff}\n`), /outside \.claude\/skills\/: src\/b\.mjs/)
  assert.throws(() => edit(`${skillDiff.replace('old-command', 'gone-command')}\n`), /does not apply cleanly, and nothing was changed/)
  write(root, 'stray.txt', 'x\n')
  assert.throws(() => edit(`${skillDiff}\n`), /the tree already holds changes \(stray\.txt\)/)
  rmSync(join(root, 'stray.txt'))
  assert.equal(git(root, 'status', '--porcelain'), '', 'a refused diff changes nothing')
  const result = edit(`CONFIRMED: SKILL.md line 1 names old-command.\n\n${skillDiff}\n`)
  assert.deepEqual(result.files, ['.claude/skills/s/SKILL.md'])
  assert.equal(readFileSync(join(root, '.claude/skills/s/SKILL.md'), 'utf8'), 'Run new-command.\n')
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(skills): s')
  assert.equal(result.record, 'skill-edit-1')
})

test('run --suite re-runs a missing or stale record in the same call, and drops the re-run once the record is current', () => {
  const { root } = host({ record: false, outsidePlan: ['openspec/planning.md'] })
  writeCommand(root, 'node -e "console.log(\'# tests 1\'); console.log(\'# pass 1\')"')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'planning')
  const run = verifyCli(['run', '--change', CHANGE, '--root', root, '--suite'], { env: {} })
  assert.equal(byId(run)['test-record'].verdict, 'fail')
  assert.equal(run.suite.status, 'pass')
  assert.equal(run.suite.section.verdict, 'pass')
  assert.equal(run.ok, true, 'the section answers the failing check')
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'test-record.json')), true)
  judged(root)
  assert.equal(computeVerdict(root, { change: CHANGE }).line, 'Verdict: PASS')

  commit(root, { [changeFile('.apply-test-record.md')]: `**Commit:** \`${git(root, 'rev-parse', 'HEAD')}\`\n\n# tests 1\n` }, 'record')
  const current = verifyCli(['run', '--change', CHANGE, '--root', root, '--suite'], { env: {} })
  assert.equal(byId(current)['test-record'].verdict, 'pass')
  assert.equal(current.suite, null)
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'test-record.json')), false, 'the current record is cited')
})

test('prompts lists the skill candidates and writes the c4 and c8 prompts in one call', () => {
  const { root } = host()
  runChecks(root, { change: CHANGE })
  const result = verifyCli(['prompts', '--change', CHANGE, '--root', root])
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(root, result.candidates.output)), true)
  assert.deepEqual(result.dispatches.map((d) => [d.check, d.name, d.agent]), [['c4', 'verify c4', 'adf:architecture'], ['c8', 'verify c8', 'adf:integration']])
  assert.match(result.dispatches[1].prompt, /c8-candidates\.txt/)
  assert.match(result.dispatches[1].prompt, /git apply/)
  assert.deepEqual(result.dispatches.map((d) => d.replyFile), ['verify-c4', 'verify-c8'].map((n) => join(root, '.superpowers', 'sdd', CHANGE, 'replies', `${n}.json`)))
  assert.deepEqual(JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'c8-candidates.json'), 'utf8')).candidates, [])
})

test('skill-candidates lists the skill lines naming a changed path, symbol, command or route', () => {
  const { root } = host()
  commit(root, { 'src/a.mjs': "export function greetUser(argv) {\n  if (argv.includes('--loud')) return fetch('/api/v1/greet')\n}\n" })
  write(root, '.claude/skills/greet/SKILL.md', [
    '# Greet',
    'Run `node src/a.mjs` to greet.',
    'It calls greetUser once.',
    'Pass --loud for capitals.',
    'The route is /api/v1/greet.',
    'Nothing here changed: lib/other.mjs and greetUsers.'
  ].join('\n'))
  write(root, '.claude/skills/other/README.md', 'unrelated text\n')
  const result = skillCandidates(root, { change: CHANGE })
  assert.equal(result.skillFiles, 2)
  assert.equal(result.candidates, 4)
  assert.deepEqual(result.skills.map((s) => s.file), ['.claude/skills/greet/SKILL.md'])
  assert.deepEqual(result.skills[0].candidates.map((c) => [c.line, c.matches.map((m) => m.kind)]), [[2, ['path']], [3, ['symbol']], [4, ['command']], [5, ['route']]])
  assert.match(readFileSync(join(root, result.output), 'utf8'), /\.claude\/skills\/greet\/SKILL\.md: 4 candidate line\(s\)/)
  const terms = changedTerms("+++ b/x.mjs\n+run('--keep')\n-run('--keep')\n+run('--new')\n", ['x.mjs'], CHANGE)
  assert.deepEqual(terms.commands, ['--new'], 'a flag on both sides is unchanged')
})

test('developer writes its output file and a section the verdict reads', () => {
  const { root } = host()
  runChecks(root, { change: CHANGE })
  judged(root)
  assert.throws(() => writeDeveloper(root, { change: CHANGE, text: ' ', verdict: 'pass' }), /empty/)
  assert.throws(() => writeDeveloper(root, { change: CHANGE, text: 'x', verdict: 'ok' }), /--verdict must be one of/)
  const section = writeDeveloper(root, { change: CHANGE, text: 'Ran the board flash.\nIt booted.', verdict: 'fail' })
  assert.equal(section.summary, 'Ran the board flash.')
  assert.equal(readFileSync(join(root, section.output), 'utf8'), 'Ran the board flash.\nIt booted.\n')
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.deepEqual(verdict.failing, ['developer'])
})

test('assemble renders the record from the sections, ends on the verdict line and commits it alone', () => {
  const { root } = host()
  runChecks(root, { change: CHANGE, now: 'T' })
  judge(root, CHANGE, 'c8')
  judge(root, CHANGE, 'c4', c4Reply({
    findings: [DRIFT],
    exercised: [{ mechanism: 'greet', path: 'the CLI', exercisedBy: 'a.spec' }, { mechanism: 'greet', path: 'the retry', exercisedBy: null }],
    summary: 'one drift, with ```js x``` quoted'
  }))
  const refused = assemble(root, { change: CHANGE, commit: true })
  assert.equal(refused.ok, true, 'c4 and c8 present')
  const text = readFileSync(join(root, refused.file), 'utf8')
  assert.equal(text.trimEnd().split('\n').at(-1), 'Verdict: PASS WITH WARNINGS')
  assert.match(text, /^# Verification Report\n\n\*\*Change:\*\* `add-x`/)
  assert.match(text, /## Design and specs coherence\n\n\*\*Result:\*\* WARN: warns: doc-drift at design\.md:3, specs\/greeting\/spec\.md:5; nothing exercised greet: the retry\. one drift, with ```js x``` quoted\n\n\*\*Case:\*\* no-design\n\n\*\*Findings:\*\*\n\n- doc-drift at design\.md:3 and specs\/greeting\/spec\.md:5: the two disagree\n\n\*\*Hand-edited capability prose:\*\* none\n\n\*\*Removal accounting:\*\* N\/A: no REMOVED or RENAMED requirement\n\n## /)
  assert.doesNotMatch(text, /"role": "verify-c4"/, 'the reply is rendered, never pasted')
  assert.match(text, /## Stale skills\n\n\*\*Result:\*\* PASS: no stale skill\n\n\*\*CONFIRMED:\*\* none\n\n\*\*PLAUSIBLE:\*\* none\n\n\*\*Not contradicted:\*\* none\n\n\*\*Proposed edits:\*\* none/)
  assert.match(text, /## Exercised and not exercised\n\n- greet, the CLI: exercised by a\.spec\n- greet, the retry: not exercised \(warning\)\n\n## /)
  assert.match(text, /\*\*Scope that ran:\*\* the record cited, not re-run/)
  assert.match(text, /## Checks run with the developer\n\nnone/)
  assert.match(text, /## Rulings\n\nnone/)
  assert.match(text, /## Next step\n\n`\/adf:review`, which reads this record's Verdict line\./)
  assert.equal(refused.commit, git(root, 'rev-parse', 'HEAD'))
  assert.equal(git(root, 'show', '--name-only', '--format=%s', 'HEAD'), `docs(openspec): verify ${CHANGE}\n\n${changeFile('verify.md')}`)
  assert.match(refused.report, /^## Verification PASS WITH WARNINGS\n\n\*\*Change:\*\* add-x\n\*\*Record:\*\* openspec\/changes\/add-x\/verify\.md, commit [0-9a-f]{40}/)
  assert.match(refused.report, /Next step: \/adf:review, which reads the record's Verdict line\./)

  assert.throws(() => assemble(root, { change: CHANGE }), /HEAD is [0-9a-f]{7}, but the checks ran at/)
  runChecks(root, { change: CHANGE })
  rmSync(join(verifyDir(root, CHANGE), 'c8.json'))
  const result = assemble(root, { change: CHANGE })
  assert.equal(result.ok, false)
  assert.deepEqual(result.redispatch, ['c8'])
  assert.match(result.report, /^## Verification: no verdict yet[\s\S]*Re-dispatch:\n- c8: node "[^"]+dispatch\.mjs" prompt --role verify --check c8 --change add-x --root "/)
})

test('verdict --report renders failing, warnings, accepted and the next step', () => {
  const { root } = host()
  commit(root, { 'docs/notes.md': 'n\n' })
  runChecks(root, { change: CHANGE })
  judged(root)
  appendRecord(root, CHANGE, 'ruling', { check: 'out-of-plan', reason: 'notes are no task' }, { env: {} })
  const report = renderReport(computeVerdict(root, { change: CHANGE }), { change: CHANGE })
  assert.match(report, /^## Verification FAIL\n/)
  assert.match(report, /Failing:\n- test-record: stale: re-run the suite\nWarnings: none\nAccepted by the developer:\n- out-of-plan: notes are no task/)
  assert.match(report, /Next step: fix what each failing check names \(test-record\)/)
  const proc = spawnSync('node', [CLI, 'verdict', '--change', CHANGE, '--root', root, '--report'], { encoding: 'utf8' })
  assert.equal(JSON.parse(proc.stdout).report, report)
  assert.equal(spawnSync('node', [CLI, 'assemble', '--change', CHANGE, '--root', root, '--report'], { encoding: 'utf8' }).status, 2)
})

// ---------------------------------------------------------------- the c4 and c8 replies

const c4Ctx = (root, over = {}) => ({ root, change: CHANGE, case: 'no-design', proseEdits: [], removals: [], ...over })
const c4Check = (reply, ctx) => checkVerifyReply('c4', JSON.stringify(reply), ctx)

test('c4: the script computes the verdict from each finding kind and from what nothing exercised', () => {
  const { root } = host()
  const where = [{ file: 'a.md', line: 1 }, { file: 'b.md', line: null }]
  for (const kind of FAIL_KINDS) assert.equal(c4Check(c4Reply({ findings: [{ kind, where, text: 't' }] }), c4Ctx(root)).result.verdict, 'fail', kind)
  for (const kind of WARN_KINDS) assert.equal(c4Check(c4Reply({ findings: [{ kind, where, text: 't' }] }), c4Ctx(root)).result.verdict, 'warn', kind)
  assert.equal(FAIL_KINDS.length + WARN_KINDS.length, 9, 'every kind of the schema has a verdict')
  const unexercised = c4Check(c4Reply({ exercised: [{ mechanism: 'm', path: 'p', exercisedBy: null }] }), c4Ctx(root)).result
  assert.deepEqual([unexercised.verdict, unexercised.warn], ['warn', ['nothing exercised m: p']])
  assert.equal(c4Check(c4Reply({ exercised: [{ mechanism: 'm', path: 'p', exercisedBy: 'x.spec' }] }), c4Ctx(root)).result.verdict, 'pass')
  const both = c4Check(c4Reply({ findings: [DRIFT, CONTRADICTION] }), c4Ctx(root)).result
  assert.deepEqual([both.verdict, both.fail, both.warn], ['fail', ['exec-contradiction at src/a.mjs:1'], ['doc-drift at design.md:3, specs/greeting/spec.md:5']])
  assert.deepEqual(c4Check(c4Reply({ findings: [{ ...DRIFT, where: [DRIFT.where[0]] }] }), c4Ctx(root)).errors, ['$.findings[0].where: a doc-drift names both sides, a file and a line on each'])
  assert.deepEqual(c4Check(c4Reply({ case: 'both' }), c4Ctx(root)).errors, ['$.case: the change\'s files give "no-design", not "both"'])
  assert.deepEqual(c4Check({ ...c4Reply(), verdict: 'pass' }, c4Ctx(root)).errors, ['$: verdict is not allowed'], 'the reply states no verdict')
})

test('c4: each REMOVED or RENAMED requirement the script lists is answered once, and its accounting decides', () => {
  const { root } = host()
  const ctx = c4Ctx(root, { removals: [{ op: 'REMOVED', requirement: 'Greeting', spec: 'specs/greeting/spec.md', codeDisposition: 'deleted with its route' }, { op: 'RENAMED', requirement: 'Welcome', from: 'Hello', spec: 'specs/greeting/spec.md', codeDisposition: null }] })
  const entry = (op, requirement, over = {}) => ({ requirement, op, disposition: 'deleted', holds: true, oldPathReachable: false, ...over })
  assert.deepEqual(c4Check(c4Reply(), ctx).errors, ['$.removalAccounting: REMOVED Greeting is not answered', '$.removalAccounting: RENAMED Welcome is not answered'])
  assert.deepEqual(c4Check(c4Reply({ removalAccounting: [entry('REMOVED', 'Greeting'), entry('REMOVED', 'Greeting'), entry('RENAMED', 'Hello')] }), ctx).errors, [
    '$.removalAccounting[1]: REMOVED Greeting is answered twice',
    '$.removalAccounting[2]: RENAMED Hello is not one the script listed',
    '$.removalAccounting: RENAMED Welcome is not answered'
  ])
  const result = c4Check(c4Reply({ removalAccounting: [entry('REMOVED', 'Greeting', { holds: false, oldPathReachable: true }), entry('RENAMED', 'Welcome')] }), ctx).result
  assert.deepEqual(result.fail, ['the code contradicts the disposition of REMOVED Greeting', 'the old path of REMOVED Greeting is still reachable', 'RENAMED Welcome has no Code Disposition'])
  const clean = c4Check(c4Reply({ removalAccounting: [entry('REMOVED', 'Greeting'), entry('RENAMED', 'Welcome')] }), c4Ctx(root, { removals: ctx.removals.map((r) => ({ ...r, codeDisposition: 'kept' })) })).result
  assert.equal(clean.verdict, 'pass')
  assert.equal(c4Check(c4Reply({ removalAccounting: [entry('REMOVED', 'Greeting', { disposition: null }), entry('RENAMED', 'Welcome')] }), c4Ctx(root, { removals: ctx.removals.map((r) => ({ ...r, codeDisposition: 'kept' })) })).result.verdict, 'fail')
})

test('c4: the script finds each hand edit of a capability spec and where it lies; the reply gives only the reason', () => {
  const { root } = host()
  const above = commit(root, { 'openspec/specs/greeting/spec.md': MAIN.replace('greets every user', 'greets each user') }, 'docs(specs): reword the purpose')
  const below = commit(root, { 'openspec/specs/greeting/spec.md': MAIN.replace('greets every user', 'greets each user').replace('greet the user.', 'greet the user warmly.') }, 'edit a requirement')
  const listed = proseEditsIn(root, CHANGE)
  assert.deepEqual(listed.map((p) => [p.capability, p.commit, p.position]), [['greeting', above, 'above'], ['greeting', below, 'below']])
  const ctx = c4Ctx(root, { proseEdits: listed })
  assert.deepEqual(c4Check(c4Reply({ proseEdits: [{ capability: 'greeting', commit: above.slice(0, 8), reason: 'the purpose named the old flow' }] }), ctx).errors, [`$.proseEdits: the edit of greeting in ${below.slice(0, 7)} is not answered`])
  assert.deepEqual(c4Check(c4Reply({ proseEdits: [{ capability: 'farewell', commit: above, reason: null }, { capability: 'greeting', commit: 'abcdef1', reason: null }] }), ctx).errors.slice(0, 2), [
    '$.proseEdits[1].commit: abcdef1 is no commit',
    `$.proseEdits[0]: the edit of farewell in ${above.slice(0, 7)} is not one the script listed`
  ])
  const result = c4Check(c4Reply({ proseEdits: [{ capability: 'greeting', commit: above.slice(0, 8), reason: null }, { capability: 'greeting', commit: below, reason: 'a typo' }] }), ctx).result
  assert.deepEqual(result.fail, [`an edit of greeting at or below ## Requirements in ${below.slice(0, 7)}`])
  assert.deepEqual(result.warn, [`an edit of greeting in ${above.slice(0, 7)} with no stated reason`])
  assert.deepEqual(result.proseEdits.map((p) => [p.commit, p.position, p.reason]), [[above, 'above', null], [below, 'below', 'a typo']])
  assert.equal(c4Check(c4Reply({ proseEdits: [{ capability: 'greeting', commit: above, reason: 'r' }] }), c4Ctx(root, { proseEdits: listed.slice(0, 1) })).result.verdict, 'pass')
})

// A host whose range changed greetUser, with a skill naming it on line 3: one c8 candidate.
function skillHost() {
  const { root } = host()
  commit(root, { '.claude/skills/greet/SKILL.md': '# Greet\n\nIt calls greetUser once.\n', 'src/a.mjs': 'export function greetUser() {}\n' }, 'greet')
  write(root, '.claude/skills/greet/SKILL.md', '# Greet\n\nIt calls greetUser twice.\n')
  const patch = `${git(root, 'diff', '--', '.claude/skills')}\n`
  git(root, 'checkout', '--', '.')
  runChecks(root, { change: CHANGE })
  skillCandidates(root, { change: CHANGE })
  return { root, patch }
}

test('c8: every candidate is answered once, and each CONFIRMED patch applies; a refused patch never reaches the developer', () => {
  const { root, patch } = skillHost()
  const ctx = { root, change: CHANGE, candidates: JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'c8-candidates.json'), 'utf8')).candidates }
  assert.deepEqual(ctx.candidates, [{ file: '.claude/skills/greet/SKILL.md', line: 3, text: 'It calls greetUser once.' }])
  const check = (candidates) => checkVerifyReply('c8', JSON.stringify(c8Reply({ candidates })), ctx)
  const item = (over) => ({ file: '.claude/skills/greet/SKILL.md', line: 3, class: 'CONFIRMED', fact: 'greetUser runs once', why: 'the diff calls it twice', patch, ...over })
  assert.deepEqual(check([]).errors, ['$.candidates: the candidate .claude/skills/greet/SKILL.md:3 is not answered'])
  assert.deepEqual(check([item(), item()]).errors.slice(0, 1), ['$.candidates[1]: the candidate .claude/skills/greet/SKILL.md:3 is answered twice'])
  assert.deepEqual(check([item({ line: 4 })]).errors.slice(0, 1), ['$.candidates[0]: the candidate .claude/skills/greet/SKILL.md:4 is not one the script listed'])
  assert.deepEqual(check([item({ patch: undefined })]).errors, ['$.candidates[0]: patch is required'])
  assert.match(check([item({ patch: patch.replace('once', 'thrice') })]).errors[0], /^\$\.candidates\[0\]\.patch: git apply --check refuses it in /)
  assert.match(check([item({ patch: patch.replace(/\.claude\/skills\/greet\/SKILL\.md/g, 'src/a.mjs') })]).errors[0], /it touches paths outside \.claude\/skills\/: src\/a\.mjs/)
  assert.deepEqual(check([item({ class: 'PLAUSIBLE' })]).errors, ['$.candidates[0].patch: only a CONFIRMED item carries a patch'])
  const confirmed = check([item()]).result
  assert.deepEqual([confirmed.verdict, confirmed.fail], ['fail', ['CONFIRMED .claude/skills/greet/SKILL.md:3']])
  assert.equal(check([item({ class: 'PLAUSIBLE', patch: undefined })]).result.verdict, 'warn')
  assert.equal(check([item({ class: 'none', patch: undefined })]).result.verdict, 'pass')
})

test('c8: an accepted reply joins its patches into c8.diff, which skill-edit applies by default', () => {
  const { root, patch } = skillHost()
  const reply = c8Reply({ candidates: [{ file: '.claude/skills/greet/SKILL.md', line: 3, class: 'CONFIRMED', fact: 'greetUser runs once', why: 'the diff calls it twice', patch }] })
  const recorded = judge(root, CHANGE, 'c8', reply)
  assert.equal(recorded.valid, true)
  assert.equal(recorded.result.diff, `.superpowers/sdd/${CHANGE}/verify/c8.diff`)
  assert.equal(readFileSync(join(root, recorded.result.diff), 'utf8'), patch)
  const section = JSON.parse(readFileSync(join(verifyDir(root, CHANGE), 'c8.json'), 'utf8'))
  assert.deepEqual([section.verdict, section.reply], ['fail', `.superpowers/sdd/${CHANGE}/replies/verify-c8.json`])
  const edited = skillEdit(root, { change: CHANGE, message: 'docs(skills): greet twice', env: {} })
  assert.equal(edited.diff, `.superpowers/sdd/${CHANGE}/verify/c8.diff`)
  assert.equal(readFileSync(join(root, '.claude/skills/greet/SKILL.md'), 'utf8'), '# Greet\n\nIt calls greetUser twice.\n')
  judge(root, CHANGE, 'c8', c8Reply({ candidates: [{ file: '.claude/skills/greet/SKILL.md', line: 3, class: 'none', fact: 'greetUser runs twice', why: 'the skill now agrees' }] }))
  assert.equal(existsSync(join(root, recorded.result.diff)), false, 'nothing CONFIRMED: no c8.diff')
})

test('a verify reply goes through dispatch.mjs reply: one retry, then stop; a new session starts the count again', () => {
  const { root } = host()
  runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's1' } })
  const file = join(root, '.superpowers', 'sdd', CHANGE, 'replies', 'verify-c4.json')
  write(root, `.superpowers/sdd/${CHANGE}/replies/verify-c4.json`, JSON.stringify({ ...c4Reply(), verdict: 'pass' }))
  const reply = () => dispatchCli(['reply', '--change', CHANGE, '--name', 'verify c4', '--file', file, '--root', root])
  let out = reply()
  assert.deepEqual([out.valid, out.next, out.mode, out.errors], [false, 'retry', 'resume', ['$: verdict is not allowed']])
  assert.equal(existsSync(join(verifyDir(root, CHANGE), 'c4.json')), false, 'a refused reply writes no section')
  assert.equal(reply().next, 'stop')
  assert.throws(reply, /verify c4 stopped after 2 invalid replies/)
  runChecks(root, { change: CHANGE, env: { CLAUDE_CODE_SESSION_ID: 's2' } })
  write(root, `.superpowers/sdd/${CHANGE}/replies/verify-c4.json`, JSON.stringify(c4Reply()))
  out = reply()
  assert.deepEqual([out.valid, out.next, out.section, out.result.verdict], [true, 'proceed', `.superpowers/sdd/${CHANGE}/verify/c4.json`, 'pass'])
})

// ---------------------------------------------------------------- the verify-check hook

// verify-check providers by absolute registry path: each prints config.answer, and logs its input
// to config.log when given.
const CHECKER = `import { appendFileSync } from 'node:fs'
let t = ''
process.stdin.on('data', (d) => (t += d)).on('end', () => {
  const { config, input } = JSON.parse(t)
  if (config.log) appendFileSync(config.log, JSON.stringify(input) + '\\n')
  console.log(JSON.stringify(config.answer))
})
`
function checkers(list) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-checkers-')))
  return list.map(({ name, answer, log }) => {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'adf-extension.json'), JSON.stringify({ name, contract: '1.6', provides: { 'verify-check': { script: 'c.mjs', operations: ['verify-check'] } } }))
    writeFileSync(join(dir, name, 'c.mjs'), CHECKER)
    return { path: join(dir, name), points: ['verify-check'], config: { answer, ...(log ? { log } : {}) } }
  })
}

test('verify-check: one section per returned check after the core\'s, rulable, and the hook gets the range', () => {
  const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-log-'))), 'input.jsonl')
  const answer = { state: 'done', checks: [{ id: 'migration-order', title: 'Migration order', verdict: 'fail', summary: 'm2 sorts before the base\'s m3', text: 'branch m2, base m3' }, { id: 'naming', verdict: 'pass', summary: 'ok' }] }
  const { main, root } = host({ extensions: checkers([{ name: 'db', answer, log }]) })
  const result = runChecks(root, { change: CHANGE, now: 'T' })
  assert.deepEqual(result.checks.slice(-2).map((c) => [c.id, c.title, c.verdict, c.summary]), [
    ['ext:db:migration-order', 'Migration order (db)', 'fail', "m2 sorts before the base's m3"],
    ['ext:db:naming', 'naming (db)', 'pass', 'ok']
  ])
  assert.equal(result.checks.at(-2).output, `.superpowers/sdd/${CHANGE}/verify/ext.db.migration-order.txt`)
  assert.equal(readFileSync(join(root, result.checks.at(-2).output), 'utf8'), 'branch m2, base m3\n')
  const input = JSON.parse(readFileSync(log, 'utf8'))
  assert.deepEqual(input, {
    change: CHANGE,
    base: { ref: 'develop', commit: git(main, 'rev-parse', 'develop') },
    head: git(root, 'rev-parse', 'HEAD'),
    files: git(root, 'diff', '--name-only', 'develop...HEAD').split('\n')
  })
  assert.equal(input.files.includes('src/a.mjs'), true)
  judged(root)
  assert.deepEqual(computeVerdict(root, { change: CHANGE }).failing, ['ext:db:migration-order'])
  appendRecord(root, CHANGE, 'ruling', { check: 'ext:db:migration-order', reason: 'the base migration is reverted' }, { env: {} })
  const ruled = computeVerdict(root, { change: CHANGE })
  assert.equal(ruled.line, 'Verdict: PASS WITH WARNINGS')
  assert.equal(ruled.checks.find((c) => c.id === 'ext:db:migration-order').display, 'FAIL, accepted by the developer: the base migration is reverted')
  const text = readFileSync(join(root, assemble(root, { change: CHANGE }).file), 'utf8')
  assert.match(text, /## Migration order \(db\)\n\n\*\*Result:\*\* FAIL, accepted by the developer: the base migration is reverted: m2 sorts before the base's m3\n\n```text\nbranch m2, base m3\n```/)
})

test('verify-check: a refused, degraded, skipped, malformed or absent provider is a section of its own, never a crash', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'adf-home-')))
  const extensions = [
    ...checkers([
      { name: 'deg', answer: { state: 'degraded', hint: 'install the tool' } },
      { name: 'bad', answer: { state: 'done', checks: [{ id: 'Bad Id', verdict: 'pass' }, { id: 'odd', verdict: 'maybe' }, { id: 'fine', verdict: 'warn', summary: 'w' }, { id: 'verify-check', verdict: 'pass' }] } },
      { name: 'nolist', answer: { state: 'done' } },
      { name: 'no', answer: { state: 'refused', error: 'boom' } },
      { name: 'after', answer: { state: 'done', checks: [] } }
    ]),
    { plugin: 'adf-gone@mk', points: ['verify-check'] }
  ]
  const { root } = host({ extensions })
  const ext = runChecks(root, { change: CHANGE, now: 'T', home }).checks.filter((c) => c.id.startsWith('ext:'))
  assert.deepEqual(ext.map((c) => [c.id, c.verdict]), [
    ['ext:deg:verify-check', 'not-run'],
    ['ext:bad:fine', 'warn'],
    ['ext:bad:verify-check', 'not-run'],
    ['ext:nolist:verify-check', 'not-run'],
    ['ext:no:verify-check', 'not-run'],
    ['ext:after:verify-check', 'not-run'],
    ['ext:adf-gone:verify-check', 'warn']
  ])
  const summary = Object.fromEntries(ext.map((c) => [c.id, c.summary]))
  assert.equal(summary['ext:deg:verify-check'], 'deg could not run its checks: install the tool')
  assert.match(summary['ext:bad:verify-check'], /^bad returned malformed check\(s\) "Bad Id", "odd", "verify-check": /)
  assert.equal(summary['ext:no:verify-check'], 'no refused: boom')
  assert.equal(summary['ext:after:verify-check'], 'not called: an earlier verify-check provider refused')
  assert.equal(summary['ext:adf-gone:verify-check'], 'adf-gone@mk is in the registry but not installed; its checks did not run')
  judged(root)
  const verdict = computeVerdict(root, { change: CHANGE })
  assert.deepEqual(verdict.needsRuling, ['ext:deg:verify-check', 'ext:bad:verify-check', 'ext:nolist:verify-check', 'ext:no:verify-check', 'ext:after:verify-check'])
  assert.match(verdict.rulingCommands[0].command, /ledger\.mjs" ruling --check ext:deg:verify-check --reason/)
})

test('verify-check with no commit range calls no provider; each is a not-run section', () => {
  const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-log-'))), 'input.jsonl')
  const { root } = host({ extensions: checkers([{ name: 'db', answer: { state: 'done', checks: [] }, log }]) })
  write(root, changeFile('.adf.json'), '{}\n')
  const ext = runChecks(root, { change: CHANGE, now: 'T' }).checks.filter((c) => c.id.startsWith('ext:'))
  assert.deepEqual(ext.map((c) => [c.id, c.verdict]), [['ext:db:verify-check', 'not-run']])
  assert.match(ext[0].summary, /^no commit range: /)
  assert.equal(existsSync(log), false)
})
