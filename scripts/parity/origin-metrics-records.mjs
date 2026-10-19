#!/usr/bin/env node
// Dev tool: the origin's archived metrics records (`openspec/changes/archive/*/metrics.json`,
// schemaVersion 1) through the port's converter, and each record's figures recomputed from the
// data committed beside it. Nothing is written in the origin: every file is read with
// `git show HEAD:`, and the origin's `--candidates` runs from a copy of its scripts under the
// system temp directory (lib/origin-metrics.mjs), removed at the end.
//
//   node scripts/parity/origin-metrics-records.mjs <origin project root> [--all]
//
// --all also prints every record's comparison.
//
// Per record:
//   convert         `fromV1` (plugins/adf/scripts/lib/metrics.mjs), then `validateRecord`: every
//                   record must convert and validate; the converted findings and ledger must be
//                   the origin's, renamed (`opsx-review` -> `ai-review`)
//   ai-review       the record's `findings.opsx-review.findings` against the sum of the four
//                   severities `checkRecord` (lib/review-state.mjs) reads from the archived
//                   review.md
//   ledger          the record's `ledger.records` (summarised by `summarizeLedger`) and its
//                   `unresolvedDebt` ids against the port's readers (lib/ledger.mjs `readLedger`,
//                   `unresolvedDebt`) over the archived ledger.jsonl
//   tasks           the record's `timing.tasks` against `parseTasks` (lib/changes.mjs) over the
//                   archived tasks.md
//   maintainability the origin's `insertionsVsDeletions` reproduced from git: the origin summed
//                   `git log --numstat <base>..HEAD` in the change's checkout at extraction; the
//                   HEAD it read is searched on the merged branch's first-parent chain (`merge^2`
//                   back to the base). The port's figure is `maintainabilityOf` over
//                   `merge^1..merge^2`, printed beside it.
// Over all records: the origin's `--candidates` against the port's `candidates()`.
//
// Deliberate differences, counted per class (anything else fails the tool):
//   ledger-v0          the record keeps the origin's first ledger shape `{ dispatches, deviations }`
//                      from the Markdown progress log, with no records to compare; fromV1 leaves
//                      the group null with a "v1:" reason
//   no-findings-group  the record has no `findings` group: it was written before the origin
//                      counted findings per layer (2026-09-30)
//   no-timing          the record has no `timing` group: written before the origin measured it
//   backfill           the record was backfilled on 2026-09-30 (commit 4b4ec224), measured against
//                      the HEAD of the checkout that ran the backfill, not the change's branch: no
//                      head on the change's branch reproduces it
//   squashed           the merge brings one squash commit (`git rev-list --no-merges merge^1..merge^2`
//                      counts 1): the branch commits whose numstat the origin summed are not in
//                      the history, so no head reproduces the figure
//   net-diff           always: the port's maintainability is the net `git diff --numstat
//                      --no-renames` of the merge's range; the origin summed every commit's
//                      numstat (`git log`, renames detected) up to the HEAD at extraction
import { readLedger, unresolvedDebt } from '../../plugins/adf/scripts/lib/ledger.mjs'
import { parseTasks } from '../../plugins/adf/scripts/lib/changes.mjs'
import { candidates, fromV1, maintainabilityOf, validateRecord } from '../../plugins/adf/scripts/lib/metrics.mjs'
import { summarizeLedger } from '../../plugins/adf/scripts/lib/metrics-records.mjs'
import { checkRecord } from '../../plugins/adf/scripts/lib/review-state.mjs'
import { archivedEntries, readHistory } from '../../plugins/adf/scripts/lib/window.mjs'
import { ARCHIVE, archivedRecordTexts, copyOriginScripts, count, gitOn, originArg } from './lib/origin-metrics.mjs'
import { spawnSync } from 'node:child_process'

const origin = originArg('origin-metrics-records.mjs')
const listAll = process.argv.includes('--all')
const git = gitOn(origin)
const BACKFILL = '2026-09-30'
const MAX_HEADS = 400

