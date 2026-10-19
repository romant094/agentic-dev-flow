// The changes a retrospective covers and every number it reasons over, computed by script and
// written nowhere: the retro CLI writes the sidecar this module returns.
//
// Retrospectives are committed in the host under `.adf/retro/<date>-<mode>.json` (the sidecar)
// and `.md` (the report). Everything here is read from the integration ref's tree and history,
// never from the working tree, so a retrospective committed on a branch that has not merged
// does not move the window. Fetching the ref is the caller's: `fetchRef` does it and says when.
//
//   previousRetro  the newest window sidecar in the ref's tree; only a window retro anchors
//   selectWindow   the changes of a mode: `window` (every change whose archive directory a
//                  first-parent commit added after the previous window's cut-off; all of them
//                  when there is none), `change` (one change) or `period` (added within
//                  [from, to]); one `git log` parse over the ref's first-parent history
//   buildSidecar   the retro agent's input and the next window's anchor: each change's record
//                  values and coverage, git figures, aggregates, the delta against the previous
//                  window, removal candidates and the items waiting for data
//   sinceLastRetro archive's report line: the changes archived since the last window retro
//
// A change whose record is absent or unreadable is listed with coverage `{ none: reason }` for
// every group and contributes no value: no data is never a zero. A record is never written or
// re-measured here; the change worktree its sources lived in is gone by the time a window runs.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { requireBranches } from './branches.mjs'
import { ARCHIVE, CHANGES_DIR, globToRegExp, parseTasks } from './changes.mjs'
import { median, TOKEN_FIELDS } from './metrics-facts.mjs'
import { LAYERS, removalCandidates } from './metrics-records.mjs'
import { asV2, GROUPS, PLUGIN_ROOT, RECORD_FILE, validateRecord } from './metrics.mjs'
import { readDebtRoot } from './registry.mjs'

export const RETRO_DIR = '.adf/retro'
export const MODES = ['window', 'change', 'period']
export const SIDECAR_VERSION = 1
export const WAITING_PATH = join(PLUGIN_ROOT, 'schema', 'retro-waiting.json')
// The corpus lint is due when this many changes were archived since the last window retro.
export const LINT_DUE = 3
const ARCHIVE_ROOT = `${CHANGES_DIR}/${ARCHIVE}/`
const SIDECAR = /^(\d{4}-\d{2}-\d{2})-(window|change|period)\.json$/
const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86400000
const MERGE_SUBJECT = /^Merge branch '([^']+)'/
const FIX_SUBJECT = /^fix(\([^)]*\))?!?:/

// Paths that are not a change's delivered work: the flow's bookkeeping and generated files. The
// registry's debt tree is added at run time; `exclude` adds more.
export const EXCLUDED = [
  `${CHANGES_DIR}/**`,
  '.adf/**',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map'
]

// ---------------------------------------------------------------- git

function gitIn(root) {
  return (args, { input } = {}) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, encoding: input === undefined ? 'utf8' : 'buffer', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024 })
}

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}

