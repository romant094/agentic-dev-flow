#!/usr/bin/env node
// Dev tool: the origin's window retrospective against the port's, over the same ref and records.
// The origin's side is its CLI `adf-metrics.mjs --window --out <temp> --no-prices --date <d>
// --repo <origin>`, run from a copy of its scripts under the system temp directory
// (lib/origin-metrics.mjs); it writes only the sidecar and report into `--out`, inside that
// directory, removed at the end. The port's side is `buildSidecar` (plugins/adf/scripts/lib/
// window.mjs) on the origin with mode window, ref `origin/develop` and `.claude/memory/**`
// excluded, the origin's own exclusion. Both take yesterday's UTC date, so both count fix commits
// up to the same instant. A case of the same tool: the origin's `--since-retro` count against
// `sinceLastRetro`.
//
//   node scripts/parity/origin-window.mjs <origin project root> [--all]
//
// --all also prints every change's compared values.
//
// Compared: membership (change, archive directory, merge, merge time, branch, in order); per
// change the task count and the git figures (diff lines, fix commits after, exposure days, the
// shared merge); per change every metric both sides define with the same meaning (MAPPED below;
// the origin's `quality.findings.opsx-review` is the port's `quality.findings.ai-review`); per
// mapped metric the aggregates (mean, median, per task, per 1000 lines, n, and the spread where
// the origin reports it) wherever every change's value and denominators agree; the coverage of
// the groups both name (COVERAGE); the removal candidates; the since-retro count.
// Not compared, by design: the dollar metrics (`price-free`: the port's window keeps tokens only;
// the origin's dollars come from the prices its records were written with), the origin's
// `speed.taskMinutes`, `quality.recordedFindings` and `flowMerges`, and the port's metrics over
// groups the origin never recorded (replies, review, tests, context, the token-based shares).
//
// Deliberate differences, counted per class (anything else fails the tool):
//   remeasured       the origin re-measured the group from the transcripts that survive (its
//                    coverage reads `remeasured`, or it has no archived record and its values come
//                    from the re-measure); the port never re-measures: a window reads records only
//   unresolved-zero  the origin's record holds zeros from sessions none of which resolved to a
//                    transcript; the port's converter reads that as no data (`fromV1` coverage
//                    "no session of the record resolved"), so the value is null, not 0
//   mechanical-share the port's share is over the dispatches that carry a capability level; the
//                    origin's is over every dispatch, and by agent type or model `haiku` in a
//                    record from before the levels
//   stray-now        the origin counts the worktrees registered at the retrospective's run
//                    (`git worktree list`) for every change with a branch; the port reads the
//                    record's list and no machine state
//   generated-excluded the port's diff lines also leave out lockfiles, minified and source-map
//                    files (window.mjs EXCLUDED); the difference is exactly their lines
//   follows-values   an aggregate whose inputs differ by the classes above
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from '../../plugins/adf/scripts/lib/changes.mjs'
import { buildSidecar, EXCLUDED, recordOf, sinceLastRetro } from '../../plugins/adf/scripts/lib/window.mjs'
import { copyOriginScripts, count, gitOn, originArg } from './lib/origin-metrics.mjs'

const origin = originArg('origin-window.mjs')
const listAll = process.argv.includes('--all')
const git = gitOn(origin)
const REF = 'origin/develop'
const MEMORY = '.claude/memory/**'
const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