const out = { records: 0, converted: 0, valid: 0, compared: {}, classes: {}, candidates: null, changes: [], unexplained: [] }
const fail = (dir, what, detail) => out.unexplained.push({ change: dir, what, ...detail })
const compared = (what) => count(out.compared, what)
const classed = (row, c) => {
  count(out.classes, c)
  row.classes.push(c)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The merge (or direct commit) of HEAD's first-parent history that added each archive directory.
const entries = new Map(archivedEntries(readHistory(origin, 'HEAD')).map((e) => [e.archiveDir.split('/').at(-1), e]))

// The origin's sum of `git log --numstat --pretty=format: <range>` (lines with two numbers).
function logNumstat(range) {
  let insertions = 0
  let deletions = 0
  for (const line of git('log', '--numstat', '--pretty=format:', range).split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line)
    if (!m) continue
    insertions += Number(m[1])
    deletions += Number(m[2])
  }
  return { insertions, deletions }
}

// The head on the merged branch whose `<base>..<head>` log sum is the origin's figure, or null.
function reproduce(base, merge, want) {
  const tip = git.orNull('rev-parse', '--verify', '--quiet', `${merge}^2`)?.trim()
  if (!tip) return null
  const heads = git('rev-list', '--first-parent', `--max-count=${MAX_HEADS}`, `${base}..${tip}`).split('\n').filter(Boolean)
  for (const head of heads) if (same(logNumstat(`${base}..${head}`), want)) return head
  return null
}

const portGit = (...args) => git.orNull(...args)?.replace(/\n$/, '') ?? null