// The integration branch's remote-tracking ref when there is one, else the local branch, as the
// apply phase picks a base (lib/plan-symbols.mjs `baseRef`).
export function integrationRef(root) {
  const { integration } = requireBranches(root)
  const git = gitIn(root)
  return attempt(() => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${integration}`])) ? `origin/${integration}` : integration
}

const remoteOf = (root, ref) => {
  const m = /^([^/]+)\/(.+)$/.exec(ref)
  if (!m) return null
  return attempt(() => gitIn(root)(['remote', 'get-url', m[1]])) ? { remote: m[1], branch: m[2] } : null
}

// When the repository last fetched, from FETCH_HEAD's time; null for a local ref or no fetch.
export function lastFetchAt(root, ref) {
  if (!remoteOf(root, ref)) return null
  const common = attempt(() => gitIn(root)(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  if (!common) return null
  return attempt(() => statSync(join(common, 'FETCH_HEAD')).mtime.toISOString())
}

// Fetches a remote-tracking ref. A local ref is not fetched; a failed fetch keeps the last one
// and says so. Callers run this before the pure readers below.
export function fetchRef(root, { ref = integrationRef(root), now = () => new Date() } = {}) {
  const remote = remoteOf(root, ref)
  if (!remote) return { ref, fetched: false, fetchedAt: null, reason: `${ref} is a local branch` }
  try {
    gitIn(root)(['fetch', '--quiet', remote.remote, remote.branch])
    return { ref, fetched: true, fetchedAt: now().toISOString(), reason: null }
  } catch (error) {
    const reason = String(error.stderr ?? error.message).trim().split('\n')[0]
    return { ref, fetched: false, fetchedAt: lastFetchAt(root, ref), reason: `git fetch failed: ${reason}` }
  }
}

// Files of the ref's tree in one `git cat-file --batch`: a map spec -> text, null when absent.
export function readBlobs(root, ref, paths) {
  const out = new Map()
  if (paths.length === 0) return out
  const buf = gitIn(root)(['cat-file', '--batch'], { input: Buffer.from(`${paths.map((p) => `${ref}:${p}`).join('\n')}\n`) })
  let at = 0
  for (const path of paths) {
    const nl = buf.indexOf(10, at)
    const head = buf.subarray(at, nl).toString('utf8')
    at = nl + 1
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(head)
    if (!m) {
      out.set(path, null)
      continue
    }
    const size = Number(m[2])
    out.set(path, m[1] === 'blob' ? buf.subarray(at, at + size).toString('utf8') : null)
    at += size + 1
  }
  return out
}

// ---------------------------------------------------------------- previous retro

// The newest window sidecar in the ref's tree, or null. A change or period sidecar never
// anchors a window. A newest sidecar that does not parse is an error, never a silent baseline.
export function previousRetro(root, { ref = integrationRef(root) } = {}) {
  const git = gitIn(root)
  const names = git(['ls-tree', '--name-only', ref, `${RETRO_DIR}/`])
    .split('\n')
    .filter(Boolean)
    .map((path) => ({ path, m: SIDECAR.exec(path.slice(RETRO_DIR.length + 1)) }))
    .filter((p) => p.m && p.m[2] === 'window')
    .sort((a, b) => a.path.localeCompare(b.path))
  const newest = names.at(-1)
  if (!newest) return null
  let sidecar
  try {
    sidecar = JSON.parse(git(['show', `${ref}:${newest.path}`]))
  } catch (error) {
    throw new Error(`${ref}:${newest.path} does not parse as a retro sidecar: ${error.message}`)
  }
  return { date: newest.m[1], path: newest.path, cutoff: sidecar.cutoff ?? null, sidecar }
}

// ---------------------------------------------------------------- history

// The ref's first-parent history, oldest first, in one `git log`: each commit with its parents,
// committer date, subject, and its first-parent diff (status and lines per file).
export function readHistory(root, ref) {
  const text = gitIn(root)(['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--raw', '--numstat', '--format=%x1e%H%x09%P%x09%cI%x09%s', ref])
  const commits = []
  for (const chunk of text.split('\x1e').slice(1)) {
    const [header, ...rest] = chunk.split('\n')
    const [sha, parents, at, ...subject] = header.split('\t')
    const files = new Map()
    for (const line of rest) {
      if (line.startsWith(':')) {
        const tab = line.indexOf('\t')
        const status = line.slice(0, tab).split(' ')[4]?.[0]
        const path = line.slice(tab + 1)
        files.set(path, { status, lines: files.get(path)?.lines ?? 0 })
        continue
      }
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
      if (!m) continue
      // A binary file prints `-` for both counts and adds no lines.
      const lines = (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]))
      files.set(m[3], { status: files.get(m[3])?.status ?? 'M', lines })
    }
    commits.push({ sha, parents: parents.split(' ').filter(Boolean), at, subject: subject.join('\t'), files })
  }
  return commits.reverse()
}

// The archive directories each commit added, oldest first: a directory is added by the first
// commit that brings a file into it, so a file added later to a directory already present (a
// backfilled record) adds no change. Within one commit, dated directories by name, undated ones
// after them.
export function archivedEntries(history) {
  const seen = new Set()
  const entries = []
  for (const c of history) {
    const added = new Set()
    for (const path of c.files.keys()) {
      if (!path.startsWith(ARCHIVE_ROOT)) continue
      const rest = path.slice(ARCHIVE_ROOT.length)
      const slash = rest.indexOf('/')
      if (slash <= 0) continue
      const dir = rest.slice(0, slash)
      if (!seen.has(dir)) added.add(dir)
    }
    const order = (d) => (DATED.test(d) ? `0${d}` : `1${d}`)
    for (const dir of [...added].sort((a, b) => order(a).localeCompare(order(b)))) {
      seen.add(dir)
      const dated = DATED.exec(dir)
      entries.push({
        change: dated ? dated[2] : dir,
        archiveDir: `${ARCHIVE_ROOT}${dir}`,
        archivedOn: dated ? dated[1] : null,
        mergeSha: c.sha,
        mergedAt: c.at,
        direct: c.parents.length < 2,
        branch: c.parents.length > 1 ? (MERGE_SUBJECT.exec(c.subject)?.[1] ?? null) : null
      })
    }
  }
  return entries
}

const utcDay = (at) => new Date(at).toISOString().slice(0, 10)

// The changes of one retrospective. `previous` defaults to the newest window sidecar in the ref;
// pass it to avoid reading the tree twice. Returns { mode, ref, previous, cutoff, scope, changes,
// history }: `cutoff` is where the next window starts after this one (window mode only).
export function selectWindow(root, { mode = 'window', change, from, to, ref = integrationRef(root), previous, history } = {}) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
  history ??= readHistory(root, ref)
  const all = archivedEntries(history)
  previous = previous === undefined ? previousRetro(root, { ref }) : previous
  let changes
  let scope
  let cutoff = null
  if (mode === 'window') {
    const since = previous?.cutoff?.mergeSha ?? null
    let start = 0
    if (since !== null) {
      const at = history.findIndex((c) => c.sha === since)
      if (at === -1) throw new Error(`cut-off ${since} of ${previous.path} is not a first-parent commit of ${ref}`)
      const after = new Set(history.slice(at + 1).map((c) => c.sha))
      start = all.findIndex((e) => after.has(e.mergeSha))
      if (start === -1) start = all.length
    }
    changes = all.slice(start)
    scope = { since }
    const newest = changes.at(-1)
    cutoff = newest ? { mergeSha: newest.mergeSha, mergedAt: newest.mergedAt } : (previous?.cutoff ?? null)
  } else if (mode === 'change') {
    if (!change) throw new Error('mode change needs the change name')
    const hit = all.filter((e) => e.change === change).at(-1)
    if (!hit) throw new Error(`no archive directory of change "${change}" in ${ref}`)
    changes = [hit]
    scope = { change }
  } else {
    if (!DAY.test(from ?? '') || !DAY.test(to ?? '')) throw new Error('mode period needs --from and --to as YYYY-MM-DD')
    if (from > to) throw new Error(`the period starts after it ends: ${from} > ${to}`)
    changes = all.filter((e) => utcDay(e.mergedAt) >= from && utcDay(e.mergedAt) <= to)
    scope = { from, to }
  }
  return { mode, ref, previous: previous ?? null, cutoff, scope, changes, history }
}

// ---------------------------------------------------------------- records and git figures

const none = (reason) => ({ none: reason })

// A change's record from the ref's text: converted (schemaVersion 1) and checked. `record` is
// null when there is none (`absent`) or it is unusable; `reason` says which.
export function recordOf(text, where) {
  if (text === null) return { record: null, absent: true, reason: `no ${RECORD_FILE} at ${where}` }
  try {
    const record = asV2(JSON.parse(text))
    const errors = validateRecord(record)
    if (errors.length > 0) return { record: null, absent: false, reason: `${where} fails its schema: ${errors.join('; ')}` }
    return { record, absent: false, reason: null }
  } catch (error) {
    return { record: null, absent: false, reason: `${where} could not be read: ${error.message}` }
  }
}

function excluder(root, exclude) {
  const debt = attempt(() => readDebtRoot(root))
  const globs = [...EXCLUDED, ...(debt ? [`${debt.replace(/\/$/, '')}/**`] : []), ...exclude]
  const patterns = globs.map(globToRegExp)
  return (path) => patterns.some((p) => p.test(path))
}

const isFix = (c, second) => FIX_SUBJECT.test(c.subject) || MERGE_SUBJECT.exec(c.subject)?.[1].startsWith('fix/') || FIX_SUBJECT.test(second.get(c.parents[1]) ?? '')

// The git figures of every merge that carries a window change: the lines it changed outside the
// excluded paths, and the later first-parent fix commits up to `asOf` that touch a file it
// changed. Fix work is a commit of type `fix`, a merge of a `fix/` branch, or a merge whose
// second parent's subject is of type `fix`; the second parents' subjects come from one call.
function mergeFigures(root, history, entries, { asOf, excluded }) {
  const index = new Map(history.map((c, i) => [c.sha, i]))
  const shas = [...new Set(entries.map((e) => e.mergeSha))]
  const first = Math.min(...shas.map((s) => index.get(s)))
  const until = Date.parse(asOf)
  const later = history.slice(first + 1).filter((c) => Date.parse(c.at) <= until)
  const ask = later.filter((c) => c.parents.length > 1 && !FIX_SUBJECT.test(c.subject)).map((c) => c.parents[1])
  const second = new Map(
    ask.length === 0
      ? []
      : gitIn(root)(['log', '--no-walk=unsorted', '--format=%H%x09%s', ...new Set(ask)])
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [sha, ...s] = l.split('\t')
            return [sha, s.join('\t')]
          })
  )
  const fixes = later.filter((c) => isFix(c, second))
  const out = new Map()
  for (const sha of shas) {
    const m = history[index.get(sha)]
    const touched = [...m.files.keys()].filter((p) => !excluded(p))
    const diffLines = touched.reduce((n, p) => n + m.files.get(p).lines, 0)
    const set = new Set(touched)
    const after = fixes.filter((c) => index.get(c.sha) > index.get(sha) && [...c.files.keys()].some((p) => set.has(p)))
    const exposureDays = Number(((until - Date.parse(m.at)) / DAY_MS).toFixed(1))
    out.set(sha, { diffLines, fixesAfter: after.length, fixCommits: after.map((c) => c.sha), exposureDays })
  }
  return out
}

// ---------------------------------------------------------------- metrics

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const ratio = (a, b) => (num(a) !== null && num(b) !== null && b > 0 ? a / b : null)
const tokensOf = (b) => (b ? TOKEN_FIELDS.reduce((n, f) => n + (b[f] ?? 0), 0) : null)
const OVERHEAD_PHASES = ['verify', 'review', 'archive']
// A phase split that observed none of verify, review and archive did not see the overhead.
const phased = (byPhase) => byPhase != null && OVERHEAD_PHASES.some((p) => p in byPhase)
const overhead = (byPhase, valueOf) => {
  if (!phased(byPhase)) return null
  const all = Object.values(byPhase).reduce((n, v) => n + (valueOf(v) ?? 0), 0)
  return ratio(
    OVERHEAD_PHASES.reduce((n, p) => n + (byPhase[p] === undefined ? 0 : (valueOf(byPhase[p]) ?? 0)), 0),
    all
  )
}
const activeTotal = (c) => num(c.record.timing?.activeMinutes?.total)
const sumOf = (map, field) => (map ? Object.values(map).reduce((n, e) => n + (num(e?.[field]) ?? 0), 0) : null)

// The fix rounds of each task, averaged over the tasks: the larger of its highest round and its
// number of fix dispatches. A dispatch with no round is the first attempt, round 0.
function roundsPerTask(dispatches) {
  const max = new Map()
  const fixes = new Map()
  for (const d of dispatches) {
    if (d.task == null) continue
    max.set(d.task, Math.max(max.get(d.task) ?? 0, d.round ?? 0))
    if (d.role === 'fix') fixes.set(d.task, (fixes.get(d.task) ?? 0) + 1)
  }
  const rounds = [...max.keys()].map((t) => Math.max(max.get(t), fixes.get(t) ?? 0))
  return rounds.length === 0 ? null : rounds.reduce((a, b) => a + b, 0) / rounds.length
}

// A merge carrying several changes has one set of git figures: its first change counts them.
const counted = (c) => !c.git?.sharedMerge || c.git.sharedMerge.changes[0] === c.change

// Every window metric: its key, the record groups it needs (`sources.coverage` must read
// `record` for each), how one change's value is read, the direction in which it is better, and
// whether it is normalised per task and per 1000 lines (a ratio is not). A value that cannot be
// read is null, never zero, and the aggregates skip it.
const M = (key, needs, value, direction, { norm = true } = {}) => ({ key, group: key.slice(0, key.indexOf('.')), needs, value, direction, norm })
export const METRICS = [
  M('speed.activeMinutes', ['timing'], activeTotal, 'lower'),
  M('speed.elapsedMinutes', ['timing'], (c) => num(c.record.timing?.elapsedMinutes), 'lower'),
  ...['developerMessages', 'askUserQuestion', 'clears', 'sessions', 'rulings'].map((f) => M(`autonomy.${f}`, ['autonomy'], (c) => num(c.record.autonomy?.[f]), 'lower')),
  M('cost.tokens', ['tokens'], (c) => tokensOf(c.record.tokens?.total), 'lower'),
  M('cost.coldResumes', ['cacheTtl'], (c) => num(c.record.cacheTtl?.coldResumes), 'lower'),
  M('cost.rewrittenTokens', ['cacheTtl'], (c) => num(c.record.cacheTtl?.rewrittenTokens), 'lower'),
  M(
    'efficiency.cacheHit',
    ['tokens'],
    (c) => {
      const t = c.record.tokens?.total
      return t ? ratio(t.cacheRead, t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h) : null
    },
    'higher',
    { norm: false }
  ),
  M('efficiency.orchestratorShare', ['tokens'], (c) => ratio(tokensOf(c.record.tokens?.byActor?.orchestrator) ?? 0, tokensOf(c.record.tokens?.total)), 'lower', { norm: false }),
  M('efficiency.orchestratorPerDispatch', ['tokens', 'dispatches'], (c) => ratio(tokensOf(c.record.tokens?.byActor?.orchestrator) ?? 0, c.record.dispatches?.length), 'lower', { norm: false }),
  M('efficiency.dispatches', ['dispatches'], (c) => c.record.dispatches?.length ?? null, 'lower'),
  M('efficiency.invalidReplies', ['replies'], (c) => sumOf(c.record.replies, 'invalid'), 'lower'),
  M('efficiency.stoppedDispatches', ['replies'], (c) => sumOf(c.record.replies, 'stops'), 'lower'),
  M('efficiency.roundsPerTask', ['dispatches'], (c) => roundsPerTask(c.record.dispatches ?? []), 'lower', { norm: false }),
  M('efficiency.outliers', ['outliers'], (c) => c.record.outliers?.length ?? null, 'lower'),
  M(
    'efficiency.mechanicalShare',
    ['dispatches'],
    (c) => {
      const levelled = (c.record.dispatches ?? []).filter((d) => d.level != null)
      return ratio(levelled.filter((d) => d.level === 'mechanical').length, levelled.length)
    },
    'higher',
    { norm: false }
  ),
  ...LAYERS.map((layer) => M(`quality.findings.${layer}`, ['findings'], (c) => num(c.record.findings?.[layer]?.findings), 'lower')),
  M('quality.reviewRounds', ['review'], (c) => num(c.record.review?.rounds), 'lower'),
  M('quality.testFailures', ['tests'], (c) => num(c.record.tests?.failed), 'lower'),
  M('quality.unresolvedDebt', ['ledger'], (c) => c.record.ledger?.unresolvedDebt?.length ?? null, 'lower'),
  M('quality.fixesAfter', [], (c) => (counted(c) ? num(c.git?.fixesAfter) : null), 'lower'),
  M('quality.fixesPerChangeWeek', [], (c) => (counted(c) ? ratio(c.git?.fixesAfter, c.git?.exposureDays / 7) : null), 'lower', { norm: false }),
  M('isolation.foreignBranchRecords', ['isolation'], (c) => num(c.record.isolation?.foreignBranchRecords), 'lower'),
  // A list the record could not measure is null: no data, not zero files.
  M('isolation.filesOutsidePlan', ['isolation'], (c) => (Array.isArray(c.record.isolation?.filesOutsidePlan) ? c.record.isolation.filesOutsidePlan.length : null), 'lower'),
  M('isolation.strayWorktrees', ['isolation'], (c) => (Array.isArray(c.record.isolation?.strayWorktrees) ? c.record.isolation.strayWorktrees.length : null), 'lower'),
  M(
    'context.peak',
    ['context'],
    (c) => {
      const peaks = Object.values(c.record.context?.peakBySession ?? {}).filter((v) => num(v) !== null)
      return peaks.length === 0 ? null : Math.max(...peaks)
    },
    'lower',
    { norm: false }
  ),
  M('context.compactions', ['context'], (c) => num(c.record.context?.compactions), 'lower'),
  M('overhead.timeShare', ['timing'], (c) => overhead(c.record.timing?.activeMinutes?.byPhase, num), 'lower', { norm: false }),
  M('overhead.tokenShare', ['tokens'], (c) => overhead(c.record.tokens?.byPhase, tokensOf), 'lower', { norm: false }),
  M('predictability.minutesPerTask', ['timing'], (c) => ratio(activeTotal(c), c.tasks), 'lower', { norm: false }),
  M('predictability.tokensPerTask', ['tokens'], (c) => ratio(tokensOf(c.record.tokens?.total), c.tasks), 'lower', { norm: false })
]
export const DIRECTION = Object.fromEntries(METRICS.map((m) => [m.key, m.direction]))

const has = (c, group) => c.coverage?.[group] === 'record'

function valueOf(m, c) {
  if (m.needs.length > 0 && (c.record == null || !m.needs.every((g) => has(c, g)))) return null
  return num(m.value(c))
}

const round4 = (v) => (num(v) === null ? null : Number(v.toFixed(4)))

// One change's value of every metric, keyed by metric.
export function changeValues(c) {
  return Object.fromEntries(METRICS.map((m) => [m.key, round4(valueOf(m, c))]))
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)
function quantile(sorted, q) {
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo)
}

// Per metric over the changes that measured it: mean and median per change, the means per task
// and per 1000 lines (for normalised metrics), `n`, and the spread (interquartile range and
// coefficient of variation, null under two values).
export function aggregate(changes) {
  const out = {}
  for (const m of METRICS) {
    const rows = changes.map((c) => ({ c, v: valueOf(m, c) })).filter((r) => r.v !== null)
    const xs = rows.map((r) => r.v)
    const per = (denominator) => (m.norm ? round4(mean(rows.map((r) => ratio(r.v, denominator(r.c))).filter((v) => v !== null))) : null)
    const sorted = [...xs].sort((a, b) => a - b)
    const mu = mean(xs)
    const sd = xs.length < 2 ? null : Math.sqrt(mean(xs.map((x) => (x - mu) ** 2)))
    out[m.key] = {
      direction: m.direction,
      n: xs.length,
      mean: round4(mu),
      median: round4(median(xs)),
      perTask: per((c) => c.tasks),
      perKloc: per((c) => (num(c.git?.diffLines) === null ? null : c.git.diffLines / 1000)),
      iqr: xs.length < 2 ? null : round4(quantile(sorted, 0.75) - quantile(sorted, 0.25)),
      cv: sd === null || mu === 0 ? null : round4(sd / mu)
    }
  }
  return out
}

const DELTA_STATS = ['mean', 'median', 'perTask', 'perKloc']

// The current aggregates against the previous ones (either may be a sidecar), per metric and
// statistic, better or worse by the metric's fixed direction; a predictability metric is also
// compared by its coefficient of variation, lower being better. Only what both measured is
// compared; anything else is listed in `notCompared` with the reason.
export function delta(prev, cur) {
  const before = prev?.aggregates ?? prev ?? {}
  const now = cur?.aggregates ?? cur ?? {}
  const out = { improved: [], worsened: [], unchanged: [], notCompared: [] }
  for (const key of [...new Set([...Object.keys(now), ...Object.keys(before)])].sort()) {
    const direction = DIRECTION[key]
    const [b, c] = [before[key], now[key]]
    if (!direction) {
      out.notCompared.push({ metric: key, reason: 'no direction is fixed for this metric' })
      continue
    }
    if (!(b?.n > 0) || !(c?.n > 0)) {
      out.notCompared.push({ metric: key, reason: !(b?.n > 0) ? 'the previous window did not measure it' : 'this window did not measure it' })
      continue
    }
    const stats = key.startsWith('predictability.') ? [...DELTA_STATS, 'cv'] : DELTA_STATS
    for (const stat of stats) {
      const [x, y] = [num(b[stat]), num(c[stat])]
      if (x === null && y === null) continue
      if (x === null || y === null) {
        out.notCompared.push({ metric: key, stat, reason: x === null ? 'the previous window has no value' : 'this window has no value' })
        continue
      }
      const row = { metric: key, stat, previous: x, current: y }
      const lower = stat === 'cv' || direction === 'lower'
      if (x === y) out.unchanged.push(row)
      else if (y < x === lower) out.improved.push(row)
      else out.worsened.push(row)
    }
  }
  return out
}

// The items a retrospective decides keep, remove or wait on (schema/retro-waiting.json), each
// with the aggregates of its metric keys. An unknown key is an error in the data file.
export function readWaiting(file = WAITING_PATH) {
  const { items } = JSON.parse(readFileSync(file, 'utf8'))
  for (const item of items) {
    const unknown = item.metrics.filter((k) => !DIRECTION[k])
    if (unknown.length > 0) throw new Error(`${file}: waiting item ${item.id} names unknown metrics ${unknown.join(', ')}`)
  }
  return items
}

export function waitingItems(aggregates, items = readWaiting()) {
  return items.map((item) => ({ ...item, metrics: item.metrics.map((key) => ({ key, ...aggregates[key] })) }))
}

// ---------------------------------------------------------------- sidecar

const today = () => new Date().toISOString().slice(0, 10)

// The sidecar of a retrospective: the retro agent's input and, for a window, the next window's
// anchor. Reads the ref's tree and history only and writes nothing. `asOf` bounds the fix
// commits counted after each merge: the end of `date`, or now when that is earlier.
export function buildSidecar(root, { mode = 'window', change, from, to, ref = integrationRef(root), date = today(), asOf, exclude = [], fetchedAt = null, waiting = readWaiting() } = {}) {
  if (!DAY.test(date)) throw new Error('date must be YYYY-MM-DD')
  asOf ??= new Date(Math.min(Date.parse(`${date}T23:59:59.999Z`), Date.now())).toISOString()
  const previous = previousRetro(root, { ref })
  const sel = selectWindow(root, { mode, change, from, to, ref, previous })
  const everyDir = archivedEntries(sel.history)
  const paths = [...new Set([...everyDir.map((e) => `${e.archiveDir}/${RECORD_FILE}`), ...sel.changes.map((e) => `${e.archiveDir}/tasks.md`)])]
  const blobs = readBlobs(root, ref, paths)
  const records = new Map(everyDir.map((e) => [e.archiveDir, recordOf(blobs.get(`${e.archiveDir}/${RECORD_FILE}`), `${ref}:${e.archiveDir}/${RECORD_FILE}`)]))
  const figures = sel.changes.length === 0 ? new Map() : mergeFigures(root, sel.history, sel.changes, { asOf, excluded: excluder(root, exclude) })

  const changes = sel.changes.map((e) => {
    const { record, reason } = records.get(e.archiveDir)
    const coverage = record ? { ...record.sources.coverage } : Object.fromEntries(GROUPS.map((g) => [g, none(reason)]))
    const tasksText = blobs.get(`${e.archiveDir}/tasks.md`)
    const tasks = tasksText != null ? parseTasks(tasksText).length : (record?.timing?.tasks ?? null)
    let git = { ...figures.get(e.mergeSha) }
    const carried = sel.changes.filter((o) => o.mergeSha === e.mergeSha).map((o) => o.change)
    if (carried.length > 1) {
      // One merge carrying several changes is no figure for any one change's size.
      git = { ...git, diffLines: null, sharedMerge: { changes: carried, diffLines: git.diffLines, fixesAfter: git.fixesAfter } }
      coverage.diffLines = none(`merge ${e.mergeSha.slice(0, 10)} carries ${carried.length} changes: ${carried.join(', ')}`)
    } else coverage.diffLines = 'git'
    const c = { ...e, branch: record?.branch ?? e.branch, tasks, record, coverage, git }
    return {
      change: e.change,
      archiveDir: e.archiveDir,
      mergeSha: e.mergeSha,
      mergedAt: e.mergedAt,
      direct: e.direct,
      branch: c.branch,
      tasks,
      record: record ? 'record' : none(reason),
      schemaVersion: record ? (record.sources.convertedFrom ?? record.schemaVersion) : null,
      generator: record?.generator ?? null,
      coverage,
      git,
      values: changeValues(c)
    }
  })

  // The aggregates are computed from the same inputs the values came from.
  const inputs = changes.map((c) => ({ change: c.change, record: records.get(c.archiveDir).record, coverage: c.coverage, git: c.git, tasks: c.tasks }))
  const aggregates = aggregate(inputs)
  const versions = new Map()
  for (const c of changes) {
    const key = c.generator ? `${c.generator.plugin} ${c.generator.version}` : null
    if (key) versions.set(key, [...(versions.get(key) ?? []), c.change])
  }
  const usable = everyDir.map((e) => records.get(e.archiveDir)).filter((r) => r.record)
  return {
    schemaVersion: SIDECAR_VERSION,
    date,
    mode,
    ref,
    fetchedAt,
    asOf,
    previous: previous ? { date: previous.date, path: previous.path, cutoff: previous.cutoff } : null,
    scope: sel.scope,
    cutoff: sel.cutoff,
    changes,
    coverage: { records: changes.filter((c) => c.record === 'record').length, changes: changes.length },
    flowVersions: [...versions].map(([key, names]) => ({ generator: key, changes: names })),
    aggregates,
    delta: previous?.sidecar?.aggregates ? delta(previous.sidecar, aggregates) : null,
    candidates: {
      records: usable.length,
      skipped: everyDir.map((e) => records.get(e.archiveDir)).filter((r) => !r.record && !r.absent).map((r) => r.reason),
      ...removalCandidates(usable.map((r) => r.record))
    },
    waiting: waitingItems(aggregates, waiting)
  }
}

// ---------------------------------------------------------------- archive's report

// The changes archived on the ref since the last window retro, and whether the corpus lint is
// due. `fetchedAt` is the caller's fetch time; without it, the repository's last fetch.
export function sinceLastRetro(root, { ref = integrationRef(root), fetchedAt } = {}) {
  const sel = selectWindow(root, { mode: 'window', ref })
  const count = sel.changes.length
  return {
    ref,
    fetchedAt: fetchedAt ?? lastFetchAt(root, ref),
    previous: sel.previous ? { date: sel.previous.date, path: sel.previous.path, cutoff: sel.previous.cutoff } : null,
    count,
    changes: sel.changes.map((e) => e.change),
    lintDue: count >= LINT_DUE
  }
}
