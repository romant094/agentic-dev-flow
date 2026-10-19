#!/usr/bin/env node
// Dev tool: the origin's real apply replies against the port's reply checker. The replies come
// from this machine's Claude Code session transcripts of the origin project, read only:
// every `*.jsonl` under `~/.claude/projects/*xnms*/` (or under $ADF_TRANSCRIPTS), recursively.
// A reply is the body of a `Write` tool call or of a Bash heredoc that parses as a JSON object
// whose `role` is a v1 role; replies are deduplicated by their canonical JSON. Each one is checked
// by the origin's validateReply (from a temporary copy of .claude/scripts/check-reply.mjs) and,
// through the v1 -> v2 converter, by the port's checkReply in a git fixture (lib/reply-v1.mjs).
// For a sweep reply the fixture's change removes exactly the requirements the reply disposes of,
// since the original change's delta is not in the transcript. A heredoc with an unquoted delimiter
// was expanded by the shell, so the transcript holds `$SHA` or `$(git rev-parse …)` where the file
// held a sha: such a commit sha is replaced by a hex sha derived from the expression before both
// checks (counted as `expandedShas`).
//
//   node scripts/parity/origin-reply-corpus.mjs <origin project root>
//
// Prints counts by role and by class, never a reply's content: an unexplained difference is shown
// by its role, a short hash of its JSON and the paths of the refusing side's reasons. With no
// transcript it prints { skipped } and exits 0. Exit 1 on a difference outside lib/reply-v1.mjs
// CLASSES.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asV1Reply, classify, computedDiffers, makeFixture, portCheck, replyBodies } from './lib/reply-v1.mjs'

const origin = process.argv[2]
const originSource = origin && join(origin, '.claude', 'scripts', 'check-reply.mjs')
if (!originSource || !existsSync(originSource)) {
  console.error('usage: origin-reply-corpus.mjs <origin project root with .claude/scripts/check-reply.mjs>')
  process.exit(2)
}

const base = process.env.ADF_TRANSCRIPTS ?? join(homedir(), '.claude', 'projects')
const transcripts = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.jsonl')) transcripts.push(path)
  }
}
if (existsSync(base)) for (const d of readdirSync(base)) if (d.includes('xnms') && existsSync(join(base, d))) walk(join(base, d))
if (transcripts.length === 0) {
  console.log(JSON.stringify({ skipped: `no session transcript of the origin under ${base}` }))
  process.exit(0)
}

// ---------------------------------------------------------------- the corpus

const replies = new Map()
const sources = {}
function take(text, source, expanded = false) {
  const value = asV1Reply(text)
  if (value === null) return
  const key = JSON.stringify(value)
  if (replies.has(key)) return
  replies.set(key, expanded ? expandShas(value) : value)
  sources[source] = (sources[source] ?? 0) + 1
}
// The shell's expansion of a commit sha written as `$NAME`, `${NAME}` or `$(command)`.
let expandedShas = 0
function expandShas(value) {
  if (!Array.isArray(value.commits)) return value
  const commits = value.commits.map((c) => {
    if (!(c && typeof c === 'object' && typeof c.sha === 'string' && /^\$/.test(c.sha))) return c
    expandedShas++
    return { ...c, sha: createHash('sha1').update(c.sha).digest('hex').slice(0, 12) }
  })
  return { ...value, commits }
}
for (const file of transcripts) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('role')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    for (const body of replyBodies(entry)) take(body.text, body.source, body.expanded)
  }
}

// ---------------------------------------------------------------- the check

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-reply-corpus-')))
copyFileSync(originSource, join(dir, 'check-reply.mjs'))
const { validateReply } = await import(pathToFileURL(join(dir, 'check-reply.mjs')).href)
const fixture = makeFixture()

const byRole = {}
const explained = {}
const computed = {}
const unexplained = []
const count = (map, key) => (map[key] = (map[key] ?? 0) + 1)
const pathOf = (reason) => reason.split(/[: ]/)[0]
for (const value of replies.values()) {
  const key = JSON.stringify(value)
  const role = value.role
  const row = (byRole[role] ??= { replies: 0, bothAccept: 0, bothRefuse: 0, originRefused: 0, portRefused: 0, explained: {}, computed: {} })
  row.replies++
  const reasons = validateReply(role, value)
  const theirs = { accepted: reasons.length === 0, reasons }
  if (!theirs.accepted) row.originRefused++
  if (role === 'sweep') fixture.removals(Array.isArray(value.dispositions) ? value.dispositions.map((d) => d?.requirement).filter((r) => typeof r === 'string' && r) : [])
  const ours = portCheck(role, key, fixture)
  if (!ours.converted) {
    count(row.explained, ours.class)
    count(explained, ours.class)
    continue
  }
  if (!ours.accepted) row.portRefused++
  if (theirs.accepted === ours.accepted) {
    if (theirs.accepted) {
      row.bothAccept++
      for (const c of computedDiffers(role, value, ours.result)) {
        count(row.computed, c)
        count(computed, c)
      }
    } else row.bothRefuse++
    continue
  }
  const classes = classify(theirs, ours)
  if (classes === null) {
    unexplained.push({ role, id: createHash('sha256').update(key).digest('hex').slice(0, 12), theirs: reasons.map(pathOf), ours: ours.errors.map(pathOf) })
    continue
  }
  for (const c of classes) {
    count(row.explained, c)
    count(explained, c)
  }
}

fixture.remove()
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ transcripts: transcripts.length, replies: replies.size, sources, expandedShas, explained, computed, byRole, unexplained }, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
