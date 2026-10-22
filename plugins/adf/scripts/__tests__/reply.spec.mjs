// lib/reply.mjs, the role table of the apply replies, in real git repositories: the commits read
// from git and bounded by the change's range, the test result from the records `suite.mjs
// covering` wrote, the scope from the plan's **Files:**, each review verdict computed from the
// findings, the re-review's open set, and the sweep's dispositions and verdict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as dispatch } from '../dispatch.mjs'
import { parseName } from '../lib/dispatch.mjs'
import { checkReply, replyContext, ROLES } from '../lib/reply.mjs'
import { runCovering } from '../lib/suite.mjs'
import { run as runCli, UsageError } from '../reply.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'reply.mjs')
const CHANGE = 'add-x'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const PLAN = `# Plan

## Execution Graph

| Group | Tasks | Files | Wave |
|---|---|---|---|
| A | 1, 2 | x | 1 |

---

### Task 1: parser

> Implements \`tasks.md\` 1.1.

**Files:**
- Modify: \`src/a.mjs\` — the parser
- Test: \`test/a.spec.mjs\` — its test

**Level:** mechanical

- [ ] **Step 3: Commit** — \`feat: the parser\`

---

### Task 2: printer

> Implements \`tasks.md\` 1.2.

**Files:**
- Create: \`src/b.mjs\` — the printer

**Level:** integration

- [ ] **Step 2: Commit** — none; this task only checks the printer.
`

