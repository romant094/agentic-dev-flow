// lib/review-state.mjs and the review.mjs subcommands over a change's review state: start,
// round, input, response, fixplan, fix, disposition, assemble and check, with the suite run of
// suite.mjs --section review and the developer's ledger rulings, against real git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendRecord } from '../lib/ledger.mjs'
import { readRegistry, writeRegistry } from '../lib/registry.mjs'
import { checkRecord, mapLine, markerCheck, reviewDir, TEST_FILE } from '../lib/review-state.mjs'
import { run as dispatch } from '../dispatch.mjs'
import { run as review } from '../review.mjs'
import { run as suite } from '../suite.mjs'
import { commitIn, host } from './git-host.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const PROMPT = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-review-prompt-'))), 'prompt.md')
writeFileSync(PROMPT, 'Look for bugs.\n')

function write(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

function commitAll(root, files, message = 'work') {
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  git(root, 'add', '--', ...Object.keys(files))
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

// A change with code to review and a whole-suite command.
function setup({ files = { 'src/a.ts': 'line1\nline2\nline3\n' }, command = 'true', review: settings = null } = {}) {
  const { change } = host()
  if (settings) {
    writeRegistry(change, { ...readRegistry(change), review: settings })
    git(change, 'add', '.claude')
  }
  commitAll(change, { 'openspec/planning.md': `# Planning\n\n## Whole-suite command\n\n${command}\n`, ...files })
  return change
}

const R = (change, ...args) => review([...args, '--root', change], { cwd: change })
const sdd = (change, file) => join(change, '.superpowers', 'sdd', 'add-x', file)
function reply(change, name, value) {
  const file = sdd(change, `replies/${name}.json`)
  write(change, `.superpowers/sdd/add-x/replies/${name}.json`, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const finding = (id, severity, extra = {}) => ({ id, severity, category: 'Bugs', file: 'src/a.ts', line: 2, title: `title ${id}`, body: `body ${id}`, ...extra })
const findings = (...list) => ({ summary: 'Reviewed.', findings: list })
const rule = (change, fields) => appendRecord(change, 'add-x', 'ruling', fields, { env: {} }).record

// start, round 1, its input and the stored reply.
function reviewed(change, ...list) {
  assert.equal(R(change, 'start', '--change', 'add-x').ok, true)
  assert.equal(R(change, 'round', '--change', 'add-x').round, 1)
  assert.equal(R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT).ok, true)
  const out = R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'ai-review-r1', findings(...list)))
  assert.equal(out.complete, true, out.error)
  return out
}

function fix(change, round, id, files, failureMode = 'a null input crashed the page') {
  for (const [file, text] of Object.entries(files)) write(change, file, text)
  git(change, 'add', '--', ...Object.keys(files))
  git(change, 'commit', '-q', '-m', `fix: ${id}`)
  const sha = git(change, 'rev-parse', 'HEAD')
  return { sha, out: R(change, 'fix', '--change', 'add-x', '--round', String(round), '--finding', id, '--file', reply(change, `ai-fix-${id}-r${round}`, { finding: id, outcome: 'fixed', sha, failureMode })) }
}

const runSuite = (change) => suite(['run', '--change', 'add-x', '--section', 'review', '--root', change])

// ---------------------------------------------------------------- the whole run

test('a run: start, round, input, response, fixplan, fix, recorded, a second round on the fix range, the suite and the committed record', () => {
  const change = setup()
  const start = R(change, 'start', '--change', 'add-x')
  assert.deepEqual([start.ok, start.counts.kept, start.empty], [true, 1, false])
  assert.equal(R(change, 'round', '--change', 'add-x').round, 1)
  assert.deepEqual(R(change, 'round', '--change', 'add-x'), { ok: true, round: 1, already: true, since: null, ruling: null, cap: 3 })
  const input = R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT)
  assert.equal(input.file, join(reviewDir(change, 'add-x'), 'input-r1.md'))
  assert.match(readFileSync(input.file, 'utf8'), /\+line2/)

  const bad = R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'ai-review-r1', 'The code looks fine.'))
  assert.deepEqual([bad.ok, bad.retry, bad.invalid, bad.next, bad.mode, bad.name], [false, true, 1, 'retry', 'resume', 'ai-review r1'])
  const stored = R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'ai-review-r1-2', findings(finding('F1', 'HIGH'), finding('F2', 'MEDIUM', { line: 3 }))))
  assert.deepEqual([stored.ok, stored.complete, stored.ids, stored.verdict, stored.blocking], [true, true, ['F1', 'F2'], 'BLOCKED', ['F1']])
  const plan = R(change, 'fixplan', '--change', 'add-x', '--round', '1')
  const f1 = { finding: 'F1', severity: 'HIGH', file: 'src/a.ts', line: 2, title: 'title F1', name: 'ai-fix F1 r1', level: 'integration' }
  assert.deepEqual([plan.next, plan.fixes, plan.awaitingDeveloper], [f1, [f1], []])

  const { sha, out } = fix(change, 1, 'F1', { 'src/a.ts': 'line1\nline2 fixed\nline3\n' })
  assert.deepEqual([out.ok, out.sha, out.tests], [true, sha, []])
  write(change, '.superpowers/sdd/add-x/why-F2.txt', 'The naming is consistent with the module; a rename belongs to its own change.\n')
  const recorded = R(change, 'disposition', '--change', 'add-x', '--finding', 'F2', '--as', 'recorded', '--body-file', sdd(change, 'why-F2.txt'))
  assert.deepEqual([recorded.ok, recorded.disposition], [true, 'recorded, non-blocking'])
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /a fix landed and the suite has not run after it/)

  const round2 = R(change, 'round', '--change', 'add-x')
  assert.deepEqual([round2.round, round2.since], [2, git(change, 'rev-parse', 'HEAD~1')])
  const in2 = R(change, 'input', '--round', '2', '--change', 'add-x', '--prompt', PROMPT)
  const text = readFileSync(in2.file, 'utf8')
  assert.match(text, /This is review round 2/)
  assert.match(text, /## Round 1 findings[\s\S]*### F1 \(HIGH\): title F1[\s\S]*State: fixed in `[0-9a-f]{7}`[\s\S]*Failure mode: a null input crashed the page/)
  assert.doesNotMatch(text, /### F2/, 'a recorded non-blocking finding the fixes did not target is left out')
  assert.match(text, /\+line2 fixed/)
  assert.equal(in2.range.base, round2.since)
  const r2 = R(change, 'response', '--change', 'add-x', '--round', '2', '--file', reply(change, 'ai-review-r2', findings()))
  assert.deepEqual([r2.ok, r2.ids, r2.verdict], [true, [], 'PASS'])
  assert.match(R(change, 'round', '--change', 'add-x').error, /left nothing to re-review/)

  assert.equal(runSuite(change).ok, true)
  const reviewedAt = git(change, 'rev-parse', 'HEAD')
  const record = R(change, 'assemble', '--change', 'add-x', '--commit')
  assert.deepEqual([record.ok, record.verdict, record.rounds], [true, 'PASS', 2], record.error)
  assert.equal(git(change, 'show', '--name-only', '--format=%s', 'HEAD'), 'docs(openspec): review add-x\n\nopenspec/changes/add-x/review.md')
  assert.match(record.report, /Next step: \/adf:archive/)
  const md = readFileSync(join(change, record.file), 'utf8')
  assert.match(md, new RegExp(`\\*\\*Reviewed commit\\*\\*: \`${reviewedAt}\``))
  assert.match(md, /^\*\*Verdict\*\*: PASS$/m)
  assert.match(md, /\*\*Counts\*\*: CRITICAL `0` \| HIGH `1` \| MEDIUM `1` \| LOW `0`/)
  assert.match(md, /\*\*Excluded files\*\*: `\d+`/)
  assert.match(md, /\| F1 \| 1 \| HIGH \| `src\/a\.ts:2` \| title F1 \| fixed in `[0-9a-f]{7}` \|/)
  assert.match(md, /## Recorded findings\n\n### F2\. `src\/a\.ts:3` — recorded, non-blocking\n\nMEDIUM, Bugs: title F2\n\nbody F2\n\nWhy it was left: The naming is consistent/)
  assert.match(md, /## Suite after the fixes\n\n- command: `true`/)
  assert.doesNotMatch(md, /## Outstanding|## Not reviewed/)
  const check = R(change, 'check', '--file', record.file)
  assert.deepEqual([check.ok, check.verdict, check.commit, check.rounds, check.counts], [true, 'PASS', reviewedAt, 2, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0 }])
  assert.deepEqual(check.dispositions.map((d) => [d.id, d.kind]), [['F1', 'fixed'], ['F2', 'recorded']])
  assert.deepEqual(check.warnings, [])
})

test('a second invalid reply stops the stage until start --fresh', () => {
  const change = setup()
  R(change, 'start', '--change', 'add-x')
  R(change, 'round', '--change', 'add-x')
  R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT)
  R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'a', '{}'))
  const second = R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'b', '{"summary": "x"}'))
  assert.deepEqual([second.ok, second.stopped, second.errors], [false, true, ['$: findings is required']])
  assert.match(second.error, /stops the stage: no record, no fix dispatch, no second reviewer/)
  assert.match(R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'c', findings())).error, /stopped/)
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /stopped/)
  assert.match(R(change, 'start', '--change', 'add-x').error, /under way \(stopped\); pass --fresh/)
  assert.equal(R(change, 'start', '--change', 'add-x', '--fresh').ok, true)
  assert.equal(existsSync(join(reviewDir(change, 'add-x'), 'stopped.json')), false)
  assert.equal(R(change, 'round', '--change', 'add-x').round, 1)
  assert.match(R(change, 'start', '--change', 'add-x').error, /under way \(round 1-1\)/)
  // The fresh run counts its own events only: the earlier run's two invalid replies are history.
  R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT)
  const again = R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'd', '{}'), '--resume', 'no')
  assert.deepEqual([again.retry, again.invalid, again.mode], [true, 1, 'fresh'])
  assert.match(again.error, /afresh with the errors as its question/)
  const events = readFileSync(sdd(change, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(events.map((e) => [e.name, e.event, e.next]), [['ai-review r1', 'invalid', 'retry'], ['ai-review r1', 'invalid', 'stop'], ['ai-review r1', 'invalid', 'retry']])
  assert.equal(existsSync(join(reviewDir(change, 'add-x'), 'attempts.json')), false, 'the review stage keeps no counter of its own')
})

