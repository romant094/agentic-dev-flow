// The `DUP` marker: the developer's dismissal of a reuse-sweep finding, written on the
// introduced location so a later sweep does not report the pair again. The grammar is the apply
// instruction's: one comment, in the file's own comment syntax, on the line directly above the
// introduced location, or on the file's first line when the whole file is the duplicate:
//
//   ADF DUP <existing> -- <reason>
//
// `<existing>` is the finding's `existing` value verbatim, `<reason>` the developer's, one line.
// A file whose format has no comment syntax (JSON, for one) cannot carry a marker: markFile
// refuses it, and the debt record alone carries the acceptance.
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

// The message of the commit `dup.mjs mark --commit` makes.
export const markMessage = (file) => `chore: mark the accepted duplicate in ${file}`

export const markerText = (existing, reason) => `ADF DUP ${existing} -- ${reason}`

// The marker on a line, in any comment syntax: { existing, reason } or null.
export function parseMarker(line) {
  const m = /ADF DUP (.+?) -- (.*?)\s*(?:-->|\*\/)?\s*$/.exec(line)
  return m ? { existing: m[1].trim(), reason: m[2].trim() } : null
}

const toRelative = (root, file) => (isAbsolute(file) ? relative(root, file) : file).split('\\').join('/')

// Writes the marker. `line` is the introduced location's 1-based line; without it the whole file
// is the duplicate and the marker goes on the first line (after a `#!` line, which must stay
// first). The marker takes the indentation of the line it sits above, and the file's line ending.
// A marker naming the same `existing` already there is left alone (`already` true).
export function markFile(root, { file, line, existing, reason }) {
  const rel = toRelative(root, file)
  const syntax = commentFor(rel)
  if (!syntax) throw new Error(`${rel} has no comment syntax this script knows; it cannot carry a DUP marker. Consolidate instead, or let the debt record alone carry the acceptance`)
  for (const [name, value] of [['existing', existing], ['reason', reason]]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is empty`)
    if (/[\r\n]/.test(value)) throw new Error(`--${name} must be one line`)
  }
  if (existing.includes(' -- ')) throw new Error('--existing must not contain " -- ", which ends it in the marker grammar')
  if (syntax.close && reason.includes(syntax.close)) throw new Error(`--reason must not contain "${syntax.close}", which would close the comment`)
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
  // A marker already there: above the introduced line, or for the whole file on the marker line.
  const there = line === undefined || line === null ? at : at - 1
  const found = there >= 0 ? parseMarker(lines[there]) : null
  if (found && found.existing === existing.trim()) return { file: rel, line: there + 1, marker: lines[there].trim(), already: true }
  const indent = /^\s*/.exec(lines[at] ?? '')[0]
  const marker = `${syntax.open} ${markerText(existing.trim(), reason.trim())}${syntax.close ? ` ${syntax.close}` : ''}`
  lines.splice(at, 0, `${indent}${marker}`)
  writeFileSync(path, lines.join(eol), 'utf8')
  return { file: rel, line: at + 1, marker, already: false }
}

// Every marker in the tracked and untracked (not ignored) files of the tree: { file, line,
// existing, reason }. The change records and the SDD workspace are left out.
export function findMarkers(root) {
  let out
  try {
    out = execFileSync('git', ['grep', '-n', '-I', '--untracked', '-F', '-e', 'ADF DUP ', '--', '.', ':!openspec/changes', ':!.superpowers'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 26
    })
  } catch (error) {
    if (error.status === 1) return []
    throw new Error(`git grep failed in ${root}: ${String(error.stderr ?? error.message).trim()}`)
  }
  const markers = []
  for (const row of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row)
    if (!m) continue
    const parsed = parseMarker(m[3])
    if (parsed) markers.push({ file: m[1], line: Number(m[2]), ...parsed })
  }
  // A whole-file marker is on line 1, or on line 2 below a `#!` line.
  for (const marker of markers) {
    marker.wholeFile = marker.line === 1
    if (marker.line === 2) {
      try {
        marker.wholeFile = readFileSync(join(root, marker.file), 'utf8').startsWith('#!')
      } catch {
        // unreadable: a line marker
      }
    }
  }
  return markers
}

// A finding's `introduced` as { file, line }: `path:12`, `path:12-30`, or a bare path (line
// null). A symbol with no path gives null: no marker can be matched to it.
export function locate(introduced) {
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(String(introduced ?? '').trim())
  if (m) return { file: m[1], line: Number(m[2]) }
  const bare = String(introduced ?? '').trim()
  return /[/.]/.test(bare) && !/\s/.test(bare) ? { file: bare, line: null } : null
}

// Whether a marker already accepts the finding: on its introduced file, naming its `existing`
// verbatim, on the line directly above the introduced line or marking the whole file.
export function coveringMarker(markers, finding) {
  const at = locate(finding.introduced)
  if (!at) return null
  const file = at.file.replace(/^\.\//, '')
  return (
    markers.find(
      (m) =>
        m.file === file &&
        m.existing === String(finding.existing ?? '').trim() &&
        (at.line === null || m.wholeFile || m.line === at.line - 1)
    ) ?? null
  )
}