// The covering runner: `pass`, `fail` (TAP names the failure), `none` (no count line), `zero`
// (a summary of no test).
const RUNNER = `const mode = process.argv[2]
const out = {
  pass: 'ok 1 - parses\\n# tests 1\\n# pass 1\\n# fail 0\\n',
  fail: 'not ok 1 - parses\\n# tests 1\\n# pass 0\\n# fail 1\\n',
  none: 'checked 3 files\\n',
  zero: '# tests 0\\n# pass 0\\n# fail 0\\n'
}
process.stdout.write(out[mode])
process.exit(mode === 'fail' ? 1 : 0)
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

// A repository whose develop holds the change's records and the runner, with the change branch
// checked out: the change's range is develop..HEAD, and the plan has one group, so every dispatch
// works in the root.
function host() {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-reply-'))), 'repo')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  write(root, '.gitignore', '.superpowers/\n')
  const init = commit(root, {
    'runner.cjs': RUNNER,
    'src/a.mjs': 'export const a = 1\n',
    [`openspec/changes/${CHANGE}/.adf.json`]: `${JSON.stringify({ schema: 'adf', base: 'develop' })}\n`,
    [`openspec/changes/${CHANGE}/plan.md`]: PLAN,
    [`openspec/changes/${CHANGE}/tasks.md`]: '- [ ] 1.1 parser\n- [ ] 1.2 printer\n'
  }, 'init')
  git(root, 'checkout', '-q', '-b', `feat/${CHANGE}`)
  return { root, init }
}

const covering = (root, name, mode, now) => runCovering(root, { change: CHANGE, name, command: `node runner.cjs ${mode}`, worktree: root, now }).file
const check = (root, name, reply) => checkReply(parseName(name).role, JSON.stringify(reply), () => replyContext(root, CHANGE, name))
const implReply = (over = {}) => ({ role: 'impl', outcome: 'done', commits: [], testRuns: [], concerns: [], summary: 'Parser added.', ...over })

// ---------------------------------------------------------------- the table

test('the table holds the apply roles and the retro, the v1 spec-merge role gone, each on a schema of its own', () => {
  assert.deepEqual(Object.keys(ROLES), ['impl', 'fix', 'review', 'final-review', 'merge-review', 're-review', 'sweep', 'investigate', 'retro'])
  for (const { schema, check: c, compute } of Object.values(ROLES)) assert.ok(schema.endsWith('.schema.json') && typeof c === 'function' && typeof compute === 'function')
})

test('the schema refuses before any context is read; a role other than the name gives is refused', () => {
  let read = false
  const context = () => {
    read = true
    return {}
  }
  assert.match(checkReply('impl', 'not json', context).errors.join('\n'), /^not JSON: /)
  assert.ok(checkReply('impl', JSON.stringify({ role: 'impl', status: 'DONE' }), context).errors.includes('$: status is not allowed'))
  assert.ok(checkReply('impl', '{"role":"impl","outcome":"done","commits":["abc1234"],"testRuns":["t.json"],"concerns":[],"summary":"s","constructor":1}', context).errors.includes('$: constructor is not allowed'))
  assert.deepEqual(checkReply('impl', JSON.stringify(implReply({ role: 'fix', commits: ['abc1234'], testRuns: ['t.json'] })), context).errors, ['$.role: must be impl, the role of this dispatch'])
  assert.equal(read, false)
  assert.throws(() => checkReply('spec-merge', '{}', context), /no reply checker/)
})

// ---------------------------------------------------------------- impl and fix

test('a done impl is DONE: commits read from git oldest first, the review range, the last run', () => {
  const { root } = host()
  const first = commit(root, { 'test/a.spec.mjs': 'test\n' }, 'test: the parser fails')
  const red = covering(root, 'T1 impl', 'fail', '2026-10-19T10:00:00.000Z')
  const second = commit(root, { 'src/a.mjs': 'export const a = 2\n', [`openspec/changes/${CHANGE}/tasks.md`]: '- [x] 1.1 parser\n' }, 'feat: the parser')
  const green = covering(root, 'T1 impl', 'pass', '2026-10-19T10:05:00.000Z')
  // The agent lists them in any order; the red run before the green is TDD's, not a failure.
  const out = check(root, 'T1 impl', implReply({ commits: [second.slice(0, 7), first], testRuns: [green, red] }))
  assert.deepEqual(out.errors, [])
  const r = out.result
  assert.deepEqual([r.status, r.next, r.outOfScope, r.concerns], ['DONE', 'review', [], []])
  assert.deepEqual(r.commits, [
    { sha: first, subject: 'test: the parser fails', files: ['test/a.spec.mjs'] },
    { sha: second, subject: 'feat: the parser', files: [`openspec/changes/${CHANGE}/tasks.md`, 'src/a.mjs'] }
  ])
  assert.deepEqual(r.range, { base: git(root, 'rev-parse', `${first}^`), head: second })
  assert.deepEqual(r.tests, {
    result: 'pass',
    counts: { pass: 1, fail: 0, skipped: 0, total: 1 },
    runs: [
      { file: red, command: 'node runner.cjs fail', exit: 1, counts: { pass: 0, fail: 1, skipped: 0, total: 1 }, failing: ['parses'] },
      { file: green, command: 'node runner.cjs pass', exit: 0, counts: { pass: 1, fail: 0, skipped: 0, total: 1 }, failing: [] }
    ]
  })
})

test('a sha outside the change range, or no commit at all, is refused', () => {
  const { root, init } = host()
  const sha = commit(root, { 'src/a.mjs': 'export const a = 2\n' })
  const run = covering(root, 'T1 impl', 'pass')
  const errors = check(root, 'T1 impl', implReply({ commits: [sha, init, 'deadbee', sha], testRuns: [run] })).errors
  assert.deepEqual(errors, [
    `$.commits[1]: ${init} lies outside develop..HEAD, the change's commits in ${root}`,
    `$.commits[2]: deadbee is no commit in ${root}`,
    `$.commits[3]: ${sha} is named twice`
  ])
})

