// lib/window.mjs in real git repositories: membership by first-parent history (a merge carrying
// two changes, a backfilled record, the cut-off of a merged window retro, an unmerged retro and a
// change retro that do not move it, a period, one change), the git figures, records with and
// without data, the aggregates, the delta's directions, the waiting items, removal candidates
// and archive's count since the last retro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setBranches } from '../lib/branches.mjs'
import { fromV1, validateRecord } from '../lib/metrics.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { aggregate, buildSidecar, changeValues, delta, DIRECTION, fetchRef, integrationRef, METRICS, previousRetro, readWaiting, selectWindow, sinceLastRetro, waitingItems } from '../lib/window.mjs'

const ARCHIVE = 'openspec/changes/archive'
const DATE = '2026-10-19'
const AS_OF = '2026-10-19T12:00:00.000Z'

function g(cwd, args, at) {
  const env = at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    g(root, ['add', path])
  }
}

// A host on develop with the registry's branch policy, its first commit on 2026-09-01.
function repo() {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-window-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  g(root, ['config', 'user.email', 't@example.com'])
  g(root, ['config', 'user.name', 'T'])
  initRegistry(root, '1.4')
  setBranches(root, { integration: 'develop', protected: [] })
  write(root, { 'src/a.txt': 'a\n' })
  g(root, ['add', '.'])
  g(root, ['commit', '-q', '-m', 'init'], '2026-09-01T10:00:00Z')
  return root
}

// A branch from develop with the files, merged with a no-fast-forward merge commit.
function merge(root, branch, files, at, subject = 'work') {
  g(root, ['checkout', '-q', '-b', branch, 'develop'])
  write(root, files)
  g(root, ['commit', '-q', '-m', subject], at)
  g(root, ['checkout', '-q', 'develop'])
  g(root, ['merge', '-q', '--no-ff', '-m', `Merge branch '${branch}' into 'develop'`, branch], at)
  return g(root, ['rev-parse', 'HEAD'])
}

function direct(root, files, at, subject) {
  write(root, files)
  g(root, ['commit', '-q', '-m', subject], at)
  return g(root, ['rev-parse', 'HEAD'])
}

// An archived change's directory: its tasks and, when given, its record.
const archived = (dir, { tasks = 2, record } = {}) => ({
  [`${ARCHIVE}/${dir}/tasks.md`]: Array.from({ length: tasks }, (_, i) => `- [x] ${i + 1}.1 t\n`).join(''),
  ...(record ? { [`${ARCHIVE}/${dir}/metrics.json`]: `${JSON.stringify(record)}\n` } : {})
})

// The origin's record shape (schemaVersion 1), with transcripts and autonomy.
const v1 = (change, extra = {}) => ({
  schemaVersion: 1,
  change,
  branch: `feat/${change}`,
  generatedAt: '2026-09-30T10:00:00.000Z',
  sessions: [{ id: 's1', resolved: true, source: 'transcript', scope: 'branch', window: '2026-09-02T10:00:00.000Z/2026-09-02T11:00:00.000Z' }],
  cost: { total: { input: 10, output: 20, thinking: 0, cacheRead: 70, cacheWrite5m: 0, cacheWrite1h: 0, turns: 3 }, byActor: { orchestrator: { input: 5, output: 5, thinking: 0, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0, turns: 1 } }, byPhase: {}, byModel: {} },
  autonomy: { developerMessages: 4, askUserQuestion: 1, clears: 0, sessions: 2, rulings: 0 },
  findings: { review: { dispatches: 2, findings: 3 } },
  ...extra
})

// A schemaVersion 2 record: the converted shape with the groups a v2 record measures.
function v2(change, { findings = { review: 1 }, rounds = 1, invalid = 0, generatedAt = '2026-10-10T10:00:00.000Z' } = {}) {
  const r = fromV1(v1(change, { generatedAt }))
  const layers = Object.fromEntries(Object.entries(findings).map(([layer, n]) => [layer, { dispatches: 1, findings: n, native: null, mapped: null }]))
  const { convertedFrom: _c, ...sources } = r.sources
  const record = {
    ...r,
    generator: { plugin: 'adf', version: '0.11.0', plugins: {} },
    replies: { impl: { dispatches: 2, valid: 2, invalid, retries: invalid, stops: 0 } },
    review: { verdict: 'APPROVE', rounds, dispositions: {}, stopped: false },
    findings: layers,
    sources: { ...sources, coverage: { ...sources.coverage, generator: 'record', replies: 'record', review: 'record', findings: 'record' } }
  }
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), [], 'the v2 fixture validates')
  return record
}

