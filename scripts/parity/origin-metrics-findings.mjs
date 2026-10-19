#!/usr/bin/env node
// Dev tool: the findings per review layer the origin's archived metrics records hold, against the
// same counts recomputed from the reply corpus of this machine's session transcripts (the
// iteration 10a open item). The corpus is read as origin-reply-corpus.mjs reads it: every
// `*.jsonl` under `~/.claude/projects/*xnms*/` (or $ADF_TRANSCRIPTS), recursively, read only;
// a reply is the body of a `Write` tool call or a Bash heredoc that parses as a v1 reply
// (lib/reply-v1.mjs `replyBodies`, `asV1Reply`), and here also of a one-line `echo '<json>' >
// <file>`. Each body is placed by the file it wrote, `.superpowers/sdd/<change>/replies/<name>.json`
// (shell variables and `cd` of its command resolved; a body no path places is counted as
// `unplaced`): the change's replies directory is rebuilt from the transcripts, each file holding
// its last write, and counted by the origin's own
// `countFindings` (imported from a copy of its scripts under the system temp directory,
// lib/origin-metrics.mjs, removed at the end), as the origin's extractor counted the directory.
// A change none of whose reply files the transcripts wrote is skipped with the reason. With no
// transcript at all it prints { skipped } and exits 0.
//
//   node scripts/parity/origin-metrics-findings.mjs <origin project root> [--all]
//
// --all also prints every change's comparison.
//
// Compared: per archived record with a `findings` group whose replies the transcripts wrote, each
// apply layer (`review`, `re-review`, `final-review`, `merge-review`, `sweep`; `opsx-review` is
// read from review.md, compared by origin-metrics-records.mjs) as { dispatches, findings }.
// Deliberate differences, counted per class (anything else fails the tool):
//   pruned        a session the record measured has no transcript left, so the corpus lacks the
//                 replies its agents wrote
//   unread-write  the layer is short by no more dispatches than the reply files of that layer
//                 the transcripts name (by full path, or by a relative or variable path on the
//                 change's branch) but no body the tool reads wrote (measured: a reply written by
//                 a script the agent generated, or by a command whose path variable was set in an
//                 earlier call; the origin counted only the valid ones), and the corpus holds no
//                 more findings than the record
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { asV1Reply, replyBodies } from './lib/reply-v1.mjs'
import { archivedRecordTexts, copyOriginScripts, count, gitOn, originArg } from './lib/origin-metrics.mjs'

const origin = originArg('origin-metrics-findings.mjs')
const listAll = process.argv.includes('--all')
const git = gitOn(origin)
const base = process.env.ADF_TRANSCRIPTS ?? join(homedir(), '.claude', 'projects')
const LAYERS = ['review', 're-review', 'final-review', 'merge-review', 'sweep']
const REPLY_FILE = /\.superpowers\/sdd\/([^/]+)\/replies\/([^/]+\.json)$/

const transcripts = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.jsonl')) transcripts.push(path)
  }
}
if (existsSync(base)) for (const d of readdirSync(base)) if (d.includes('xnms')) walk(join(base, d))
if (transcripts.length === 0) {
  console.log(JSON.stringify({ skipped: `no session transcript of the origin under ${base}` }))
  process.exit(0)
}
const out = { transcripts: transcripts.length, unplaced: 0, records: 0, compared: 0, layers: 0, equal: 0, skipped: {}, classes: {}, rows: [], unexplained: [] }
// Every session id a transcript survives for.
const surviving = new Set(transcripts.filter((f) => !f.includes('/subagents/')).map((f) => basename(f, '.jsonl')))

// The file a reply body was written to, absolute: the shell variables the command assigns before
// it (`NAME=value`, `export NAME=value`) expanded (`${NAME%suffix}` too), and a relative path taken from the last `cd`
// before the heredoc, else from the record's `cwd`. Null when a variable stays unknown.
function resolvePath(body, cwd) {
  if (!body.path) return null
  const vars = {}
  const expand = (text) =>
    text
      .replace(/\$\{([A-Za-z_]\w*)%([^}*?]*)\}/g, (all, name, suffix) => (vars[name] === undefined ? all : vars[name].endsWith(suffix) ? vars[name].slice(0, vars[name].length - suffix.length) : vars[name]))
      .replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name) => vars[name] ?? all)
  const command = body.command ?? ''
  let dir = cwd ?? null
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))|cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+)))/g)) {
    if (m[1]) vars[m[1]] = expand(m[2] ?? m[3] ?? m[4] ?? '')
    else {
      const to = expand(m[5] ?? m[6] ?? m[7])
      dir = to.startsWith('/') ? to : dir && `${dir}/${to}`
    }
    if (body.source === 'heredoc' && m.index > command.indexOf('<<')) break
  }
  const path = expand(body.path)
  if (path.includes('$')) return null
  return path.startsWith('/') ? path : dir && `${dir}/${path}`
}