test('a done impl with no commit is valid only for a task whose Commit step says none', () => {
  const { root } = host()
  const run = covering(root, 'T2 impl', 'pass')
  const out = check(root, 'T2 impl', implReply({ testRuns: [run] }))
  assert.deepEqual(out.errors, [])
  assert.deepEqual([out.result.status, out.result.next, out.result.commits, out.result.range], ['DONE', 'review', [], null])
  const other = covering(root, 'T1 impl', 'pass')
  assert.deepEqual(check(root, 'T1 impl', implReply({ testRuns: [other] })).errors, [
    "$.commits: a done reply names at least one commit; Task 1's Commit step does not say none"
  ])
})

test('a failing last run, or one that ran no test, is refused for done; blocked keeps it', () => {
  const { root } = host()
  const sha = commit(root, { 'src/a.mjs': 'export const a = 2\n' })
  const green = covering(root, 'T1 impl', 'pass', '2026-10-19T10:00:00.000Z')
  const red = covering(root, 'T1 impl', 'fail', '2026-10-19T10:05:00.000Z')
  assert.deepEqual(check(root, 'T1 impl', implReply({ commits: [sha], testRuns: [green, red] })).errors, [
    `$.testRuns: the last covering run ${red} failed (exit 1, failing parses); a done reply needs a passing run`
  ])
  const zero = covering(root, 'T1 impl', 'zero', '2026-10-19T10:10:00.000Z')
  assert.deepEqual(check(root, 'T1 impl', implReply({ commits: [sha], testRuns: [zero] })).errors, [`$.testRuns: the last covering run ${zero} ran no test`])
  const blocked = check(root, 'T1 impl', implReply({ outcome: 'blocked', blocker: 'The parser needs the grammar.', commits: [sha], testRuns: [red] }))
  assert.deepEqual([blocked.valid, blocked.result.status, blocked.result.next, blocked.result.tests.result, blocked.result.blocker], [true, 'BLOCKED', 'blocked', 'fail', 'The parser needs the grammar.'])
  const context = check(root, 'T1 impl', implReply({ outcome: 'needs-context', blocker: 'Which grammar?' }))
  assert.deepEqual([context.result.status, context.result.next, context.result.range, context.result.tests.result], ['NEEDS_CONTEXT', 'provide-context', null, null])
})

test('a test-run record of another dispatch, outside the tests directory or not a record, is refused', () => {
  const { root } = host()
  const sha = commit(root, { 'src/a.mjs': 'export const a = 2\n' })
  const other = covering(root, 'T2 impl', 'pass')
  write(root, 'run.json', '{}')
  write(root, `.superpowers/sdd/${CHANGE}/tests/T1-impl-broken.json`, '{"command":"x"}')
  const errors = check(root, 'T1 impl', implReply({ commits: [sha], testRuns: [other, 'run.json', `.superpowers/sdd/${CHANGE}/tests/T1-impl-broken.json`] })).errors
  assert.equal(errors[0], `$.testRuns[0]: ${other} is the record of another dispatch, not of T1 impl`)
  assert.equal(errors[1], `$.testRuns[1]: run.json is not a test-run record under .superpowers/sdd/${CHANGE}/tests/`)
  assert.match(errors[2], /^\$\.testRuns\[2\]: .*T1-impl-broken\.json: not a test-run record \(exit\)$/)
})