const sidecarFile = (root, date, mode, cutoff) => ({ [`.adf/retro/${date}-${mode}.json`]: `${JSON.stringify({ schemaVersion: 1, date, mode, cutoff, aggregates: {} })}\n` })
const names = (sel) => sel.changes.map((c) => c.change)

test('a merge carrying two changes: both members, no diff size for either, fixes counted once', () => {
  const root = repo()
  merge(root, 'feat/early', { ...archived('2026-09-02-early'), 'src/early.txt': 'e\n' }, '2026-09-02T10:00:00Z')
  const shared = merge(
    root,
    'feat/pair',
    { ...archived('2026-09-10-one', { record: v2('one') }), ...archived('2026-09-10-two'), 'src/pair.txt': 'p\nq\n', 'package-lock.json': '{}\n{}\n{}\n' },
    '2026-09-10T10:00:00Z'
  )
  // A fix touching the pair's code, and a fix touching only bookkeeping, which is not its code.
  merge(root, 'fix/pair-bug', { 'src/pair.txt': 'p\nq\nr\n' }, '2026-09-12T10:00:00Z')
  merge(root, 'fix/notes', { [`${ARCHIVE}/2026-09-10-one/notes.md`]: 'n\n' }, '2026-09-13T10:00:00Z', 'docs: notes')
  // A fix after the as-of time is not counted.
  merge(root, 'fix/late', { 'src/pair.txt': 'late\n' }, '2026-10-30T10:00:00Z')

  const sel = selectWindow(root, { ref: 'develop' })
  assert.deepEqual(names(sel), ['early', 'one', 'two'])
  assert.equal(sel.changes[1].mergeSha, shared)
  assert.equal(sel.changes[1].branch, 'feat/pair')

  const s = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF })
  const [early, one, two] = s.changes
  assert.equal(early.git.diffLines, 1)
  assert.equal(early.coverage.diffLines, 'git')
  for (const c of [one, two]) {
    assert.equal(c.git.diffLines, null)
    // Two lines of code; the lock file and the archive directories are excluded.
    assert.deepEqual(c.git.sharedMerge, { changes: ['one', 'two'], diffLines: 2, fixesAfter: 1 })
    assert.match(c.coverage.diffLines.none, /carries 2 changes: one, two/)
  }
  assert.equal(one.values['quality.fixesAfter'], 1)
  assert.equal(two.values['quality.fixesAfter'], null, 'the second change of a merge does not count its fixes again')
  assert.equal(s.aggregates['quality.fixesAfter'].n, 2)
  assert.equal(s.aggregates['quality.fixesAfter'].perKloc, 0, 'only the change with a diff size of its own has a per-1000-lines figure')
  assert.equal(one.git.exposureDays, Number(((Date.parse(AS_OF) - Date.parse('2026-09-10T10:00:00Z')) / 86400000).toFixed(1)))
  assert.deepEqual(s.cutoff, { mergeSha: shared, mergedAt: sel.changes[2].mergedAt })
})

test('a backfilled v1 record adds no change and is read through the converter', () => {
  const root = repo()
  merge(root, 'feat/old', archived('2026-09-02-old', { tasks: 4 }), '2026-09-02T10:00:00Z')
  direct(root, { [`${ARCHIVE}/2026-09-02-old/metrics.json`]: `${JSON.stringify(v1('old'))}\n` }, '2026-09-30T10:00:00Z', 'chore(metrics): backfill old')
  const sel = selectWindow(root, { ref: 'develop' })
  assert.deepEqual(names(sel), ['old'])
  assert.equal(sel.changes[0].direct, false, 'the member is the merge, not the backfill commit')

  const [c] = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF }).changes
  assert.equal(c.record, 'record')
  assert.equal(c.schemaVersion, 1)
  assert.equal(c.tasks, 4)
  assert.equal(c.values['autonomy.sessions'], 2)
  assert.equal(c.values['quality.findings.review'], 3)
  assert.equal(c.values['efficiency.cacheHit'], 0.875)
  assert.equal(c.values['efficiency.invalidReplies'], null, 'a v1 record kept no reply counts')
  assert.match(c.coverage.replies.none, /^v1: /)
})