test('each fixer counts its own invalid replies, keyed by its dispatch name; the second of one name stops the stage', () => {
  const change = setup({ files: { 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\n' } })
  reviewed(change, finding('F1', 'HIGH', { line: 1 }), finding('F2', 'HIGH', { file: 'src/b.ts', line: 1 }))
  const fixFile = (id, name, value) => R(change, 'fix', '--change', 'add-x', '--round', '1', '--finding', id, '--file', reply(change, name, value))
  // Two fixers whose replies carry no valid finding: before, both were keyed `ai-fix F? r1`.
  const first = fixFile('F1', 'f1a', '{}')
  assert.deepEqual([first.retry, first.name, first.invalid], [true, 'ai-fix F1 r1', 1])
  const second = fixFile('F2', 'f2a', { outcome: 'fixed' })
  assert.deepEqual([second.retry, second.stopped, second.name, second.invalid], [true, undefined, 'ai-fix F2 r1', 1])
  // A reply naming another finding than the command's is invalid, and counts for the command's.
  const other = fixFile('F2', 'f2b', { finding: 'F1', outcome: 'false-positive', failureMode: 'm', argument: 'a' })
  assert.deepEqual([other.stopped, other.name, other.errors], [true, 'ai-fix F2 r1', ['$.finding: F1 is not F2, the finding this dispatch was sent to fix']])
  assert.match(other.error, /a second invalid reply from ai-fix F2 r1 stops the stage/)
  assert.match(R(change, 'fixplan', '--change', 'add-x', '--round', '1').error, /stopped: a second invalid reply from ai-fix F2 r1/)
  assert.match(fixFile('F1', 'f1b', { finding: 'F1', outcome: 'false-positive', failureMode: 'm', argument: 'a' }).error, /stopped/)
})

test('a stop that dispatch.mjs reply records in the shared log stops the review stage too', () => {
  const change = setup()
  R(change, 'start', '--change', 'add-x')
  R(change, 'round', '--change', 'add-x')
  R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT)
  assert.equal(R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'a', '{}')).retry, true)
  const out = dispatch(['reply', '--change', 'add-x', '--name', 'ai-review r1', '--file', reply(change, 'b', '{}'), '--root', change], { cwd: change, main: change })
  assert.deepEqual([out.ok, out.next], [false, 'stop'])
  assert.match(R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'c', findings())).error, /stopped: a second invalid reply from ai-review r1/)
})

