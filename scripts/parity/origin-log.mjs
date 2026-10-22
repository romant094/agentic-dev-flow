#!/usr/bin/env node
// Dev tool: compares the log rotation of the memory plugin (plugins/adf-memory/scripts/lib/rotate.mjs)
// with the origin's `.claude/scripts/rotate-log.mjs`, then runs the plugin's log check over the
// origin's entries. Nothing is written in the origin: its files are read with `git show HEAD:`,
// and the origin's script is copied into a directory under the system temp directory and run
// from there.
//
//   node scripts/parity/origin-log.mjs <origin project root> [--all]
//
// --all also prints every comparison.
//
// The rotation: both `rotate({ logText, archives, currentMonth })` run on the same inputs, with
// currentMonth each month from 2026-05 to 2026-10, and the returned log text, archive texts,
// report lines or refusal are compared byte for byte. The inputs:
//   as-is    the origin's log.md and its log-archive/*.md
//   history  every entry of the log and of the archives in one log (the log's prefix, then the
//            log's entries, then each archive's, newest month first), with the archives
//   fresh    that log with no archive, as on a first rotation
// Then the file layer: the origin's script, run as a command (it reads the clock), on a copy of
// the history log with no log-archive directory, against the port's `rotateFiles` on another
// copy for the same month.
// Deliberate differences (anything else fails the tool):
//   zone-suffix        a legacy header with a zone suffix (`## [2026-07-13 15:40 +03] ...`) starts
//                      an entry in the port; under the origin's pattern it rides inside the entry
//                      above. A difference is this one when both sides agree once the suffixes are
//                      removed from the inputs.
//   missing-directory  with no log-archive directory the origin's script stops with ENOENT; the
//                      port creates the directory
// The check: the port's `check` (plugins/adf-memory/scripts/lib/memory.mjs) over the log, and over
// each archive put in the place of the log, keeping its log findings: `malformed-header` (a
// second-level heading outside the documented form, the header types are part of it) and
// `out-of-order` (an entry newer than the entry above it). Each finding is explained below or
// fails the tool:
//   merge-interleaving  an entry out of order: branches each prepended entries and a merge
//                       interleaved them, or copied one entry twice (the port's `sort` repairs the
//                       order; `docs/lessons/memory.md` names two in log.md). The known ones are
//                       listed below; an unlisted one in log.md is this one by rule when the commit
//                       that brought the entry above it (`git blame` at HEAD) was committed at or
//                       after the time the out-of-order entry names: its writer could not have
//                       seen the entry above, so another branch's merge or rebase put it there
//   pipe-in-title       a title holding `|`, which the header's field separator forbids
// Headers an archive holds twice are listed as `duplicates`; the port's rotation refuses to write
// such an archive, the origin's does not see a zone-suffixed one (counted, never failing).
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rotate as portRotate, rotateFiles, splitEntries } from '../../plugins/adf-memory/scripts/lib/rotate.mjs'
import { check } from '../../plugins/adf-memory/scripts/lib/memory.mjs'

// The findings the origin's entries are known to carry, by file, kind and header timestamp.
const EXPECTED_FINDINGS = [
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-20 12:39', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-18 18:01', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-15 17:38', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-12 18:28', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-12 17:56', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-09 18:52', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-09 19:32', explained: 'merge-interleaving' },
  { file: 'log.md', kind: 'out-of-order', at: '2026-10-08 22:36', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-05.md', kind: 'out-of-order', at: '2026-05-28 16:08', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-06.md', kind: 'out-of-order', at: '2026-06-30 17:56', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-06.md', kind: 'out-of-order', at: '2026-06-29 12:04 +07', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'malformed-header', at: '2026-07-10 13:23', explained: 'pipe-in-title' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-30 19:46', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-22 14:00', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-20 17:40', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-15 14:40', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-14 15:18', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-14 22:41', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-13 17:59', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-10 15:14', explained: 'merge-interleaving' },
  { file: 'log-archive/2026-07.md', kind: 'out-of-order', at: '2026-07-08 12:26', explained: 'merge-interleaving' }
]

const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, '.git'))) {
  console.error('usage: origin-log.mjs <origin project root, a git checkout>')
  process.exit(2)
}
const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const memory = '.claude/memory'
const logText = git('show', `HEAD:${memory}/log.md`)
const archives = {}
for (const name of git('ls-tree', '--name-only', `HEAD:${memory}/log-archive`).split('\n').filter((n) => /^\d{4}-\d{2}\.md$/.test(n))) {
  archives[name.slice(0, 7)] = git('show', `HEAD:${memory}/log-archive/${name}`)
}