test('a change with no record is listed with coverage none and contributes no zeros', () => {
  const root = repo()
  merge(root, 'feat/a', { ...archived('2026-09-02-a', { record: v2('a', { rounds: 3 }) }), 'src/x.txt': 'x\n' }, '2026-09-02T10:00:00Z')
  merge(root, 'feat/b', { ...archived('2026-09-03-b'), 'src/y.txt': 'y\n' }, '2026-09-03T10:00:00Z')
  const s = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF })
  const b = s.changes.find((c) => c.change === 'b')
  assert.match(b.record.none, /^no metrics\.json at develop:openspec\/changes\/archive\/2026-09-03-b\/metrics\.json$/)
  for (const [group, cover] of Object.entries(b.coverage)) if (group !== 'diffLines') assert.ok(cover.none, `${group} has a reason`)
  for (const m of METRICS.filter((m) => m.needs.length > 0)) assert.equal(b.values[m.key], null, m.key)
  assert.equal(b.values['quality.fixesAfter'], 0, 'the git figures are measured for every change')
  assert.equal(b.git.diffLines, 1)
  assert.deepEqual(s.coverage, { records: 1, changes: 2 })
  assert.equal(s.aggregates['quality.reviewRounds'].n, 1)
  assert.equal(s.aggregates['quality.reviewRounds'].mean, 3, 'the missing record is excluded, not averaged in as 0')
  assert.equal(s.aggregates['quality.reviewRounds'].perTask, 1.5)
  assert.equal(s.aggregates['quality.reviewRounds'].perKloc, 3000)
})

test('an unmerged window retro does not move the window; a merged one does', () => {
  const root = repo()
  const first = merge(root, 'feat/a', archived('2026-09-02-a'), '2026-09-02T10:00:00Z')
  // The retro's branch holds a sidecar cutting off at a; it has not merged.
  g(root, ['checkout', '-q', '-b', 'chore/retro/2026-09-05', 'develop'])
  direct(root, sidecarFile(root, '2026-09-05', 'window', { mergeSha: first, mergedAt: '2026-09-02T10:00:00Z' }), '2026-09-05T10:00:00Z', 'docs(retro): window retrospective 2026-09-05')
  g(root, ['checkout', '-q', 'develop'])
  merge(root, 'feat/b', archived('2026-09-06-b'), '2026-09-06T10:00:00Z')
  // A sidecar in the working tree is not the ref's either.
  mkdirSync(join(root, '.adf', 'retro'), { recursive: true })
  writeFileSync(join(root, '.adf', 'retro', '2026-09-07-window.json'), JSON.stringify({ cutoff: { mergeSha: first } }))

  assert.equal(previousRetro(root, { ref: 'develop' }), null)
  assert.deepEqual(names(selectWindow(root, { ref: 'develop' })), ['a', 'b'])

  g(root, ['merge', '-q', '--no-ff', '-m', "Merge branch 'chore/retro/2026-09-05' into 'develop'", 'chore/retro/2026-09-05'], '2026-09-08T10:00:00Z')
  const prev = previousRetro(root, { ref: 'develop' })
  assert.equal(prev.date, '2026-09-05')
  assert.equal(prev.cutoff.mergeSha, first)
  assert.deepEqual(names(selectWindow(root, { ref: 'develop' })), ['b'])
  merge(root, 'feat/c', archived('2026-09-09-c'), '2026-09-09T10:00:00Z')
  const since = sinceLastRetro(root, { ref: 'develop' })
  assert.deepEqual(since, { ref: 'develop', fetchedAt: null, previous: { date: '2026-09-05', path: '.adf/retro/2026-09-05-window.json', cutoff: prev.cutoff }, count: 2, changes: ['b', 'c'], lintDue: false })
})

