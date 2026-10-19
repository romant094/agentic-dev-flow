// The `knowledge` role of the ADF contract, on a wiki memory kept in the host at
// `.claude/memory/`: `index.md` lists every page once, `log.md` records what each session
// learned, newest first, and `log-archive/` holds the months before the current one.
//
// - `context`: where the knowledge base is and which instructions its workflows follow;
// - `log`: writes one log entry, after the rotation, at its timestamp's place;
// - `check`: the mechanical half of a lint (unindexed pages, links to missing files, malformed
//   log headers, log entries out of order), over every page but those the host's `exclude`
//   globs name;
// - `sort` (by hand, not a role operation): puts the log's entries back in timestamp order
//   after a merge broke it.
//
// Every operation returns one object with `state` `done` or `refused` (with `error`). Times
// are UTC, read from the clock; the plugin is the one surface stating that rule. The clock and
// git are injected, so no test depends on the time or on a developer's git identity.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { currentMonthOf, rotateFiles, splitEntries, stamp } from './rotate.mjs'

export const BASE = '.claude/memory'
export const TYPES = ['ingest', 'query', 'lint', 'task']
export const WORKFLOWS = ['ingest', 'query', 'lint', 'fix']
// A header the script would write, or the legacy form with a zone suffix it still reads.
export const STRICT = /^## \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: [+-]\d{2}(?::?\d{2})?)?\] (ingest|query|lint|task) \| ([^|]*\S[^|]*) \| ([^|]*\S[^|]*)$/
const SHA = /^[0-9a-f]{7,40}$/

const refused = (error) => ({ state: 'refused', error })
const posix = (path) => path.split(sep).join('/')

// ---------------------------------------------------------------- context

export function context(root, pluginDir) {
  return {
    state: 'done',
    base: BASE,
    index: `${BASE}/index.md`,
    exists: existsSync(join(root, BASE, 'index.md')),
    instructions: Object.fromEntries(WORKFLOWS.map((w) => [w, join(pluginDir, 'instructions', `${w}.md`)])),
    paths: [`${BASE}/**`],
    log: [`${BASE}/log.md`, `${BASE}/log-archive/**`]
  }
}

// ---------------------------------------------------------------- log