// ---------------------------------------------------------------- fixes

test('a fix is one commit in the fix range touching its finding file and tests only; a false-positive claim waits for the developer', () => {
  const change = setup({ files: { 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\n' } })
  reviewed(change, finding('F1', 'HIGH', { line: 1 }), finding('F2', 'HIGH', { file: 'src/b.ts', line: 1 }), finding('F3', 'CRITICAL'))
  const plan = R(change, 'fixplan', '--change', 'add-x', '--round', '1')
  // One fixer at a time, in one worktree: same-file findings adjacent, the first file first.
  assert.deepEqual([plan.next.name, plan.fixes.map((e) => e.name)], ['ai-fix F1 r1', ['ai-fix F1 r1', 'ai-fix F3 r1', 'ai-fix F2 r1']])
  const fixFile = (name, value, id = value.finding) => R(change, 'fix', '--change', 'add-x', '--round', '1', '--finding', id, '--file', reply(change, name, value))
  const old = git(change, 'rev-parse', 'HEAD~1')
  assert.match(fixFile('x1', { finding: 'F1', outcome: 'fixed', sha: old, failureMode: 'm' }).error, /is not in round 1's fix range/)
  assert.match(fixFile('x2', { finding: 'F9', outcome: 'fixed', sha: old, failureMode: 'm' }).error, /F9 is not a finding of round 1/)
  const both = fix(change, 1, 'F1', { 'src/a.ts': 'a1 fixed\na2\n', 'src/b.ts': 'b1 too\n' })
  assert.match(both.out.error, /touches src\/b\.ts besides src\/a\.ts/)
  const good = fix(change, 1, 'F1', { 'src/a.ts': 'a1 fixed again\na2\n', 'src/a.test.ts': 'test\n' })
  assert.deepEqual([good.out.ok, good.out.tests], [true, ['src/a.test.ts']])
  assert.match(fixFile('x3', { finding: 'F3', outcome: 'fixed', sha: good.sha, failureMode: 'm' }).error, /already the fix of F1/)
  assert.match(fixFile('x4', { finding: 'F1', outcome: 'fixed', sha: good.sha, failureMode: 'm' }).error, /F1 is already fixed in/)
  const other = fix(change, 1, 'F3', { 'src/b.ts': 'b1 changed\n' })
  assert.match(other.out.error, /does not touch src\/a\.ts, the file F3 names/)
  const claim = fixFile('x5', { finding: 'F2', outcome: 'false-positive', failureMode: 'b1 is never null', argument: 'src/b.ts:1 is a constant' })
  assert.deepEqual([claim.ok, claim.awaiting], [true, 'developer'])
  assert.match(claim.next, /ruling --change add-x --finding F2 --as dismissed/)
  const again = R(change, 'fixplan', '--change', 'add-x', '--round', '1')
  assert.deepEqual([again.next.finding, again.fixes.map((e) => e.finding), again.awaitingDeveloper], ['F3', ['F3'], [{ finding: 'F2', argument: 'src/b.ts:1 is a constant' }]])
  assert.match(fixFile('x6', '{"finding": "F3"}', 'F3').error, /invalid/)
  assert.equal(TEST_FILE.test('apps/x/__tests__/a.spec.mjs') && TEST_FILE.test('pkg/a_test.go') && !TEST_FILE.test('src/latest.ts'), true)
})

test('a false-positive claim the developer rejects is listed again as a fix, with the argument and the decision; --also is kept', () => {
  const change = setup({ files: { 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\n' } })
  reviewed(change, finding('F1', 'HIGH', { file: 'src/b.ts', line: 1 }), finding('F2', 'LOW', { line: 1 }))
  assert.deepEqual(R(change, 'fixplan', '--change', 'add-x', '--round', '1', '--also', 'F2').fixes.map((e) => e.finding), ['F1', 'F2'])
  const claim = { finding: 'F1', outcome: 'false-positive', failureMode: 'b1 is never null', argument: 'src/b.ts:1 is a constant' }
  R(change, 'fix', '--change', 'add-x', '--round', '1', '--finding', 'F1', '--file', reply(change, 'fp1', claim))
  const waiting = R(change, 'fixplan', '--change', 'add-x', '--round', '1')
  assert.deepEqual([waiting.next.finding, waiting.awaitingDeveloper.map((c) => c.finding)], ['F2', ['F1']])
  const ruling = rule(change, { finding: 'F1', as: 'fix', decision: 'b1 is read from the request' })
  const listed = R(change, 'fixplan', '--change', 'add-x', '--round', '1')
  assert.deepEqual([listed.next.finding, listed.awaitingDeveloper], ['F1', []])
  assert.deepEqual(listed.next.rejected, { argument: 'src/b.ts:1 is a constant', decision: 'b1 is read from the request', ruling: ruling.id })
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed').error, /ruled F1 fix .*, not dismissed/)
  // A second claim after the ruling waits for the developer again.
  R(change, 'fix', '--change', 'add-x', '--round', '1', '--finding', 'F1', '--file', reply(change, 'fp2', claim))
  assert.deepEqual(R(change, 'fixplan', '--change', 'add-x', '--round', '1').awaitingDeveloper.map((c) => c.finding), ['F1'])
})

test('an open blocking finding makes a BLOCKED record, not a refusal; a fix no round re-reviewed blocks it too', () => {
  const change = setup({ files: { 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\n' } })
  reviewed(change, finding('F1', 'HIGH'), finding('F2', 'HIGH', { file: 'src/b.ts', line: 1 }))
  R(change, 'fix', '--change', 'add-x', '--round', '1', '--finding', 'F2', '--file', reply(change, 'fp', { finding: 'F2', outcome: 'false-positive', failureMode: 'm', argument: 'a' }))
  fix(change, 1, 'F1', { 'src/a.ts': 'a1\na2 fixed\n' })
  runSuite(change)
  const out = R(change, 'assemble', '--change', 'add-x')
  assert.deepEqual([out.ok, out.verdict], [true, 'BLOCKED'])
  assert.deepEqual(out.outstanding.map((o) => o.slice(0, 2)), ['F2', 'F1'])
  assert.match(out.outstanding[0], /a false-positive claim waiting for the developer/)
  assert.match(out.outstanding[1], /not re-reviewed; open round 2/)
  assert.doesNotMatch(out.report, /archive/)
  const md = readFileSync(join(change, out.file), 'utf8')
  assert.match(md, /\| F2 \| 1 \| HIGH \| `src\/b\.ts:1` \| title F2 \| outstanding \|/)
  assert.match(md, /## Outstanding\n\n- F2: open HIGH finding/)
  assert.equal(R(change, 'check', '--file', out.file).verdict, 'BLOCKED')
})

// ---------------------------------------------------------------- dispositions

test('dismissed needs the developer ruling of this run and a committed marker covering the line, or no line to mark', () => {
  const change = setup({ files: { 'src/a.ts': 'const a = 1\nconst b = run(x)\nconst c = 3\n' } })
  rule(change, { finding: 'F1', as: 'dismissed', decision: 'a ruling of an earlier run' })
  reviewed(change, finding('F1', 'HIGH', { key: 'CWE-95' }), finding('F2', 'HIGH', { line: null }), finding('F3', 'LOW', { line: 3 }))
  const none = R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed')
  assert.match(none.error, /F1 has no developer ruling in this review/)
  assert.match(none.rulingCommand, /ledger\.mjs ruling --change add-x --finding F1 --as dismissed --decision/)
  rule(change, { finding: 'F1', as: 'accepted', decision: 'x' })
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed').error, /the developer ruled F1 accepted \(ruling-2\), not dismissed/)
  rule(change, { finding: 'F1', as: 'dismissed', decision: 'x is a constant here' })
  const unmarked = R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed')
  assert.match(unmarked.error, /no committed ADF IGNORE CWE-95 marker covers src\/a\.ts:2 at HEAD/)
  assert.equal(unmarked.markCommand, 'review.mjs mark --file src/a.ts --line 2 --key CWE-95 --reason "<the developer\'s reason>" --commit')
  R(change, 'mark', '--file', 'src/a.ts', '--line', '2', '--key', 'CWE-79', '--reason', 'another key', '--commit')
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed').error, /covers src\/a\.ts:3 at HEAD \(line 2 when reviewed\)/)
  const marked = R(change, 'mark', '--file', 'src/a.ts', '--line', '3', '--key', 'CWE-95', '--reason', 'x is a constant here', '--commit')
  assert.match(marked.commit, /^[0-9a-f]{40}$/)
  const dismissed = R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed')
  assert.deepEqual([dismissed.ok, dismissed.marker], [true, { file: 'src/a.ts', line: 3, kind: 'ignore', key: 'CWE-95' }])
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'dismissed', '--body-file', PROMPT).error, /keeps no body/)
  rule(change, { finding: 'F2', as: 'dismissed', decision: 'the whole module is generated' })
  const lineless = R(change, 'disposition', '--change', 'add-x', '--finding', 'F2', '--as', 'dismissed')
  assert.deepEqual([lineless.ok, lineless.marker, lineless.absent], [true, null, 'the finding names no line'])
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /F3 \(LOW\) has no disposition/)
  write(change, '.superpowers/sdd/add-x/why.txt', 'Cosmetic.\n')
  R(change, 'disposition', '--change', 'add-x', '--finding', 'F3', '--as', 'recorded', '--body-file', sdd(change, 'why.txt'))
  const out = R(change, 'assemble', '--change', 'add-x')
  assert.deepEqual([out.ok, out.verdict], [true, 'PASS'], out.error)
  const md = readFileSync(join(change, out.file), 'utf8')
  assert.match(md, /\| F1 \| 1 \| HIGH \| `src\/a\.ts:2` \| title F1 \| dismissed — x is a constant here; marker ADF IGNORE CWE-95 at `src\/a\.ts:3` \|/)
  assert.match(md, /\| F2 \| 1 \| HIGH \| `src\/a\.ts` \| title F2 \| dismissed — the whole module is generated; no marker: the finding names no line \|/)
  assert.match(md, /## Developer rulings\n\n- `F1` dismissed: x is a constant here \(ruling-3\)\n- `F2` dismissed: the whole module is generated \(ruling-4\)/)
  assert.doesNotMatch(md, /## Suite after the fixes/, 'no fix landed, so no suite run is needed')
  const check = R(change, 'check', '--file', out.file)
  assert.deepEqual([check.dispositions.map((d) => d.kind), check.warnings], [['dismissed', 'dismissed', 'recorded'], []])
})

test('a dismissed line gone from HEAD needs no marker; a file with no comment syntax cannot be dismissed', () => {
  const change = setup({ files: { 'src/a.ts': 'one\ntwo\nthree\n', 'data/x.json': '{\n  "a": 1\n}\n' } })
  reviewed(change)
  const head = git(change, 'rev-parse', 'HEAD')
  commitIn(change, 'src/a.ts', 'zero\none\nthree\n', 'edit')
  assert.deepEqual(markerCheck(change, head, finding('F1', 'HIGH', { line: 2 })), { absent: 'line 2 of src/a.ts was changed or removed after the review' })
  assert.throws(() => markerCheck(change, head, finding('F1', 'HIGH', { line: 3 })), /covers src\/a\.ts:3 at HEAD \(line 3 when reviewed\)/)
  assert.deepEqual(markerCheck(change, head, finding('F1', 'HIGH', { file: 'src/gone.ts', line: 1 })), { absent: 'src/gone.ts is not in the reviewed commit' })
  assert.throws(() => markerCheck(change, head, finding('F1', 'HIGH', { file: 'data/x.json', line: 2 })), /no comment syntax.*accepted instead/)
  assert.equal(mapLine('@@ -0,0 +1 @@\n', 5), 6)
  assert.equal(mapLine('@@ -3 +3 @@\n', 3), null)
  assert.equal(mapLine('@@ -3 +3 @@\n', 4), 4)
  assert.equal(mapLine('@@ -2,2 +1,0 @@\n@@ -9,0 +8,3 @@\n', 5), 3)
  assert.equal(mapLine('@@ -2,2 +1,0 @@\n@@ -9,0 +8,3 @@\n', 10), 11)
})

test('accepted needs a ruling and closes a blocking finding; recorded is for a non-blocking severity with a body', () => {
  const change = setup()
  reviewed(change, finding('F1', 'HIGH'), finding('F2', 'LOW'))
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'recorded', '--body-file', PROMPT).error, /HIGH, a blocking severity/)
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F2', '--as', 'recorded').error, /needs --body-file/)
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F9', '--as', 'recorded').error, /F9 is not a stored finding/)
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F2', '--as', 'fixed').error, /--as must be dismissed, accepted or recorded/)
  assert.match(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'accepted').error, /no developer ruling/)
  rule(change, { finding: 'F1', as: 'accepted', decision: 'the endpoint is internal until the gateway lands' })
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /F1: the developer ruled it accepted \(ruling-1\); apply it/)
  write(change, '.superpowers/sdd/add-x/f1.txt', 'Follow-up: the gateway change.\n')
  assert.equal(R(change, 'disposition', '--change', 'add-x', '--finding', 'F1', '--as', 'accepted', '--body-file', sdd(change, 'f1.txt')).disposition, 'accepted — the endpoint is internal until the gateway lands')
  R(change, 'disposition', '--change', 'add-x', '--finding', 'F2', '--as', 'recorded', '--body-file', PROMPT)
  const out = R(change, 'assemble', '--change', 'add-x')
  assert.equal(out.verdict, 'PASS', out.error)
  const md = readFileSync(join(change, out.file), 'utf8')
  assert.match(md, /### F1\. `src\/a\.ts:2` — accepted\n\nHIGH, Bugs: title F1\n\nbody F1\n\nWhy it was left: the endpoint is internal until the gateway lands\n\nFollow-up: the gateway change\./)
  assert.match(md, /### F2\. `src\/a\.ts:2` — recorded, non-blocking/)
})

// ---------------------------------------------------------------- rounds, slices, ranges

test('three rounds at most; the developer ruling allows a fourth, and the record names it', () => {
  const change = setup()
  reviewed(change, finding('F1', 'HIGH'))
  fix(change, 1, 'F1', { 'src/a.ts': 'line1\nline2 r1\nline3\n' })
  for (const k of [2, 3]) {
    assert.equal(R(change, 'round', '--change', 'add-x').round, k)
    R(change, 'input', '--round', String(k), '--change', 'add-x', '--prompt', PROMPT)
    const stored = R(change, 'response', '--change', 'add-x', '--round', String(k), '--file', reply(change, `ai-review-r${k}`, findings(finding('F1', 'HIGH'))))
    assert.deepEqual(stored.ids, [`F${k}`])
    assert.equal(R(change, 'fixplan', '--change', 'add-x', '--round', String(k)).next.level, 'architecture')
    fix(change, k, `F${k}`, { 'src/a.ts': `line1\nline2 r${k}\nline3\n` })
  }
  const capped = R(change, 'round', '--change', 'add-x')
  assert.deepEqual([capped.ok, capped.escalate], [false, true])
  assert.match(capped.error, /round 4 is past the cap of 3/)
  assert.match(capped.rulingCommand, /--check review-round-4/)
  rule(change, { check: 'review-round-4', reason: 'the third fix is a one-line guard' })
  assert.deepEqual(R(change, 'round', '--change', 'add-x').ruling, { id: 'ruling-1', reason: 'the third fix is a one-line guard' })
  R(change, 'input', '--round', '4', '--change', 'add-x', '--prompt', PROMPT)
  R(change, 'response', '--change', 'add-x', '--round', '4', '--file', reply(change, 'ai-review-r4', findings()))
  runSuite(change)
  const out = R(change, 'assemble', '--change', 'add-x')
  assert.deepEqual([out.verdict, out.rounds], ['PASS', 4], out.error)
  const md = readFileSync(join(change, out.file), 'utf8')
  assert.match(md, /\*\*Round cap\*\*: 3, passed by the developer's ruling: round 4 \(ruling-1: the third fix is a one-line guard\)/)
  assert.match(md, /- `review-round-4`: the third fix is a one-line guard \(ruling-1\)/)
})

test('slices need the developer approval; each slice reply is stored, and the merge renumbers the findings in slice order', () => {
  const change = setup({ files: { 'apps/client/a.ts': 'a\n'.repeat(60), 'apps/server/b.ts': 'b\n'.repeat(60) }, review: { maxBytes: 300 } })
  const start = R(change, 'start', '--change', 'add-x')
  assert.equal(start.over, true)
  const n = start.slices.length
  assert.ok(n >= 2)
  R(change, 'round', '--change', 'add-x')
  const unapproved = R(change, 'input', '--round', '1', '--slice', '1', '--change', 'add-x', '--prompt', PROMPT)
  assert.deepEqual([unapproved.ok, unapproved.needsRuling, unapproved.proof.ok], [false, true, true])
  assert.match(unapproved.rulingCommand, /--check review-slices/)
  rule(change, { check: 'review-slices', reason: 'one reviewer per app' })
  for (let s = 1; s <= n; s++) assert.equal(R(change, 'input', '--round', '1', '--slice', String(s), '--change', 'add-x', '--prompt', PROMPT).file, join(reviewDir(change, 'add-x'), `input-r1-s${s}.md`))
  const store = (s, value) => R(change, 'response', '--change', 'add-x', '--round', '1', '--slice', String(s), '--file', reply(change, `ai-review-r1-s${s}`, value))
  assert.match(R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'x', findings())).error, new RegExp(`goes by ${n} slices`))
  const first = store(1, findings(finding('F1', 'LOW'), finding('F2', 'LOW')))
  assert.deepEqual([first.complete, first.missing], [false, Array.from({ length: n - 1 }, (_, i) => i + 2)])
  assert.match(store(1, findings()).error, /already stored/)
  let last
  for (let s = 2; s <= n; s++) last = store(s, findings(finding('F1', 'MEDIUM', { file: `slice${s}.ts` })))
  assert.equal(last.complete, true)
  assert.deepEqual(last.ids, Array.from({ length: n + 1 }, (_, i) => `F${i + 1}`))
  assert.deepEqual(last.renumbered.F3, { slice: 2, id: 'F1' })
  const stored = JSON.parse(readFileSync(last.findingsFile, 'utf8'))
  assert.deepEqual(stored.findings.map((f) => f.file), ['src/a.ts', 'src/a.ts', ...Array.from({ length: n - 1 }, (_, i) => `slice${i + 2}.ts`)])
  assert.match(stored.summary, /^Slice 1: Reviewed\./)
})

test('an explicit range for a change needs the developer ruling, and the record names it', () => {
  const change = setup()
  const base = git(change, 'rev-parse', 'HEAD~2')
  const refused = R(change, 'start', '--change', 'add-x', '--range', `${base}..HEAD`)
  assert.match(refused.error, /an explicit range for add-x needs the developer's ruling/)
  rule(change, { check: 'review-range', reason: 'the code reached develop outside apply' })
  const out = R(change, 'start', '--change', 'add-x', '--range', `${base}..HEAD`)
  assert.deepEqual([out.ok, out.range.from, out.rangeRuling], [true, 'range', { id: 'ruling-1', reason: 'the code reached develop outside apply' }])
  R(change, 'round', '--change', 'add-x')
  R(change, 'input', '--round', '1', '--change', 'add-x', '--prompt', PROMPT)
  R(change, 'response', '--change', 'add-x', '--round', '1', '--file', reply(change, 'r', findings()))
  const md = readFileSync(join(change, R(change, 'assemble', '--change', 'add-x').file), 'utf8')
  assert.match(md, new RegExp(`\\*\\*Range\\*\\*: \`${base}\\.\\.[0-9a-f]{40}\` \\(an explicit range, ruling-1: the code reached develop outside apply\\)`))
})

// ---------------------------------------------------------------- the record's refusals

test('an empty filtered diff is recorded as not reviewed, PASS with zero counts', () => {
  const { change } = host()
  commitAll(change, { 'docs/guide.md': 'prose\n' })
  assert.equal(R(change, 'start', '--change', 'add-x').empty, true)
  assert.match(R(change, 'round', '--change', 'add-x').error, /empty: nothing to review; record it with assemble --change add-x --not-reviewed/)
  assert.match(R(change, 'assemble', '--change', 'add-x', '--not-reviewed', ' ').error, /needs the reason/)
  const out = R(change, 'assemble', '--change', 'add-x', '--not-reviewed', 'The change is documentation only.', '--commit')
  assert.deepEqual([out.ok, out.verdict, out.rounds], [true, 'PASS', 0], out.error)
  const md = readFileSync(join(change, out.file), 'utf8')
  assert.match(md, /\*\*Rounds\*\*: `0`/)
  assert.match(md, /\| — \| — \| — \| — \| — \| no findings \|/)
  assert.match(md, /## Not reviewed\n\nThe filtered diff was empty: no reviewer was dispatched\. The change is documentation only\.\n\nThe review filter excluded \d+ of the \d+ changed file\(s\)\./)
  assert.deepEqual(checkRecord(md).counts, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 })
  const code = setup()
  R(code, 'start', '--change', 'add-x')
  assert.match(R(code, 'assemble', '--change', 'add-x', '--not-reviewed', 'x').error, /is not empty \(1 file\(s\)\): it is reviewed/)
})

test('assemble refuses a dirty tree and a commit no round reviewed; a marker-only commit is no such commit', () => {
  const change = setup()
  reviewed(change)
  assert.equal(R(change, 'assemble', '--change', 'add-x').verdict, 'PASS')
  write(change, 'src/a.ts', 'dirty\n')
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /changes outside openspec\/changes\/add-x\/review\.md: src\/a\.ts/)
  git(change, 'checkout', '--', 'src/a.ts')
  R(change, 'mark', '--file', 'src/a.ts', '--line', '1', '--key', 'CWE-1', '--reason', 'r', '--commit')
  assert.equal(R(change, 'assemble', '--change', 'add-x').verdict, 'PASS')
  const stray = commitIn(change, 'src/z.ts', 'new code\n', 'more work')
  assert.match(R(change, 'assemble', '--change', 'add-x').error, new RegExp(`no round reviewed and that are not a recorded fix: ${stray.slice(0, 7)}`))
  assert.match(R(change, 'round', '--change', 'add-x').error, /left nothing to re-review/)
})

test('the suite after the fixes runs with the base check; a new failure blocks unless the developer rules on it', () => {
  const change = setup({ command: 'test ! -f src/flag.test.ts' })
  reviewed(change, finding('F1', 'HIGH'))
  fix(change, 1, 'F1', { 'src/a.ts': 'line1\nline2 fixed\nline3\n', 'src/flag.test.ts': 'x\n' })
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /suite has not run/)
  R(change, 'round', '--change', 'add-x')
  R(change, 'input', '--round', '2', '--change', 'add-x', '--prompt', PROMPT)
  R(change, 'response', '--change', 'add-x', '--round', '2', '--file', reply(change, 'r2', findings()))
  const ran = runSuite(change)
  assert.deepEqual([ran.ok, ran.status, ran.section.base.exit, ran.section.file], [false, 'fail', 0, '.superpowers/sdd/add-x/review/suite.json'])
  const blocked = R(change, 'assemble', '--change', 'add-x')
  assert.equal(blocked.verdict, 'BLOCKED')
  assert.match(blocked.outstanding[0], /^the suite after the fixes: fail/)
  rule(change, { check: 'review-suite', reason: 'the flag test is the pending fixture' })
  const ruled = R(change, 'assemble', '--change', 'add-x')
  assert.equal(ruled.verdict, 'PASS')
  assert.match(readFileSync(join(change, ruled.file), 'utf8'), /- `review-suite`: the flag test is the pending fixture \(ruling-1\)[\s\S]*## Suite after the fixes[\s\S]*- base check: `develop`/)
  commitIn(change, 'src/a.ts', 'line1\nline2 fixed\nline3 more\n', 'fix: more')
  assert.match(R(change, 'assemble', '--change', 'add-x').error, /no round reviewed/)
})

// ---------------------------------------------------------------- check

test('check reads a record as archive does: the exact verdict token, the sha, the rounds, the counts, the dispositions', () => {
  const record = (verdict, extra = '') =>
    [
      '# AI Code Review Record',
      '',
      '**Change**: `add-x`',
      '**Reviewed commit**: `6bc8b234687da861a3690611cad0cf5d0309e13c`',
      verdict,
      '',
      '**Rounds**: `2` (one review, one fix round)',
      '',
      '**Counts**: CRITICAL `0` | HIGH `2` | MEDIUM `1` | LOW `0`',
      '',
      '## Findings',
      '',
      '| # | Severity | Where | Disposition |',
      '|---|---|---|---|',
      '| 1 | HIGH | `a.ts:4` | fixed in `abc1234` |',
      '| 2 | HIGH | `b.ts:1` | dismissed — reason; marker ADF IGNORE K1 at `b.ts:1` |',
      '| 3 | MEDIUM | `c.ts` | test added |',
      '| 4 | HIGH | `d.ts` | fixed, abc1234 |',
      '| 5 | HIGH | `e.ts` | fixed in `abc1234` — found by round 2 |',
      '| 6 | HIGH | `f.ts` | dismissed — reason; marker added |',
      extra
    ].join('\n')
  const ok = checkRecord(record('**Verdict**: PASS'))
  assert.deepEqual([ok.ok, ok.verdict, ok.commit, ok.change, ok.rounds, ok.counts], [true, 'PASS', '6bc8b234687da861a3690611cad0cf5d0309e13c', 'add-x', 2, { CRITICAL: 0, HIGH: 2, MEDIUM: 1, LOW: 0 }])
  assert.deepEqual(ok.dispositions.map((d) => [d.id, d.severity, d.where, d.kind]), [['1', 'HIGH', 'a.ts:4', 'fixed'], ['2', 'HIGH', 'b.ts:1', 'dismissed'], ['3', 'MEDIUM', 'c.ts', 'other'], ['4', 'HIGH', 'd.ts', 'other'], ['5', 'HIGH', 'e.ts', 'other'], ['6', 'HIGH', 'f.ts', 'other']])
  // The whole cell is matched against the template's forms, not its first word.
  assert.deepEqual(ok.warnings, ['disposition outside the vocabulary: 3 "test added"; 4 "fixed, abc1234"; 5 "fixed in `abc1234` — found by round 2"; 6 "dismissed — reason; marker added"'])
  const over = record('**Verdict**: PASS').replace('**Rounds**: `2` (one review, one fix round)', '**Rounds**: `4`')
  assert.ok(checkRecord(over).warnings.includes("4 rounds, above the round cap of 3, and no **Round cap** line names the developer's ruling"))
  const ruled = over.replace('**Rounds**: `4`', "**Rounds**: `4`\n**Round cap**: 3, passed by the developer's ruling: round 4 (ruling-1: one more)")
  assert.equal(checkRecord(ruled).warnings.some((w) => /round cap/.test(w)), false)
  assert.equal(checkRecord(record('**Verdict:** `BLOCKED`')).verdict, 'BLOCKED')
  const template = checkRecord(record('**Verdict**: `PASS` | `BLOCKED`'))
  assert.deepEqual([template.ok, template.verdict, template.errors], [false, null, ['the verdict reads "PASS|BLOCKED", not PASS or BLOCKED']])
  assert.equal(checkRecord(record('**Verdict**: PASS — nothing blocked')).ok, false)
  assert.deepEqual(checkRecord('**Verdict**: PASS\n').errors, ['no reviewed commit sha'])
  assert.deepEqual(checkRecord('**Verdict**: PASS\n**Reviewed commit**: `abc1234`\n').warnings, ['no **Rounds** count', 'no **Counts** line with the four severities', 'no ## Findings section'])
  assert.ok(checkRecord(record('**Verdict**: PASS').replace('fixed in `abc1234` |', 'outstanding |')).warnings.includes('a PASS record lists an outstanding finding'))
})