test('a change or period retro does not move the window', () => {
  const root = repo()
  const a = merge(root, 'feat/a', archived('2026-09-02-a'), '2026-09-02T10:00:00Z')
  direct(root, { ...sidecarFile(root, '2026-09-03', 'change', { mergeSha: a }), ...sidecarFile(root, '2026-09-03', 'period', { mergeSha: a }) }, '2026-09-03T10:00:00Z', 'docs(retro): change retrospective 2026-09-03')
  merge(root, 'feat/b', archived('2026-09-04-b'), '2026-09-04T10:00:00Z')
  assert.equal(previousRetro(root, { ref: 'develop' }), null)
  assert.deepEqual(names(selectWindow(root, { ref: 'develop' })), ['a', 'b'])
})

test('mode change selects one change; mode period the changes merged within the dates', () => {
  const root = repo()
  merge(root, 'feat/a', archived('2026-10-01-a'), '2026-10-01T10:00:00Z')
  merge(root, 'feat/b', archived('2026-10-05-b'), '2026-10-05T10:00:00Z')
  merge(root, 'feat/c', archived('2026-10-09-c'), '2026-10-09T23:30:00Z')
  merge(root, 'feat/d', archived('2026-10-10-d'), '2026-10-10T00:30:00Z')
  // The same change archived twice: the newest directory is the one a change retro reads.
  merge(root, 'feat/b-again', archived('2026-10-11-b'), '2026-10-11T10:00:00Z')

  const period = selectWindow(root, { ref: 'develop', mode: 'period', from: '2026-10-02', to: '2026-10-09' })
  assert.deepEqual(names(period), ['b', 'c'])
  assert.deepEqual(period.scope, { from: '2026-10-02', to: '2026-10-09' })
  assert.equal(period.cutoff, null)
  const one = selectWindow(root, { ref: 'develop', mode: 'change', change: 'b' })
  assert.deepEqual(one.changes.map((c) => c.archiveDir), [`${ARCHIVE}/2026-10-11-b`])
  assert.throws(() => selectWindow(root, { ref: 'develop', mode: 'change', change: 'zz' }), /no archive directory of change "zz" in develop/)
  assert.throws(() => selectWindow(root, { ref: 'develop', mode: 'period', from: '2026-10-09', to: '2026-10-02' }), /starts after it ends/)
  assert.throws(() => selectWindow(root, { ref: 'develop', mode: 'period', from: '10/02' }), /YYYY-MM-DD/)
  const s = buildSidecar(root, { ref: 'develop', mode: 'change', change: 'c', date: DATE, asOf: AS_OF })
  assert.equal(s.mode, 'change')
  assert.equal(s.cutoff, null)
  assert.deepEqual(names(s), ['c'])
})

test('an undated archive directory keeps its commit order and is not sorted first', () => {
  const root = repo()
  merge(root, 'feat/a', archived('2026-09-02-a'), '2026-09-02T10:00:00Z')
  merge(root, 'feat/old', { ...archived('1-legacy'), ...archived('2026-09-03-b') }, '2026-09-03T10:00:00Z')
  assert.deepEqual(names(selectWindow(root, { ref: 'develop' })), ['a', 'b', '1-legacy'])
})