export const utcStamp = (now) => {
  const iso = now.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

const oneLine = (text) => typeof text === 'string' && text.trim() !== '' && !/[\r\n]/.test(text)

// The body lines of an entry, or an error. A blank line inside an entry reads as its end.
export function entryBody(input) {
  const { bullets, commit, reason } = input
  const hasBullets = bullets !== undefined
  const hasCommit = commit !== undefined || reason !== undefined
  if (hasBullets === hasCommit) return { error: 'give either bullets, or commit and reason' }
  if (hasCommit) {
    const shas = String(commit ?? '').split(/[\s,]+/).filter(Boolean)
    if (shas.length === 0 || !shas.every((s) => SHA.test(s))) return { error: 'commit must be one or more commit hashes (7-40 hex characters)' }
    if (!oneLine(reason)) return { error: 'reason must be one non-empty line' }
    return { lines: [`- see commit${shas.length > 1 ? 's' : ''} ${shas.join(', ')} — ${reason.trim()}`] }
  }
  if (!Array.isArray(bullets) || bullets.length === 0) return { error: 'bullets must be a non-empty list of strings' }
  const lines = []
  for (const bullet of bullets) {
    if (typeof bullet !== 'string' || bullet.trim() === '') return { error: 'bullets must be a non-empty list of strings' }
    const parts = bullet.replace(/\r\n?/g, '\n').replace(/^\s*-\s+/, '').trimEnd().split('\n')
    if (parts.some((p) => p.trim() === '')) return { error: 'a bullet holds a blank line; a blank line inside an entry reads as its end' }
    lines.push(`- ${parts[0]}`, ...parts.slice(1))
  }
  return { lines }
}

const titleOf = (header) => STRICT.exec(header)?.[3]?.trim() ?? null

// Inserts `entryLines` at its timestamp's place in a log newest first: above the first entry
// that is not newer. Entries already separated by a blank line get one after the new entry too.
export function insertEntry(text, entryLines) {
  const { entries } = splitEntries(text)
  const at = stamp(entryLines[0])
  const spaced = entries.length < 2 || entries[0].lines.at(-1).trim() === ''
  const lines = text.split('\n')
  const before = entries.find((e) => stamp(e.header) <= at)
  if (before) {
    lines.splice(before.line - 1, 0, ...entryLines, ...(spaced ? [''] : []))
    return lines.join('\n')
  }
  const head = text.replace(/\n*$/, '')
  const gap = entries.length === 0 || spaced ? '\n\n' : '\n'
  return `${head}${gap}${entryLines.join('\n')}\n`
}

// The headers of the log as committed at HEAD; an entry not among them is uncommitted.
function committedHeaders(git) {
  const shown = git(['show', `HEAD:${BASE}/log.md`])
  if (shown.status !== 0) return new Set()
  return new Set(splitEntries(shown.stdout).entries.map((e) => e.header))
}

function uncommittedEntry(text, title, git) {
  const committed = committedHeaders(git)
  return splitEntries(text).entries.find((e) => !committed.has(e.header) && titleOf(e.header) === title) ?? null
}

function removeEntry(text, header) {
  const entry = splitEntries(text).entries.find((e) => e.header === header)
  if (!entry) return text
  const lines = text.split('\n')
  lines.splice(entry.line - 1, entry.lines.length)
  return lines.join('\n')
}

// input: { type, title, bullets: [string] | commit + reason, amend }. ctx: { now: Date,
// git(args) -> { status, stdout }, template: the skeleton log.md text }.
export function log(root, input, { now, git, template }) {
  if (!TYPES.includes(input?.type)) return refused(`type must be one of ${TYPES.join(', ')}; nothing was written`)
  if (!oneLine(input.title) || input.title.includes('|')) return refused('title must be one non-empty line without "|"; nothing was written')
  const body = entryBody(input)
  if (body.error) return refused(`${body.error}; nothing was written`)
  const author = git(['config', 'user.name'])
  const name = author.status === 0 ? author.stdout.trim() : ''
  if (!name || name.includes('|')) return refused('git config user.name is not set (or holds "|"); set it, then log again; nothing was written')
  const title = input.title.trim()
  const dir = join(root, BASE)
  const logPath = join(dir, 'log.md')
  let amended = null
  if (input.amend) {
    amended = existsSync(logPath) ? uncommittedEntry(readFileSync(logPath, 'utf8'), title, git) : null
    if (!amended) return refused(`no uncommitted log entry titled "${title}" to amend; log it without amend; nothing was written`)
  }
  let rotation
  try {
    rotation = rotateFiles(dir, currentMonthOf(now))
  } catch (error) {
    return refused(`the rotation stopped: ${error.message}; nothing was written`)
  }
  let text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : template
  if (amended) text = removeEntry(text, amended.header)
  const entryLines = [`## [${utcStamp(now)}] ${input.type} | ${title} | ${name}`, ...body.lines]
  writeFileSync(logPath, insertEntry(text, entryLines), 'utf8')
  return { state: 'done', path: `${BASE}/log.md`, entry: `${entryLines.join('\n')}\n`, amended: Boolean(amended), rotated: rotation.rotated }
}

// ---------------------------------------------------------------- sort

// Pure: the log with its entries newest first, by the timestamp of each header; entries with
// the same timestamp keep their order, and no entry's text changes. A log already in order is
// returned as it is. `moved`: the entries whose place changed.
export function sortLog(text) {
  const { prefix, entries } = splitEntries(text)
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => stamp(b.e.header).localeCompare(stamp(a.e.header)) || a.i - b.i)
  const moved = sorted.filter((s, at) => s.i !== at).length
  if (moved === 0) return { text, moved, entries: entries.length }
  const spaced = entries.slice(0, -1).some((e) => e.lines.at(-1).trim() === '')
  const body = (e) => {
    const lines = [...e.lines]
    while (lines.length > 1 && lines.at(-1).trim() === '') lines.pop()
    return lines.join('\n')
  }
  const lead = text.startsWith(entries[0].header) ? '' : `${prefix}\n`
  return { text: `${lead}${sorted.map((s) => body(s.e)).join(spaced ? '\n\n' : '\n')}\n`, moved, entries: entries.length }
}

