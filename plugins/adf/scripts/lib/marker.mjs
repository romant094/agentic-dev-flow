// The ADF markers: one comment, in the file's own comment syntax, that records a developer's
// ruling in the code itself. One family, one parser:
//
// - `ADF IGNORE <key> -- <reason>`, on the line directly above a line: a review finding with
//   that key is not reported on that line;
// - `ADF IGNORE-START <key> -- <reason>` above a block and `ADF IGNORE-END` below it: the same
//   for the block;
// - `ADF DUP <existing> -- <reason>`: a dismissed reuse-sweep finding (lib/dup.mjs).
//
// `<key>` is one upper-case identifier, such as a CWE id (`CWE-79`); a marker with no key is
// refused, since it suppresses nothing. `<reason>` is the developer's, one line. A marker is
// recognised where the keyword stands as a word of its own: inside backticks or quotes, as in
// this comment, it is prose about markers and not a marker.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

const LINE = (open) => ({ open, close: '' })
const BLOCK = (open, close) => ({ open, close })
const SLASH = LINE('//')
const HASH = LINE('#')
const DASH = LINE('--')
const HTML = BLOCK('<!--', '-->')

// By extension, lower case; by whole basename for the files that have no extension.
export const COMMENTS = {
  ...Object.fromEntries(
    ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go', 'rs', 'swift', 'dart', 'php', 'proto', 'jsonc', 'json5', 'scss', 'less'].map((e) => [e, SLASH])
  ),
  ...Object.fromEntries(
    ['py', 'sh', 'bash', 'zsh', 'fish', 'rb', 'pl', 'pm', 'r', 'ps1', 'psm1', 'yaml', 'yml', 'toml', 'conf', 'cfg', 'mk', 'cmake', 'tf', 'tfvars', 'properties', 'env', 'dockerfile', 'nix', 'ex', 'exs', 'jl', 'coffee', 'graphql', 'gql'].map((e) => [e, HASH])
  ),
  ...Object.fromEntries(['sql', 'lua', 'hs', 'elm', 'ada'].map((e) => [e, DASH])),
  ...Object.fromEntries(['md', 'markdown', 'html', 'htm', 'xml', 'xhtml', 'svg', 'xsl', 'xsd', 'plist'].map((e) => [e, HTML])),
  css: BLOCK('/*', '*/'),
  ...Object.fromEntries(['tex', 'sty', 'erl', 'hrl', 'm'].map((e) => [e, LINE('%')])),
  ...Object.fromEntries(['clj', 'cljs', 'el', 'lisp', 'scm', 'asm', 'ini'].map((e) => [e, LINE(';')])),
  vim: LINE('"')
}
export const BY_NAME = { Makefile: HASH, Dockerfile: HASH, Gemfile: HASH, Rakefile: HASH, '.gitignore': HASH, '.dockerignore': HASH, '.editorconfig': HASH }

export function commentFor(file) {
  const name = basename(file)
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]
  const ext = extname(name).slice(1).toLowerCase()
  return ext && Object.hasOwn(COMMENTS, ext) ? COMMENTS[ext] : null
}

// A marker key: one upper-case identifier, segments joined by `-` (CWE-79, DUP).
export const KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/