test('the delta follows each metric direction and compares only what both windows measured', () => {
  const prev = {
    aggregates: {
      'cost.tokens': { n: 2, mean: 100, median: 100, perTask: 50, perKloc: null },
      'efficiency.cacheHit': { n: 2, mean: 0.8, median: 0.8, perTask: null, perKloc: null },
      'efficiency.mechanicalShare': { n: 2, mean: 0.5, median: 0.5, perTask: null, perKloc: null },
      'quality.reviewRounds': { n: 2, mean: 1, median: 1, perTask: null, perKloc: null },
      'predictability.minutesPerTask': { n: 2, mean: 10, median: 10, perTask: null, perKloc: null, cv: 0.5 },
      'autonomy.clears': { n: 0, mean: null, median: null, perTask: null, perKloc: null },
      'gone.metric': { n: 1, mean: 1, median: 1 }
    }
  }
  const cur = {
    'cost.tokens': { n: 3, mean: 80, median: 120, perTask: 40, perKloc: 10 },
    'efficiency.cacheHit': { n: 3, mean: 0.9, median: 0.7, perTask: null, perKloc: null },
    'efficiency.mechanicalShare': { n: 3, mean: 0.5, median: 0.5, perTask: null, perKloc: null },
    'quality.reviewRounds': { n: 0, mean: null, median: null, perTask: null, perKloc: null },
    'predictability.minutesPerTask': { n: 3, mean: 10, median: 10, perTask: null, perKloc: null, cv: 0.2 },
    'autonomy.clears': { n: 3, mean: 0, median: 0, perTask: 0, perKloc: 0 }
  }
  const d = delta(prev, cur)
  const rows = (list) => list.map((r) => `${r.metric} ${r.stat}`).sort()
  assert.deepEqual(rows(d.improved), ['cost.tokens mean', 'cost.tokens perTask', 'efficiency.cacheHit mean', 'predictability.minutesPerTask cv'])
  assert.deepEqual(rows(d.worsened), ['cost.tokens median', 'efficiency.cacheHit median'])
  assert.deepEqual(rows(d.unchanged), ['efficiency.mechanicalShare mean', 'efficiency.mechanicalShare median', 'predictability.minutesPerTask mean', 'predictability.minutesPerTask median'])
  const skipped = Object.fromEntries(d.notCompared.map((r) => [`${r.metric}${r.stat ? ` ${r.stat}` : ''}`, r.reason]))
  assert.equal(skipped['cost.tokens perKloc'], 'the previous window has no value')
  assert.equal(skipped['quality.reviewRounds'], 'this window did not measure it')
  assert.equal(skipped['autonomy.clears'], 'the previous window did not measure it')
  assert.equal(skipped['gone.metric'], 'no direction is fixed for this metric')
  assert.deepEqual(d.improved.find((r) => r.metric === 'cost.tokens' && r.stat === 'mean'), { metric: 'cost.tokens', stat: 'mean', previous: 100, current: 80 })
  for (const m of METRICS) assert.ok(['lower', 'higher'].includes(DIRECTION[m.key]), m.key)
})

test('a window after a merged retro carries the delta against it', () => {
  const root = repo()
  const a = merge(root, 'feat/a', archived('2026-09-02-a', { record: v2('a', { rounds: 3 }) }), '2026-09-02T10:00:00Z')
  const first = buildSidecar(root, { ref: 'develop', date: '2026-09-03', asOf: '2026-09-03T00:00:00.000Z' })
  assert.equal(first.delta, null, 'the baseline has no previous retro')
  assert.equal(first.previous, null)
  assert.equal(first.cutoff.mergeSha, a)
  direct(root, { '.adf/retro/2026-09-03-window.json': `${JSON.stringify(first)}\n` }, '2026-09-03T10:00:00Z', 'docs(retro): window retrospective 2026-09-03')
  merge(root, 'feat/b', archived('2026-09-04-b', { record: v2('b', { rounds: 1 }) }), '2026-09-04T10:00:00Z')
  const second = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF })
  assert.deepEqual(names(second), ['b'])
  assert.equal(second.previous.date, '2026-09-03')
  assert.deepEqual(second.delta.improved.find((r) => r.metric === 'quality.reviewRounds' && r.stat === 'mean'), { metric: 'quality.reviewRounds', stat: 'mean', previous: 3, current: 1 })
  assert.deepEqual(second.flowVersions, [{ generator: 'adf 0.11.0', changes: ['b'] }])
})

test('an empty window keeps the previous cut-off', () => {
  const root = repo()
  const a = merge(root, 'feat/a', archived('2026-09-02-a'), '2026-09-02T10:00:00Z')
  direct(root, sidecarFile(root, '2026-09-03', 'window', { mergeSha: a, mergedAt: 'x' }), '2026-09-03T10:00:00Z', 'docs(retro): window retrospective 2026-09-03')
  const s = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF })
  assert.deepEqual(s.changes, [])
  assert.deepEqual(s.cutoff, { mergeSha: a, mergedAt: 'x' })
  assert.throws(() => selectWindow(root, { ref: 'develop', previous: { path: 'p', cutoff: { mergeSha: 'f'.repeat(40) } } }), /is not a first-parent commit of develop/)
})