test('a file outside the task scope, and a run with no count line, make DONE_WITH_CONCERNS', () => {
  const { root } = host()
  const sha = commit(root, { 'src/a.mjs': 'export const a = 2\n', 'src/b.mjs': 'export const b = 1\n', 'README.md': 'x\n' })
  const run = covering(root, 'T1 impl', 'pass')
  const out = check(root, 'T1 impl', implReply({ commits: [sha], testRuns: [run], concerns: [{ text: 'The name is a guess.', file: 'src/a.mjs' }] }))
  assert.deepEqual([out.result.status, out.result.next, out.result.outOfScope], ['DONE_WITH_CONCERNS', 'read-concerns', ['README.md', 'src/b.mjs']])
  assert.deepEqual(out.result.concerns, [
    { text: 'The name is a guess.', file: 'src/a.mjs', source: 'agent' },
    { text: 'changed outside the **Files:** of Task 1', file: 'README.md', source: 'script' },
    { text: 'changed outside the **Files:** of Task 1', file: 'src/b.mjs', source: 'script' }
  ])
  // The final fix is bounded by every task: src/b.mjs is Task 2's.
  const fix = covering(root, 'fix r1', 'none')
  const final = check(root, 'fix r1', implReply({ role: 'fix', commits: [sha], testRuns: [fix] }))
  assert.deepEqual([final.result.status, final.result.next, final.result.outOfScope], ['DONE_WITH_CONCERNS', 'read-concerns', ['README.md']])
  assert.deepEqual(final.result.concerns[0], { text: `the last covering run ${fix} printed no count line, so what it ran is unconfirmed`, file: fix, source: 'script' })
  // A fix within its task's files is DONE and goes to its re-review.
  const fixed = commit(root, { 'src/a.mjs': 'export const a = 3\n' })
  const task = check(root, 'T1 fix r1', implReply({ role: 'fix', commits: [fixed], testRuns: [covering(root, 'T1 fix r1', 'pass')] }))
  assert.deepEqual([task.result.status, task.result.next, task.result.range.head], ['DONE', 're-review', fixed])
})

test('the context refuses a task the plan lacks', () => {
  const { root } = host()
  assert.throws(() => replyContext(root, CHANGE, 'T9 impl'), /Task 9 is not in the plan/)
  assert.throws(() => replyContext(root, CHANGE, 'verify c4'), /not the dispatch name of a reply role/)
})

// ---------------------------------------------------------------- reviews

const finding = (over = {}) => ({ severity: 'important', kind: 'quality', category: 'quality', file: 'src/a.mjs', line: 3, title: 'Unchecked error', body: 'The error is dropped.', ...over })
const reviewReply = (findings, unverifiable = []) => ({ role: 'review', summary: 'Reviewed.', findings, unverifiable })

test('a review computes the spec and quality verdicts, the ids and the result', () => {
  const { root } = host()
  const clean = check(root, 'T1 review', reviewReply([finding({ severity: 'minor' })])).result
  assert.deepEqual([clean.spec, clean.quality, clean.open, clean.deferred, clean.result, clean.subject], ['pass', 'approved', [], ['F1'], 'clean', 'T1'])
  const fix = check(root, 'T1 review', reviewReply([finding({ severity: 'minor', kind: 'spec', category: 'missing' }), finding(), finding({ severity: 'minor', category: 'tests' })])).result
  assert.deepEqual([fix.spec, fix.quality, fix.open, fix.deferred, fix.toRule, fix.result], ['fail', 'needs-fixes', ['F1', 'F2'], ['F3'], [], 'fix'])
  assert.deepEqual(fix.findings.map((f) => [f.id, f.planMandated]), [['F1', false], ['F2', false], ['F3', false]])
  const rule = check(root, 'T1 review', reviewReply([finding(), finding({ severity: 'critical', planMandated: true })])).result
  assert.deepEqual([rule.quality, rule.open, rule.toRule, rule.result], ['needs-fixes', ['F1'], ['F2'], 'rule'])
  const unverifiable = check(root, 'final-review', { ...reviewReply([], [{ requirement: 'R2', check: 'Run it on the bench.' }]), role: 'final-review' }).result
  assert.deepEqual([unverifiable.spec, unverifiable.quality, unverifiable.result, unverifiable.subject], ['pass', 'approved', 'rule', 'final'])
})

test('a category that disagrees with its kind is refused', () => {
  const { root } = host()
  assert.deepEqual(check(root, 'T1 review', reviewReply([finding({ category: 'missing' }), finding({ kind: 'spec', category: 'extra' }), finding({ kind: 'spec', category: 'merge-meaning' })])).errors, [
    '$.findings[0].kind: category missing is a spec finding, not quality',
    '$.findings[2].kind: category merge-meaning is a quality finding, not spec'
  ])
})

