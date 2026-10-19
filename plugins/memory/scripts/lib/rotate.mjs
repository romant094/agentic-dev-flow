// Moves every `log.md` entry from a month older than the current one into
// `log-archive/YYYY-MM.md`, without losing or duplicating an entry, also when an earlier
// rotation was left half-done (entries copied but not removed).
//
// Ported from the origin's `rotate-log.mjs`, with two fixes: the archive directory is created
// when missing (the origin stopped with ENOENT), and the legacy header with a time-zone suffix,
// `## [2026-07-13 15:40 +03] ...`, starts an entry like the documented form does (under the
// origin's pattern such an entry rode inside the entry above it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The documented header `## [YYYY-MM-DD HH:MM] <type> | <title> | <author>`, or the legacy
// one with ` +ZZ` (or `-ZZ`, `+ZZ:MM`) before the bracket. Group 1 is the month.
export const HEADER = /^## \[(\d{4}-\d{2})-\d{2} \d{2}:\d{2}(?: [+-]\d{2}(?::?\d{2})?)?\] .+\|.+\|/

// The text before the first entry, and the entries, each from its header to the line before
// the next header, with the line number of its header (1-based). Nothing is reformatted.
export function splitEntries(text) {
  const lines = text.split('\n')
  const first = lines.findIndex((l) => HEADER.test(l))
  if (first === -1) return { prefix: text, entries: [] }
  const entries = []
  let current = null
  lines.slice(first).forEach((line, i) => {
    const m = HEADER.exec(line)
    if (m) {
      current = { header: line, month: m[1], line: first + i + 1, lines: [line] }
      entries.push(current)
    } else {
      current.lines.push(line)
    }
  })
  return { prefix: lines.slice(0, first).join('\n'), entries }
}

// The timestamp inside a header, `YYYY-MM-DD HH:MM`, which sorts correctly as a string. A
// legacy zone suffix is not part of it: those entries keep the order their authors gave them.
export const stamp = (header) => header.slice(4, 20)

// An entry's text with exactly one blank line after it, so entries moved from the end of one
// file into the middle of another stay separated alike.
const block = (entry) => {
  const lines = [...entry.lines]
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop()
  return `${lines.join('\n')}\n`
}

const assemble = (prefix, entries) => `${prefix.replace(/\n*$/, '\n\n')}${entries.map(block).join('\n')}`.replace(/\n*$/, '\n')

// Pure: `archives` maps a month to its archive's current text. Returns the new log text, the
// archives to write and one report line per month moved. Throws when an archive would hold an
// entry twice; nothing is to be written then.
export function rotate({ logText, archives, currentMonth }) {
  const { prefix, entries } = splitEntries(logText)
  const keep = entries.filter((e) => e.month >= currentMonth)
  const old = entries.filter((e) => e.month < currentMonth)
  const months = [...new Set(old.map((e) => e.month))].sort()
  const written = {}
  const report = []
  for (const month of months) {
    const existing = archives[month] ?? null
    const parsed = existing ? splitEntries(existing) : { prefix: `# Log Archive — ${month}`, entries: [] }
    const archived = new Set(parsed.entries.map((e) => e.header))
    const moving = old.filter((e) => e.month === month)
    const fresh = moving.filter((e) => !archived.has(e.header))
    // Newest first, as the log itself is; entries already in the archive keep their text.
    const merged = [...parsed.entries, ...fresh].sort((a, b) => stamp(b.header).localeCompare(stamp(a.header)))
    const headers = merged.map((e) => e.header)
    const duplicate = headers.find((h, i) => headers.indexOf(h) !== i)
    if (duplicate) {
      throw new Error(`log-archive/${month}.md would hold "${duplicate}" twice; repair it by hand, entry by entry`)
    }
    written[month] = assemble(parsed.prefix, merged)
    report.push(`${month}: ${fresh.length} copied, ${moving.length - fresh.length} already archived and removed from log.md`)
  }
  return { logText: months.length > 0 ? assemble(prefix, keep) : logText, archives: written, report }
}

export const currentMonthOf = (now) => now.toISOString().slice(0, 7)

// Rotates the log of the knowledge base at `dir` (absolute). The archives are written before
// the log, so a failure between the two is repaired by the next run, which skips what an
// archive already holds and removes it from the log. Returns { rotated: [month], report }.
export function rotateFiles(dir, currentMonth) {
  const logPath = join(dir, 'log.md')
  if (!existsSync(logPath)) return { rotated: [], report: [] }
  const logText = readFileSync(logPath, 'utf8')
  const archiveDir = join(dir, 'log-archive')
  const archives = {}
  for (const { month } of splitEntries(logText).entries) {
    const path = join(archiveDir, `${month}.md`)
    if (month < currentMonth && !(month in archives) && existsSync(path)) archives[month] = readFileSync(path, 'utf8')
  }
  const result = rotate({ logText, archives, currentMonth })
  const rotated = Object.keys(result.archives).sort()
  if (rotated.length === 0) return { rotated, report: [] }
  mkdirSync(archiveDir, { recursive: true })
  for (const month of rotated) writeFileSync(join(archiveDir, `${month}.md`), result.archives[month], 'utf8')
  writeFileSync(logPath, result.logText, 'utf8')
  return { rotated, report: result.report }
}