test('removal candidates come from every record in the ref, not only the window', () => {
  const root = repo()
  for (const [i, day] of ['02', '03', '04'].entries()) {
    merge(root, `feat/c${i}`, archived(`2026-09-${day}-c${i}`, { record: v2(`c${i}`, { findings: { review: 1, sweep: 0 }, generatedAt: `2026-09-${day}T12:00:00.000Z` }) }), `2026-09-${day}T10:00:00Z`)
  }
  const s = buildSidecar(root, { ref: 'develop', mode: 'change', change: 'c2', date: DATE, asOf: AS_OF })
  assert.deepEqual(s.candidates, { records: 3, skipped: [], layers: ['sweep'], checks: [] })
})

test('the waiting items: known metric keys, the handoff threshold first, values from the aggregates', () => {
  const items = readWaiting()
  assert.equal(items[0].id, 'handoff-threshold')
  assert.equal(items.length, 5)
  for (const item of items) {
    assert.ok(item.question && item.lessons?.file && item.lessons.row, item.id)
    for (const key of item.metrics) assert.ok(DIRECTION[key], `${item.id}: ${key}`)
  }
  const agg = aggregate([{ change: 'a', record: null, coverage: {}, git: { fixesAfter: 1, exposureDays: 7, diffLines: 10 }, tasks: 2 }])
  const recite = waitingItems(agg, items).find((i) => i.id === 'recite-before-solving')
  assert.deepEqual(recite.metrics.find((m) => m.key === 'quality.fixesPerChangeWeek'), { key: 'quality.fixesPerChangeWeek', ...agg['quality.fixesPerChangeWeek'] })
  assert.equal(agg['quality.fixesPerChangeWeek'].mean, 1)
})

test('sinceLastRetro counts the changes since the last window retro; the lint is due at 3', () => {
  const root = repo()
  for (const day of ['02', '03', '04']) merge(root, `feat/c${day}`, archived(`2026-09-${day}-c${day}`), `2026-09-${day}T10:00:00Z`)
  const since = sinceLastRetro(root, { ref: 'develop' })
  assert.equal(since.count, 3)
  assert.equal(since.lintDue, true)
  assert.equal(since.previous, null)
  assert.equal(since.fetchedAt, null, 'a local ref has no fetch time')
})

test('fetchRef fetches the remote-tracking integration ref; the readers use it and report the fetch', () => {
  const upstream = repo()
  merge(upstream, 'feat/a', archived('2026-09-02-a'), '2026-09-02T10:00:00Z')
  const clone = join(dirname(upstream), 'clone')
  execFileSync('git', ['clone', '-q', '-b', 'develop', upstream, clone])
  assert.equal(integrationRef(clone), 'origin/develop')
  merge(upstream, 'feat/b', archived('2026-09-03-b'), '2026-09-03T10:00:00Z')
  assert.equal(sinceLastRetro(clone).count, 1, 'without a fetch the ref is behind')
  const now = new Date('2026-10-19T08:00:00.000Z')
  const fetched = fetchRef(clone, { now: () => now })
  assert.deepEqual(fetched, { ref: 'origin/develop', fetched: true, fetchedAt: now.toISOString(), reason: null })
  const since = sinceLastRetro(clone, { fetchedAt: fetched.fetchedAt })
  assert.equal(since.count, 2)
  assert.equal(since.fetchedAt, now.toISOString())
  assert.match(sinceLastRetro(clone).fetchedAt, /^\d{4}-\d{2}-\d{2}T/, 'the last fetch time from FETCH_HEAD')
  assert.equal(fetchRef(clone, { ref: 'develop' }).fetched, false)
  g(clone, ['remote', 'set-url', 'origin', join(dirname(upstream), 'gone')])
  const failed = fetchRef(clone)
  assert.equal(failed.fetched, false)
  assert.match(failed.reason, /^git fetch failed/)
  assert.ok(failed.fetchedAt, 'a failed fetch keeps the last fetch time')
})

test('the token total counts thinking once, inside output', () => {
  const total = { input: 10, output: 100, thinking: 40, cacheRead: 5, cacheWrite5m: 2, cacheWrite1h: 1 }
  const values = changeValues({ record: { tokens: { total } }, coverage: { tokens: 'record' }, tasks: 1 })
  assert.equal(values['cost.tokens'], 118)
})