for (const { dir, text } of archivedRecordTexts(git)) {
  out.records++
  const row = { change: dir, classes: [], compared: [] }
  out.changes.push(row)
  const old = JSON.parse(text)
  let record
  try {
    record = fromV1(old)
    out.converted++
  } catch (error) {
    fail(dir, 'convert', { error: error.message })
    continue
  }
  const errors = validateRecord(record)
  if (errors.length === 0) out.valid++
  else fail(dir, 'validate', { errors })
  const show = (name) => git.orNull('show', `HEAD:${ARCHIVE}/${dir}/${name}`)

  // ai-review: the record's count, its conversion, and the port's reading of review.md.
  if (!old.findings) classed(row, 'no-findings-group')
  else {
    for (const [layer, entry] of Object.entries(old.findings)) {
      const v2 = record.findings?.[layer === 'opsx-review' ? 'ai-review' : layer]
      if (!v2 || v2.dispatches !== entry.dispatches || v2.findings !== entry.findings) fail(dir, 'convert-findings', { layer, origin: entry, port: v2 ?? null })
    }
    const theirs = old.findings['opsx-review']?.findings ?? null
    const review = show('review.md')
    const counts = review === null ? null : checkRecord(review).counts
    const ours = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null
    compared('ai-review')
    row.compared.push('ai-review')
    if (theirs !== ours) fail(dir, 'ai-review', { origin: theirs, port: ours })
  }

  // ledger: the records the origin kept, against the archived ledger read by the port.
  if (!Array.isArray(old.ledger?.records)) {
    classed(row, 'ledger-v0')
    if (record.ledger !== null) fail(dir, 'convert-ledger', { port: 'a ledger group from a record that keeps no records' })
  } else {
    const archived = show('ledger.jsonl')
    compared('ledger')
    row.compared.push('ledger')
    if (archived === null) fail(dir, 'ledger', { port: 'no archived ledger.jsonl' })
    else {
      const records = readLedger(archived)
      const ours = summarizeLedger(records)
      if (!same(record.ledger, ours)) fail(dir, 'ledger', { origin: record.ledger.counts, port: ours.counts })
      const debt = unresolvedDebt(records).map((r) => r.id)
      if (!same(old.ledger.unresolvedDebt, debt)) fail(dir, 'ledger-unresolved', { origin: old.ledger.unresolvedDebt, port: debt })
    }
  }

  // tasks: the record's count against the archived tasks.md.
  if (!old.timing) classed(row, 'no-timing')
  else {
    const tasks = show('tasks.md')
    const ours = tasks === null ? null : parseTasks(tasks).length
    compared('tasks')
    row.compared.push('tasks')
    if (old.timing.tasks !== ours) fail(dir, 'tasks', { origin: old.timing.tasks, port: ours })
  }

  // maintainability: reproduce the origin's figure, then the port's on the merge's range.
  const iv = old.maintainability?.insertionsVsDeletions
  const base = /^([0-9a-f]{7,40})\.\./.exec(old.maintainability?.insertionsVsDeletionsScope ?? '')?.[1]
  const entry = entries.get(dir)
  if (!entry) fail(dir, 'merge', { port: `no first-parent commit of HEAD adds ${ARCHIVE}/${dir}` })
  else if (!iv || !base) fail(dir, 'maintainability', { origin: 'no insertionsVsDeletions with a <base>..HEAD scope' })
  else {
    const head = reproduce(base, entry.mergeSha, { insertions: iv.insertions, deletions: iv.deletions })
    const backfilled = String(old.generatedAt).startsWith(BACKFILL)
    row.maintainability = { origin: iv, head: head?.slice(0, 10) ?? null }
    const squashed = !entry.direct && git('rev-list', '--count', '--no-merges', `${entry.mergeSha}^1..${entry.mergeSha}^2`).trim() === '1'
    if (head === null) {
      if (backfilled) classed(row, 'backfill')
      else if (squashed) classed(row, 'squashed')
      else fail(dir, 'maintainability', { origin: iv, port: `no head of ${entry.mergeSha.slice(0, 10)}^2 back to ${base.slice(0, 10)} reproduces it` })
    } else {
      compared('maintainability')
      row.compared.push('maintainability')
    }
    if (entry.direct) fail(dir, 'maintainability', { port: 'a direct commit: no merge range' })
    else {
      const port = maintainabilityOf(portGit, { base: `${entry.mergeSha}^1`, head: `${entry.mergeSha}^2` })
      row.maintainability.port = port && { insertions: port.insertions, deletions: port.deletions }
      classed(row, 'net-diff')
    }
  }
}

// Removal candidates: the origin's --candidates over its archive, the port's over the same records.
const scripts = copyOriginScripts(origin)
try {
  const run = spawnSync('node', [scripts.path('adf-metrics.mjs'), '--candidates', '--repo', origin], { encoding: 'utf8', cwd: scripts.dir })
  if (run.status !== 0) fail('*', 'candidates', { origin: run.stderr.trim().split('\n')[0] })
  else {
    const text = run.stdout.trim()
    const theirs = text === 'No removal candidates.' ? [] : text.split('\n').map((l) => /^(\S+): 0 findings/.exec(l)?.[1] ?? `?${l}`)
    const port = candidates(origin)
    const ours = port.layers.map((l) => (l === 'ai-review' ? 'opsx-review' : l))
    out.candidates = { origin: theirs, port: ours, portChecks: port.checks, records: port.records, skipped: port.skipped.length }
    if (!same([...theirs].sort(), [...ours].sort())) fail('*', 'candidates', { origin: theirs, port: ours })
    if (port.checks.length > 0) fail('*', 'candidates', { port: `verify checks ${port.checks.join(', ')} from records that keep no verify group` })
    if (port.records !== out.records || port.skipped.length > 0) fail('*', 'candidates', { port: `${port.records} records read, ${port.skipped.length} skipped` })
  }
} finally {
  scripts.remove()
}

if (!listAll) out.changes = out.changes.filter((c) => out.unexplained.some((u) => u.change === c.change))
console.log(JSON.stringify(out, null, 2))
process.exitCode = out.unexplained.length === 0 && out.records > 0 ? 0 : 1