test('a re-review answers exactly the open set; the round open set and the ids continue', () => {
  const { root } = host()
  const reply = (name, value) => {
    const file = join(root, 'replies', `${name.replace(/ /g, '-')}.json`)
    write(root, `replies/${name.replace(/ /g, '-')}.json`, JSON.stringify(value))
    return dispatch(['reply', '--change', CHANGE, '--name', name, '--file', file, '--root', root], { main: root })
  }
  const reReview = (previous, findings = []) => ({ role: 're-review', summary: 'Checked.', previous, findings, outOfScope: [{ file: 'src/c.mjs', line: null, title: 'Old naming' }] })
  const p = (id, status) => ({ id, status, file: 'src/a.mjs', line: 3 })
  assert.deepEqual(check(root, 'T1 re-review r1', reReview([])).errors, ['$.previous: no accepted review of T1 is recorded, so there is no open set to answer'])

  const reviewed = reply('T1 review', reviewReply([finding(), finding({ kind: 'spec', category: 'misunderstood' }), finding({ severity: 'minor' })]))
  assert.deepEqual([reviewed.valid, reviewed.result.open, reviewed.result.deferred], [true, ['F1', 'F2'], ['F3']])
  assert.deepEqual(readFileSync(join(root, '.superpowers', 'sdd', CHANGE, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).result.open), [['F1', 'F2']])

  assert.deepEqual(check(root, 'T1 re-review r1', reReview([p('F1', 'addressed'), p('F3', 'addressed'), p('F1', 'addressed')])).errors, [
    '$.previous[1].id: F3 is not an open finding of T1',
    '$.previous[2].id: F1 is answered twice',
    '$.previous: the open finding F2 of T1 is not answered'
  ])
  const round = reply('T1 re-review r1', reReview([p('F1', 'addressed'), p('F2', 'not-addressed')], [finding({ severity: 'critical', category: 'tests' }), finding({ severity: 'minor' })]))
  assert.deepEqual(round.errors, [])
  const r = round.result
  assert.deepEqual([r.addressed, r.open, r.deferred, r.result], [['F1'], ['F2', 'F4'], ['F5'], 'fix'])
  assert.deepEqual(r.findings.map((f) => f.id), ['F4', 'F5'])
  assert.deepEqual(r.outOfScope, [{ file: 'src/c.mjs', line: null, title: 'Old naming' }])
  // The next round answers the open set the last re-review left; another subject has its own.
  const last = reply('T1 re-review r2', reReview([p('F2', 'addressed'), p('F4', 'addressed')]))
  assert.deepEqual([last.result.open, last.result.result], [[], 'clean'])
  assert.match(check(root, 're-review B r1', reReview([])).errors[0], /no accepted review of B/)
})

// ---------------------------------------------------------------- sweep and investigate