export function sort(root) {
  const path = join(root, BASE, 'log.md')
  if (!existsSync(path)) return refused(`no ${BASE}/log.md to sort`)
  const result = sortLog(readFileSync(path, 'utf8'))
  if (result.moved > 0) writeFileSync(path, result.text, 'utf8')
  return { state: 'done', path: `${BASE}/log.md`, moved: result.moved, entries: result.entries }
}

// ---------------------------------------------------------------- check

// A glob relative to the knowledge base as a test of a base-relative path: `**` any depth,
// `*` and `?` within one segment.
export function globTest(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (glob[i] === '*') source += '[^/]*'
    else if (glob[i] === '?') source += '[^/]'
    else source += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const re = new RegExp(`^${source}$`)
  return (path) => re.test(path)
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(path))
    else if (item.isFile()) out.push(path)
  }
  return out
}

// Fenced blocks and code spans hold examples, not links; their lines stay so numbers hold.
const withoutCode = (text) =>
  text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ''))
    .replace(/`[^`\n]*`/g, '')

const LINK = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

// Every relative link of a page: { line, target, resolved (absolute path) }. A URL, an anchor
// alone and a root-absolute path are skipped.
export function links(text, pageDir) {
  const out = []
  withoutCode(text)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(LINK)) {
        const target = m[1].replace(/^<|>$/g, '')
        const path = target.split('#')[0]
        if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) continue
        let decoded = path
        try {
          decoded = decodeURI(path)
        } catch {
          // keep it as written
        }
        out.push({ line: i + 1, target, resolved: resolve(pageDir, decoded) })
      }
    })
  return out
}

// exclude: globs relative to the knowledge base (`reports/**`); a page they match is not
// checked for links or for its index line, and is not counted.
export function check(root, { exclude = [] } = {}) {
  if (!Array.isArray(exclude) || !exclude.every((g) => typeof g === 'string' && g !== '')) return refused('exclude must be a list of non-empty globs')
  const excluded = exclude.map(globTest)
  const dir = join(root, BASE)
  const rel = (path) => posix(relative(root, path))
  const findings = []
  for (const file of ['index.md', 'log.md']) {
    if (!existsSync(join(dir, file))) findings.push({ kind: 'missing', path: `${BASE}/${file}` })
  }
  const files = walk(dir)
  const archived = join(dir, 'log-archive') + sep
  const isExcluded = (f) => excluded.some((test) => test(posix(relative(dir, f))))
  const candidates = files.filter((f) => f.endsWith('.md') && !f.startsWith(archived) && f !== join(dir, 'log.md'))
  const pages = candidates.filter((f) => !isExcluded(f))
  for (const page of pages) {
    for (const link of links(readFileSync(page, 'utf8'), dirname(page))) {
      if (!existsSync(link.resolved)) findings.push({ kind: 'broken-link', path: rel(page), line: link.line, target: link.target })
    }
  }
  const indexPath = join(dir, 'index.md')
  if (existsSync(indexPath)) {
    const listed = new Set(links(readFileSync(indexPath, 'utf8'), dir).map((l) => normalize(l.resolved)))
    for (const page of pages) {
      if (page !== indexPath && !listed.has(normalize(page))) findings.push({ kind: 'unindexed', path: rel(page) })
    }
  }
  const logPath = join(dir, 'log.md')
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, 'utf8')
    const { entries } = splitEntries(text)
    // Every second-level heading of the log is an entry header.
    text.split('\n').forEach((line, i) => {
      if (/^## /.test(line) && !STRICT.test(line)) {
        findings.push({ kind: 'malformed-header', path: `${BASE}/log.md`, line: i + 1, text: line })
      }
    })
    entries.forEach((entry, i) => {
      const above = entries[i - 1]
      if (above && stamp(entry.header) > stamp(above.header)) {
        findings.push({ kind: 'out-of-order', path: `${BASE}/log.md`, line: entry.line, header: entry.header, above: above.header })
      }
    })
  }
  return { state: 'done', pages: pages.length, excluded: candidates.length - pages.length, findings }
}