const MARK = /(?<![\w`'"])ADF (IGNORE-START|IGNORE-END|IGNORE|DUP)(?![\w-])(.*)$/
const KINDS = { IGNORE: 'ignore', 'IGNORE-START': 'start', 'IGNORE-END': 'end', DUP: 'dup' }
const KEYWORD = { ignore: 'IGNORE', start: 'IGNORE-START', end: 'IGNORE-END', dup: 'DUP' }

export const ignoreText = (key, reason) => `ADF IGNORE ${key} -- ${reason}`
export const dupText = (existing, reason) => `ADF DUP ${existing} -- ${reason}`

// The marker on a line, or null: { kind: ignore | start | end | dup, key?, existing?, reason?,
// error? }. `error` names what makes the marker invalid; the other fields are what was read.
export function parseMarker(line) {
  const m = MARK.exec(line)
  if (!m) return null
  const kind = KINDS[m[1]]
  const rest = m[2].replace(/\s*(?:-->|\*\/)\s*$/, '').trim()
  if (kind === 'end') return rest ? { kind, error: 'ADF IGNORE-END takes no key and no reason' } : { kind }
  const sep = /(?:^|\s)--(?:\s|$)/.exec(rest)
  const head = (sep ? rest.slice(0, sep.index) : rest).trim()
  const reason = sep ? rest.slice(sep.index + sep[0].length).trim() : ''
  const keyword = KEYWORD[kind]
  if (kind === 'dup') {
    const marker = { kind, existing: head, reason, separated: Boolean(sep) }
    if (!head) return { ...marker, error: 'ADF DUP names no existing location' }
    if (!reason) return { ...marker, error: 'ADF DUP gives no reason after " -- "' }
    return marker
  }
  const marker = { kind, key: head, reason }
  if (!head) return { ...marker, error: `keyless: ADF ${keyword} needs a key before " -- "` }
  if (!KEY.test(head)) return { ...marker, error: `"${head}" is not a marker key (one upper-case identifier, such as CWE-79)` }
  if (!reason) return { ...marker, error: `ADF ${keyword} gives no reason after " -- "` }
  return marker
}

// The START/END pairs of one file's markers, in line order: an error for an END with no open
// START, a START inside an open block, and a START left open at the end of the file.
export function pairErrors(markers) {
  const errors = []
  let open = null
  for (const m of markers) {
    if (m.kind === 'start') {
      if (open) errors.push({ line: m.line, error: `IGNORE-START inside the block opened on line ${open.line}` })
      else open = m
    } else if (m.kind === 'end') {
      if (open) open = null
      else errors.push({ line: m.line, error: 'IGNORE-END with no IGNORE-START above it' })
    }
  }
  if (open) errors.push({ line: open.line, error: 'IGNORE-START with no IGNORE-END below it' })
  return errors
}

const toRelative = (root, file) => (isAbsolute(file) ? relative(root, file) : file).split('\\').join('/')

// Writes the marker comment `<open> <body> <close>` into `file` (relative to root). `line` is
// the 1-based line the marker goes directly above; without it the marker goes on the first line
// (after a `#!` line, which must stay first). The marker takes the indentation of the line it
// sits above, and the file's line ending. When the line where the marker would stand already
// holds one that `same(parsed)` accepts, nothing is written and `already` is true.
export function placeMarker(root, { file, line, body, same = () => false }) {
  const rel = toRelative(root, file)
  const syntax = commentFor(rel)
  if (!syntax) throw new Error(`${rel} has no comment syntax this script knows; it cannot carry a marker`)
  if (syntax.close && body.includes(syntax.close)) throw new Error(`the marker must not contain "${syntax.close}", which would close the comment`)
  const path = join(root, rel)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${rel} in ${root}`)
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let at
  if (line === undefined || line === null) at = lines[0]?.startsWith('#!') ? 1 : 0
  else {
    const n = Number(line)
    if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new Error(`--line ${line} is not a line of ${rel} (1-${lines.length})`)
    at = n - 1
  }
  const there = line === undefined || line === null ? at : at - 1
  const found = there >= 0 ? parseMarker(lines[there]) : null
  if (found && same(found)) return { file: rel, line: there + 1, marker: lines[there].trim(), already: true }
  const indent = /^\s*/.exec(lines[at] ?? '')[0]
  const marker = `${syntax.open} ${body}${syntax.close ? ` ${syntax.close}` : ''}`
  lines.splice(at, 0, `${indent}${marker}`)
  writeFileSync(path, lines.join(eol), 'utf8')
  return { file: rel, line: at + 1, marker, already: false }
}

// Writes `ADF IGNORE <key> -- <reason>` above `line`. The same key already there is left alone.
export function markIgnore(root, { file, line, key, reason }) {
  if (line === undefined || line === null) throw new Error('--line is required: an IGNORE marker stands above the line it covers')
  checkKeyReason(key, reason)
  return placeMarker(root, { file, line, body: ignoreText(key, reason.trim()), same: (m) => m.kind === 'ignore' && m.key === key })
}

function checkKeyReason(key, reason) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error(`--key "${key ?? ''}" is not a marker key (one upper-case identifier, such as CWE-79)`)
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('--reason is empty')
  if (/[\r\n]/.test(reason)) throw new Error('--reason must be one line')
}

// Writes `ADF IGNORE-START <key> -- <reason>` above `line` and `ADF IGNORE-END` below `endLine`,
// both with the indentation of `line`. The pair already there, with the same key, is left alone.
// A pair that would nest in, or cross, another block is refused before anything is written.
export function markIgnoreBlock(root, { file, line, endLine, key, reason }) {
  checkKeyReason(key, reason)
  const rel = toRelative(root, file)
  const syntax = commentFor(rel)
  if (!syntax) throw new Error(`${rel} has no comment syntax this script knows; it cannot carry a marker`)
  const body = `ADF IGNORE-START ${key} -- ${reason.trim()}`
  if (syntax.close && body.includes(syntax.close)) throw new Error(`the marker must not contain "${syntax.close}", which would close the comment`)
  const path = join(root, rel)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${rel} in ${root}`)
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // A final newline leaves an empty last element, which is no line of the file.
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length
  const first = Number(line)
  const last = Number(endLine)
  if (!Number.isInteger(first) || first < 1 || first > count) throw new Error(`--line ${line} is not a line of ${rel} (1-${count})`)
  if (!Number.isInteger(last) || last < first || last > count) throw new Error(`--end-line ${endLine} is not a line of ${rel} from --line on (${first}-${count})`)
  const above = first >= 2 ? parseMarker(lines[first - 2]) : null
  const below = last < lines.length ? parseMarker(lines[last]) : null
  if (above?.kind === 'start' && above.key === key && !above.error && below?.kind === 'end' && !below.error) {
    return { file: rel, line: first - 1, endLine: last + 1, marker: lines[first - 2].trim(), already: true }
  }
  const indent = /^\s*/.exec(lines[first - 1])[0]
  const wrap = (b) => `${indent}${syntax.open} ${b}${syntax.close ? ` ${syntax.close}` : ''}`
  const next = [...lines]
  next.splice(last, 0, wrap('ADF IGNORE-END'))
  next.splice(first - 1, 0, wrap(body))
  const markers = []
  next.forEach((l, i) => {
    const m = parseMarker(l)
    if (m) markers.push({ ...m, line: i + 1 })
  })
  const errors = pairErrors(markers)
  if (errors.length > 0) throw new Error(`the pair would break the blocks of ${rel}: line ${errors[0].line}: ${errors[0].error}`)
  writeFileSync(path, next.join(eol), 'utf8')
  return { file: rel, line: first, endLine: last + 2, marker: wrap(body).trim(), already: false }
}

// The IGNORE marker that covers line `n` (1-based) of a file's lines: a valid `ADF IGNORE` on the
// line directly above it, or a valid `ADF IGNORE-START` above it whose block is still open at it.
// With `key`, only a marker of that key covers the line. { line, kind, key } or null.
export function coveringIgnore(lines, n, key = null) {
  const fits = (m) => Boolean(m) && !m.error && (key === null || m.key === key)
  const above = n >= 2 ? parseMarker(lines[n - 2]) : null
  if (above?.kind === 'ignore' && fits(above)) return { line: n - 1, kind: 'ignore', key: above.key }
  let open = null
  for (let i = 0; i < n - 1; i++) {
    const m = parseMarker(lines[i])
    if (m?.kind === 'start') open = { ...m, line: i + 1 }
    else if (m?.kind === 'end') open = null
  }
  return fits(open) ? { line: open.line, kind: 'start', key: open.key } : null
}

// Every marker in the tracked and untracked (not ignored) files of the tree, and the invalid
// ones: { markers: [{ file, line, kind, key?, existing?, reason? }], invalid: [{ file, line,
// text?, error }] }. The change records and the SDD workspace are left out.
export function scanMarkers(root) {
  let out
  try {
    out = execFileSync('git', ['grep', '-n', '-I', '--untracked', '-E', '-e', 'ADF (IGNORE|DUP)', '--', '.', ':!openspec/changes', ':!.superpowers'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 26
    })
  } catch (error) {
    if (error.status !== 1) throw new Error(`git grep failed in ${root}: ${String(error.stderr ?? error.message).trim()}`)
    out = ''
  }
  const markers = []
  const invalid = []
  const byFile = new Map()
  for (const row of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row)
    if (!m) continue
    const parsed = parseMarker(m[3])
    if (!parsed) continue
    const { error, separated, ...fields } = parsed
    const entry = { file: m[1], line: Number(m[2]), ...fields }
    if (error) invalid.push({ file: entry.file, line: entry.line, text: m[3].trim(), error })
    else markers.push(entry)
    // A pair is checked on the kinds as written, an invalid START still opening its block.
    if (!byFile.has(entry.file)) byFile.set(entry.file, [])
    byFile.get(entry.file).push(entry)
  }
  for (const [file, list] of byFile) for (const e of pairErrors(list)) invalid.push({ file, ...e })
  invalid.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { markers, invalid }
}