// The one-line writes `echo '<json>' > <file>` of Bash commands, which the 10a corpus does not
// read: measured, the reviewers of some changes wrote an empty review that way.
const ECHO = /echo\s+'(\{[^']*\})'\s*>\s*['"]?([^\s'"<>;|&]+)/g
function echoBodies(entry) {
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type !== 'tool_use' || part.name !== 'Bash') continue
    const command = String(part.input?.command ?? '')
    for (const m of command.matchAll(ECHO)) out.push({ text: m[1], source: 'echo', path: m[2], command: command.slice(0, m.index) })
  }
  return out
}

// Every reply file a transcript names by its full path, per change, whatever wrote it; and the layer a file name
// is a reply of (`T3-review.json`, `T9-re-review-r1.json`, `re-review-2.json`, `merge-review-A.json`).
const NAMED = /\.superpowers\/sdd\/([a-z0-9-]+)\/replies\/([A-Za-z0-9-]+\.json)/g
const named = new Map()
// A reply file a record on a change's branch names by a relative or variable path
// (`replies/T5-review.json`, `$D/T5-review.json`), per branch.
const NAMED_ON_BRANCH = /(?:replies|\$\{?[A-Za-z_]\w*\}?)\/((?:T\d+-)?[a-z]+(?:-[a-z]+)*(?:-(?:r\d+|\d+|[A-Z]))?\.json)/g
const namedOnBranch = new Map()
const layerOf = (name) => name.replace(/\.json$/, '').replace(/^T\d+-/, '').replace(/-(?:r\d+|\d+|[A-Z])$/, '')

// The replies directory of each change, rebuilt: change -> name -> { at, value } (the last write).
const dirs = new Map()
for (const file of transcripts) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('replies')) continue
    for (const m of line.matchAll(NAMED)) (named.get(m[1]) ?? named.set(m[1], new Set()).get(m[1])).add(m[2])
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.gitBranch === 'string') {
      const branch = entry.gitBranch.replace(/--group-[A-Z]$/, '')
      for (const m of line.matchAll(NAMED_ON_BRANCH)) (namedOnBranch.get(branch) ?? namedOnBranch.set(branch, new Set()).get(branch)).add(m[1])
    }
    for (const body of [...replyBodies(entry), ...echoBodies(entry)]) {
      const value = asV1Reply(body.text)
      if (!value) continue
      const m = REPLY_FILE.exec(resolvePath(body, entry.cwd) ?? '')
      if (!m) {
        out.unplaced++
        continue
      }
      const files = dirs.get(m[1]) ?? new Map()
      dirs.set(m[1], files)
      const at = String(entry.timestamp ?? '')
      if (!files.has(m[2]) || files.get(m[2]).at <= at) files.set(m[2], { at, value })
    }
  }
}

const scripts = copyOriginScripts(origin)
try {
  const { countFindings } = await scripts.load('adf-metrics-findings.mjs')
  for (const { dir, text } of archivedRecordTexts(git)) {
    const record = JSON.parse(text)
    if (!record.findings) continue
    out.records++
    const change = dir.replace(/^\d{4}-\d{2}-\d{2}-/, '')
    const files = dirs.get(change)
    if (!files) {
      count(out.skipped, 'no reply file written in a surviving transcript')
      continue
    }
    out.compared++
    const replies = [...files.keys()].sort().map((name) => ({ role: files.get(name).value.role, value: files.get(name).value }))
    const ours = countFindings(replies, null)
    const pruned = (record.sessions ?? []).filter((s) => s.resolved && !surviving.has(s.id)).map((s) => s.id)
    const row = { change: dir, files: files.size, pruned, layers: {}, ...(listAll ? { names: [...files.keys()].sort() } : {}) }
    out.rows.push(row)
    for (const layer of LAYERS) {
      const theirs = record.findings[layer] ?? null
      const recomputed = ours[layer] ?? null
      row.layers[layer] = { record: theirs, corpus: recomputed }
      out.layers++
      if (JSON.stringify(theirs) === JSON.stringify(recomputed)) {
        out.equal++
        continue
      }
      if (pruned.length > 0) {
        count(out.classes, 'pruned')
        continue
      }
      // The layer's files the transcripts name but no body the tool reads wrote.
      const unread = [...new Set([...(named.get(change) ?? []), ...(namedOnBranch.get(record.branch) ?? [])])].filter((n) => layerOf(n) === layer && !files.has(n))
      const short = (theirs?.dispatches ?? 0) - (recomputed?.dispatches ?? 0)
      if (short > 0 && short <= unread.length && (theirs?.findings ?? 0) >= (recomputed?.findings ?? 0)) {
        count(out.classes, 'unread-write')
        row.unread = [...(row.unread ?? []), ...unread]
        continue
      }
      out.unexplained.push({ change: dir, layer, record: theirs, corpus: recomputed })
    }
  }
} finally {
  scripts.remove()
}

if (!listAll) out.rows = out.rows.filter((r) => out.unexplained.some((u) => u.change === r.change) || r.pruned.length > 0)
console.log(JSON.stringify(out, null, 2))
process.exitCode = out.unexplained.length === 0 ? 0 : 1