test('the sweep needs a disposition for each removed or renamed requirement exactly when one is listed', () => {
  const { root } = host()
  const sweepReply = (over = {}) => ({ role: 'sweep', findings: [], ...over })
  const disposition = (requirement) => ({ requirement, disposition: 'Deleted with its callers.' })
  assert.deepEqual(check(root, 'sweep', sweepReply({ dispositions: [disposition('Old export')] })).errors, ['$.dispositions: the change lists no REMOVED or RENAMED requirement, so the reply gives no disposition'])
  assert.deepEqual(check(root, 'sweep', sweepReply()).result, { verdict: 'CLEAN', findings: [], dropped: [] })

  commit(root, { [`openspec/changes/${CHANGE}/specs/cap/spec.md`]: '## REMOVED Requirements\n\n### Requirement: Old export\n\n**Code Disposition:** deleted.\n\n### Requirement: Old import\n' })
  assert.deepEqual(check(root, 'sweep', sweepReply()).errors, ['$.dispositions: required, one for each REMOVED or RENAMED requirement: Old export, Old import'])
  assert.deepEqual(check(root, 'sweep', sweepReply({ dispositions: [disposition('Old export'), disposition('Other'), disposition('Old export')] })).errors, [
    '$.dispositions[1].requirement: Other is no REMOVED or RENAMED requirement of the change',
    '$.dispositions[2].requirement: Old export is answered twice',
    '$.dispositions: Old import has no disposition'
  ])
  // The verdict is computed after the DUP filter.
  commit(root, { 'src/b.mjs': '// ADF DUP src/a.mjs:1 -- kept\nexport const b = 1\n' })
  const dup = { introduced: 'src/b.mjs:2', existing: 'src/a.mjs:1', why: 'Same constant.' }
  const other = { introduced: 'src/c.mjs:1', existing: 'src/a.mjs:1', why: 'Same constant.' }
  const both = [disposition('Old export'), disposition('Old import')]
  const accepted = check(root, 'sweep', sweepReply({ findings: [dup], dispositions: both })).result
  assert.deepEqual(accepted, { verdict: 'CLEAN', findings: [], dropped: [{ ...dup, marker: 'src/b.mjs:1' }], dispositions: both })
  assert.equal(check(root, 'sweep', sweepReply({ findings: [dup, other], dispositions: both })).result.verdict, 'FINDINGS')
})

test('an investigation is checked by its schema alone and computes nothing', () => {
  const { root } = host()
  const out = check(root, 'investigate retry', { role: 'investigate', answer: 'The key is the name.', evidence: [{ file: 'src/a.mjs', line: 1 }] })
  assert.deepEqual([out.valid, out.result], [true, undefined])
  assert.deepEqual(check(root, 'investigate retry', { role: 'investigate', answer: 'x' }).errors, ['$: evidence is required'])
})

// ---------------------------------------------------------------- the CLI

test('reply.mjs check prints ok, valid, errors and the result; exit 1 refuses, exit 2 is a wrong call', () => {
  const { root } = host()
  write(root, 'r/inv.json', `\`\`\`json\n${JSON.stringify({ role: 'investigate', answer: 'yes', evidence: [] })}\n\`\`\``)
  write(root, 'r/review.json', JSON.stringify(reviewReply([finding()])))
  const ok = runCli(['check', '--change', CHANGE, '--name', 'investigate retry', '--file', 'r/inv.json', '--root', root])
  assert.deepEqual(ok, { ok: true, valid: true, errors: [], result: null, name: 'investigate retry', role: 'investigate', file: join(root, 'r/inv.json'), fenced: true })
  assert.equal(runCli(['check', '--change', CHANGE, '--name', 'T1 review', '--file', 'r/review.json'], { cwd: root, main: root }).result.result, 'fix')
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root })
    return { status: r.status, out: JSON.parse(r.stdout) }
  }
  const refused = cli('check', '--change', CHANGE, '--name', 'T1 re-review r1', '--file', 'r/review.json')
  assert.deepEqual([refused.status, refused.out.ok, refused.out.valid, refused.out.result], [1, false, false, null])
  write(root, 'r/impl.json', JSON.stringify(implReply({ outcome: 'blocked', blocker: 'No grammar.' })))
  const unplanned = cli('check', '--change', CHANGE, '--name', 'T9 impl', '--file', 'r/impl.json')
  assert.deepEqual([unplanned.status, unplanned.out.ok], [1, false])
  assert.match(unplanned.out.error, /Task 9 is not in the plan/)
  assert.equal(cli('check', '--change', CHANGE, '--name', 'verify c4', '--file', 'r/inv.json').status, 2)
  assert.equal(cli('check', '--change', CHANGE, '--name', 'T1 review', '--file', 'r/absent.json').status, 2)
  assert.equal(cli('--role', 'impl', 'r/inv.json').status, 2)
  assert.throws(() => runCli(['check', '--name', 'T1 review', '--file', 'x']), UsageError)
})