// The port's key of each origin metric both define alike, and the origin coverage keys its value
// rests on (for the `remeasured` class).
const T = ['timing', 'timing.byPhase']
const MAPPED = {
  'speed.activeMinutes': ['speed.activeMinutes', T],
  'speed.elapsedMinutes': ['speed.elapsedMinutes', ['timing']],
  ...Object.fromEntries(['developerMessages', 'askUserQuestion', 'clears', 'sessions', 'rulings'].map((f) => [`autonomy.${f}`, [`autonomy.${f}`, ['autonomy']]])),
  'cost.tokens': ['cost.tokens', ['cost']],
  'cost.coldResumes': ['cost.coldResumes', ['cost', 'cost.cacheTtl']],
  'efficiency.cacheHit': ['efficiency.cacheHit', ['cost']],
  'efficiency.roundsPerTask': ['efficiency.roundsPerTask', ['facts']],
  'efficiency.outliers': ['efficiency.outliers', ['facts', 'facts.outliers']],
  'efficiency.mechanicalShare': ['efficiency.mechanicalShare', ['facts']],
  ...Object.fromEntries(['review', 're-review', 'final-review', 'merge-review', 'sweep', 'opsx-review'].map((l) => [`quality.findings.${l}`, [`quality.findings.${l === 'opsx-review' ? 'ai-review' : l}`, []]])),
  'quality.unresolvedDebt': ['quality.unresolvedDebt', []],
  'quality.fixesAfter': ['quality.fixesAfter', []],
  'quality.fixesPerChangeWeek': ['quality.fixesPerChangeWeek', []],
  'isolation.foreignBranchRecords': ['isolation.foreignBranchRecords', ['isolation']],
  'isolation.filesOutsidePlan': ['isolation.filesOutsidePlan', ['isolation']],
  'isolation.strayWorktrees': ['isolation.strayWorktrees', ['isolation']],
  'overhead.timeShare': ['overhead.timeShare', T],
  'predictability.minutesPerTask': ['predictability.minutesPerTask', T]
}
// The origin's coverage key against the port's coverage: whether the port reads the group.
const COVERAGE = {
  cost: (p) => p.coverage.tokens === 'record',
  facts: (p) => p.coverage.dispatches === 'record',
  autonomy: (p) => p.coverage.autonomy === 'record',
  timing: (p) => p.coverage.timing === 'record',
  isolation: (p) => p.coverage.isolation === 'record',
  'facts.outliers': (p) => p.coverage.outliers === 'record',
  'cost.cacheTtl': (p) => p.coverage.cacheTtl === 'record',
  'cost.byPhase': (p) => p.coverage.tokens === 'record',
  'timing.byPhase': (p, record) => p.coverage.timing === 'record' && record?.timing?.activeMinutes != null,
  diffLines: (p) => p.coverage.diffLines === 'git'
}

// The origin's coverage keys whose group only a resolved transcript gives.
const TRANSCRIPT_KEYS = ['cost', 'facts', 'autonomy', 'facts.outliers', 'cost.cacheTtl', 'cost.byPhase']

const out = { date, ref: REF, membership: null, changes: 0, compared: {}, classes: {}, aggregates: { compared: 0, follows: 0 }, coverage: { compared: 0 }, candidates: null, since: null, rows: [], unexplained: [] }
const fail = (change, what, detail) => out.unexplained.push({ change, what, ...detail })
const classed = (c) => count(out.classes, c)
const near = (a, b) => (a === null && b === null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)
const originValue = (c, key) => {
  const dot = key.indexOf('.')
  return c.values?.[key.slice(0, dot)]?.[key.slice(dot + 1)] ?? null
}

// The lines of a merge's first-parent diff in paths the port alone excludes.
const portOnly = EXCLUDED.filter((g) => g !== 'openspec/changes/**').map(globToRegExp)
function generatedLines(sha) {
  let n = 0
  for (const line of git('diff', '--no-renames', '--numstat', `${sha}^1`, sha).split('\n')) {
    const [ins, del, path] = line.split('\t')
    if (path && portOnly.some((p) => p.test(path)) && !path.startsWith('.claude/memory/')) n += (Number(ins) || 0) + (Number(del) || 0)
  }
  return n
}

const scripts = copyOriginScripts(origin)
let theirs
let sinceText
try {
  const outDir = join(scripts.dir, 'out')
  const run = spawnSync('node', [scripts.path('adf-metrics.mjs'), '--window', '--out', outDir, '--no-prices', '--date', date, '--repo', origin], { encoding: 'utf8', cwd: scripts.dir, maxBuffer: 1 << 28 })
  if (run.status !== 0) throw new Error(`the origin's --window stopped: ${run.stderr.trim().split('\n').slice(-3).join(' ')}`)
  theirs = JSON.parse(readFileSync(join(outDir, `${date}.json`), 'utf8'))
  theirs.markdown = readFileSync(join(outDir, `${date}.md`), 'utf8')
  const since = spawnSync('node', [scripts.path('adf-metrics.mjs'), '--since-retro', '--repo', origin], { encoding: 'utf8', cwd: scripts.dir })
  if (since.status !== 0) throw new Error(`the origin's --since-retro stopped: ${since.stderr.trim().split('\n')[0]}`)
  sinceText = since.stdout.trim()
} finally {
  scripts.remove()
}
const ours = buildSidecar(origin, { mode: 'window', ref: REF, date, exclude: [MEMORY] })