// The real path: the origin's script runs its command only when argv[1] is its own URL's path.
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-log-')))
const result = { months: MONTHS, inputs: {}, rotations: 0, equal: 0, differences: 0, explained: {}, fileLayer: null, check: null, unexplained: [] }
const all = []
try {
  const originScript = join(temp, 'rotate-log.mjs')
  writeFileSync(originScript, git('show', 'HEAD:.claude/scripts/rotate-log.mjs'))
  const { rotate: originRotate } = await import(pathToFileURL(originScript).href)

  const prefix = splitEntries(logText).prefix
  const entryText = (text) =>
    splitEntries(text)
      .entries.map((e) => e.lines.join('\n').replace(/\n+$/, ''))
      .join('\n')
  const history = `${prefix.replace(/\n*$/, '\n\n')}${[logText, ...Object.keys(archives).sort().reverse().map((m) => archives[m])].map(entryText).join('\n')}\n`
  const inputs = { 'as-is': { logText, archives }, history: { logText: history, archives }, fresh: { logText: history, archives: {} } }
  for (const [name, input] of Object.entries(inputs)) result.inputs[name] = { entries: splitEntries(input.logText).entries.length, archives: Object.keys(input.archives).length }

  const run = (fn, input, currentMonth) => {
    try {
      const out = fn({ logText: input.logText, archives: { ...input.archives }, currentMonth })
      return JSON.stringify({ logText: out.logText, archives: Object.keys(out.archives).sort().map((m) => [m, out.archives[m]]), report: out.report })
    } catch (error) {
      return JSON.stringify({ error: error.message })
    }
  }
  const ZONE = /^(## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}) [+-]\d{2}(?::?\d{2})?\]/gm
  const unzoned = (input) => ({ logText: input.logText.replace(ZONE, '$1]'), archives: Object.fromEntries(Object.entries(input.archives).map(([m, t]) => [m, t.replace(ZONE, '$1]')])) })
  for (const [name, input] of Object.entries(inputs)) {
    for (const month of MONTHS) {
      result.rotations++
      const theirs = run(originRotate, input, month)
      const ours = run(portRotate, input, month)
      if (theirs === ours) {
        result.equal++
        all.push({ input: name, month, equal: true })
        continue
      }
      result.differences++
      const explained = run(originRotate, unzoned(input), month) === run(portRotate, unzoned(input), month) ? 'zone-suffix' : null
      all.push({ input: name, month, equal: false, explained })
      if (explained) result.explained[explained] = (result.explained[explained] ?? 0) + 1
      else result.unexplained.push({ input: name, month, theirs: theirs.slice(0, 500), ours: ours.slice(0, 500) })
    }
  }

  // The file layer: no log-archive directory; the log holds its own entries and the previous
  // month's archive, which neither side refuses.
  const now = new Date()
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const previous = Object.keys(archives).filter((m) => m < currentMonth).sort().pop()
  const layerLog = `${prefix.replace(/\n*$/, '\n\n')}${[logText, archives[previous]].map(entryText).join('\n')}\n`
  const theirDir = join(temp, 'theirs')
  const ourDir = join(temp, 'ours')
  for (const dir of [theirDir, ourDir]) {
    mkdirSync(dir)
    writeFileSync(join(dir, 'log.md'), layerLog)
  }
  const theirRun = spawnSync('node', [originScript, theirDir], { encoding: 'utf8' })
  let ourError = null
  let ourRotated = []
  try {
    ourRotated = rotateFiles(ourDir, currentMonth).rotated
  } catch (error) {
    ourError = error.message
  }
  const theirsStopped = theirRun.status !== 0 && /ENOENT/.test(theirRun.stderr)
  const oursRotated = ourError === null && ourRotated.length > 0 && existsSync(join(ourDir, 'log-archive'))
  result.fileLayer = {
    currentMonth,
    previous,
    origin: { exit: theirRun.status, stderr: theirRun.stderr.trim().split('\n')[0], logUnchanged: readFileSync(join(theirDir, 'log.md'), 'utf8') === layerLog },
    port: { error: ourError, rotated: ourRotated, archiveFiles: existsSync(join(ourDir, 'log-archive')) ? readdirSync(join(ourDir, 'log-archive')).sort() : [] },
    explained: theirsStopped && oursRotated ? 'missing-directory' : null
  }
  if (result.fileLayer.explained) result.explained['missing-directory'] = 1
  else result.unexplained.push({ fileLayer: result.fileLayer })

  // The merge-interleaving rule for an unlisted out-of-order entry of log.md: the commit that
  // brought the entry above it, and its commit time in its own zone, when that time is at or
  // after the out-of-order entry's own time; null otherwise.
  const landedLater = (above, at) => {
    const n = logText.split('\n').indexOf(above) + 1
    if (n === 0 || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at ?? '')) return null
    const sha = git('blame', '-L', `${n},${n}`, '--porcelain', 'HEAD', '--', `${memory}/log.md`).split(' ')[0]
    const landed = git('log', '-1', '--format=%cd', '--date=format:%Y-%m-%d %H:%M', sha).trim()
    return landed >= at ? `the entry above came with ${sha.slice(0, 8)}, committed ${landed}, at or after this entry's ${at}` : null
  }

  // The check over each file of the origin's log, in the place of the log.
  const findings = []
  const files = { 'log.md': logText, ...Object.fromEntries(Object.entries(archives).map(([m, t]) => [`log-archive/${m}.md`, t])) }
  for (const [file, text] of Object.entries(files)) {
    const root = join(temp, 'check', file.replace(/[/.]/g, '-'))
    mkdirSync(join(root, memory), { recursive: true })
    writeFileSync(join(root, memory, 'log.md'), text)
    writeFileSync(join(root, memory, 'index.md'), '# Index\n')
    for (const f of check(root).findings) {
      if (f.kind !== 'malformed-header' && f.kind !== 'out-of-order') continue
      const at = /^## \[([^\]]+)\]/.exec(f.header ?? f.text)?.[1] ?? null
      const expected = EXPECTED_FINDINGS.find((e) => e.file === file && e.kind === f.kind && e.at === at)
      const ruled = !expected && file === 'log.md' && f.kind === 'out-of-order' ? landedLater(f.above, at) : null
      findings.push({ file, kind: f.kind, line: f.line, header: f.header ?? f.text, ...(f.above ? { above: f.above } : {}), explained: expected?.explained ?? (ruled ? 'merge-interleaving' : null), ...(ruled ? { rule: ruled } : {}) })
    }
  }
  const byKind = {}
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  const absent = EXPECTED_FINDINGS.filter((e) => !findings.some((f) => f.file === e.file && f.kind === e.kind && f.header.startsWith(`## [${e.at}]`)))
  result.check = {
    files: Object.keys(files).length,
    entries: Object.values(files).reduce((n, t) => n + splitEntries(t).entries.length, 0),
    findings: byKind,
    duplicates: Object.entries(files).flatMap(([file, text]) => {
      const headers = splitEntries(text).entries.map((e) => e.header)
      return [...new Set(headers.filter((h, i) => headers.indexOf(h) !== i))].map((header) => ({ file, header }))
    }),
    ...(listAll ? { list: findings } : {}),
    absent
  }
  result.unexplained.push(...findings.filter((f) => f.explained === null), ...absent.map((e) => ({ absent: e })))
} finally {
  rmSync(temp, { recursive: true, force: true })
}

console.log(JSON.stringify({ ...result, ...(listAll ? { all } : {}) }, null, 2))
process.exitCode = result.unexplained.length === 0 ? 0 : 1