// ---------------------------------------------------------------- membership

const key = (c) => [c.change, c.archiveDir, c.mergeSha, c.mergedAt, c.branch].join(' ')
const a = theirs.changes.map(key)
const b = ours.changes.map(key)
out.membership = { origin: a.length, port: b.length, equal: a.join('\n') === b.join('\n') }
if (!out.membership.equal) fail('*', 'membership', { onlyOrigin: a.filter((k) => !b.includes(k)), onlyPort: b.filter((k) => !a.includes(k)), order: a.length === b.length })
if ((theirs.cutoff?.mergeSha ?? null) !== (ours.cutoff?.mergeSha ?? null)) fail('*', 'cutoff', { origin: theirs.cutoff, port: ours.cutoff })

// ---------------------------------------------------------------- per change

const records = new Map(ours.changes.map((c) => [c.archiveDir, c]))
const archived = new Map()
for (const c of theirs.changes) {
  const text = git.orNull('show', `${REF}:${c.archiveDir}/metrics.json`)
  archived.set(c.archiveDir, text === null ? null : JSON.parse(text))
}
// The port's record of a change as buildSidecar read it (for the timing coverage).
const portRecord = (dir) => {
  const text = git.orNull('show', `${REF}:${dir}/metrics.json`)
  return recordOf(text, dir).record
}

const differing = {} // origin metric -> classes of its differing changes
for (const t of theirs.changes) {
  const p = records.get(t.archiveDir)
  if (!p) continue
  out.changes++
  const row = { change: t.change, classes: {}, values: {} }
  out.rows.push(row)
  const cls = (metric, c) => {
    classed(c)
    row.classes[metric] = c
    ;(differing[metric] ??= new Set()).add(c)
  }
  const old = archived.get(t.archiveDir)
  const resolved = (old?.sessions ?? []).some((s) => s.resolved)
  const pr = portRecord(t.archiveDir)

  // Task count and git figures.
  count(out.compared, 'tasks')
  if (t.tasks !== p.tasks) fail(t.change, 'tasks', { origin: t.tasks, port: p.tasks })
  for (const f of ['fixesAfter', 'exposureDays']) {
    count(out.compared, `git.${f}`)
    if (!near(t.git?.[f] ?? null, p.git?.[f] ?? null)) fail(t.change, `git.${f}`, { origin: t.git?.[f], port: p.git?.[f] })
  }
  count(out.compared, 'git.diffLines')
  const [td, pd] = [t.git?.sharedMerge?.diffLines ?? t.git?.diffLines, p.git?.sharedMerge?.diffLines ?? p.git?.diffLines]
  if (td !== pd) {
    if (typeof td === 'number' && typeof pd === 'number' && td - pd === generatedLines(t.mergeSha)) cls('git.diffLines', 'generated-excluded')
    else fail(t.change, 'git.diffLines', { origin: td, port: pd })
  }
  if (JSON.stringify(t.git?.sharedMerge?.changes ?? null) !== JSON.stringify(p.git?.sharedMerge?.changes ?? null)) fail(t.change, 'git.sharedMerge', { origin: t.git?.sharedMerge?.changes, port: p.git?.sharedMerge?.changes })

  // Values.
  for (const [metric, [portKey, rests]] of Object.entries(MAPPED)) {
    const o = originValue(t, metric)
    const v = p.values[portKey] ?? null
    count(out.compared, metric)
    if (listAll) row.values[metric] = [o, v]
    if (near(o, v)) continue
    const remeasured = old === null ? o !== null : rests.some((k) => t.coverage?.[k] === 'remeasured')
    if (remeasured) cls(metric, 'remeasured')
    else if (old !== null && !resolved && v === null && rests.some((k) => k === 'cost' || k === 'facts' || k === 'autonomy')) cls(metric, 'unresolved-zero')
    else if (metric === 'efficiency.mechanicalShare') cls(metric, 'mechanical-share')
    else if (metric === 'isolation.strayWorktrees' && Array.isArray(t.git?.strayWorktrees)) cls(metric, 'stray-now')
    else {
      const thinking = old?.cost?.total?.thinking
      const note = metric === 'cost.tokens' && typeof thinking === 'number' && v - o === thinking ? 'port defect: window.mjs tokensOf adds `thinking`, which `output` already counts (transcripts.mjs responses; prices.mjs costOf)' : undefined
      fail(t.change, metric, { origin: o, port: v, ...(note ? { note } : {}) })
    }
  }

  // Coverage of the groups both name.
  for (const [k, read] of Object.entries(COVERAGE)) {
    const tc = t.coverage?.[k]
    const theirsRecord = tc === 'record' || tc === 'git'
    const oursRecord = read(p, pr)
    out.coverage.compared++
    if (theirsRecord === oursRecord) continue
    if (tc === 'remeasured') cls(`coverage.${k}`, 'remeasured')
    else if (theirsRecord && !resolved && old !== null && TRANSCRIPT_KEYS.includes(k)) cls(`coverage.${k}`, 'unresolved-zero')
    else fail(t.change, `coverage.${k}`, { origin: tc, port: k === 'diffLines' ? p.coverage.diffLines : oursRecord })
  }
}

// ---------------------------------------------------------------- aggregates

const STATS = ['mean', 'median', 'perTask', 'perKloc', 'n']
const SPREAD = ['iqr', 'cv']
for (const [metric, [portKey]] of Object.entries(MAPPED)) {
  const dot = metric.indexOf('.')
  const ta = theirs.aggregates?.[metric.slice(0, dot)]?.[metric.slice(dot + 1)]
  const pa = ours.aggregates[portKey]
  if (!ta || !pa) {
    fail('*', `aggregate ${metric}`, { origin: ta ?? null, port: pa ?? null })
    continue
  }
  const stats = 'iqr' in ta ? [...STATS, ...SPREAD] : STATS
  const unequal = stats.filter((s) => !near(ta[s] ?? null, pa[s] ?? null))
  if (differing[metric] || differing['git.diffLines']) {
    out.aggregates.follows++
    if (unequal.length > 0) classed('follows-values')
    continue
  }
  out.aggregates.compared++
  if (unequal.length > 0) fail('*', `aggregate ${metric}`, { stats: unequal, origin: Object.fromEntries(unequal.map((s) => [s, ta[s]])), port: Object.fromEntries(unequal.map((s) => [s, pa[s]])) })
}

// ---------------------------------------------------------------- candidates and since

const candidatesText = /### Removal candidates\n\n([\s\S]*?)\n*$/.exec(theirs.markdown)?.[1]?.trim() ?? null
const theirLayers = candidatesText === 'No removal candidates.' ? [] : (candidatesText ?? '?').split('\n').map((l) => /^(\S+): 0 findings/.exec(l)?.[1] ?? `?${l}`)
const ourLayers = ours.candidates.layers.map((l) => (l === 'ai-review' ? 'opsx-review' : l))
out.candidates = { origin: theirLayers, port: ourLayers, portChecks: ours.candidates.checks }
if (theirLayers.sort().join() !== [...ourLayers].sort().join() || ours.candidates.checks.length > 0) fail('*', 'candidates', out.candidates)

const sinceCount = Number(/^(\d+) changes/.exec(sinceText)?.[1] ?? Number.NaN)
const port = sinceLastRetro(origin, { ref: REF })
out.since = { origin: sinceText, port: { count: port.count, previous: port.previous, lintDue: port.lintDue } }
if (sinceCount !== port.count) fail('*', 'since', { origin: sinceCount, port: port.count })
if (/no retrospective has been merged yet/.test(sinceText) !== (port.previous === null)) fail('*', 'since', { origin: sinceText, port: port.previous })

if (!listAll) out.rows = out.rows.filter((r) => Object.keys(r.classes).length > 0 || out.unexplained.some((u) => u.change === r.change))
console.log(JSON.stringify(out, null, 2))
process.exitCode = out.unexplained.length === 0 ? 0 : 1
