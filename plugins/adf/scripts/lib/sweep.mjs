// The inputs of apply's code reuse sweep and the filter over its reply. The sweep's question —
// does the branch add what the tree already has — is the dispatched agent's; everything around
// it is computed here:
//
// - the range: the change's base from its .adf.json, `origin/<base>` when that remote-tracking
//   ref exists, else `<base>`, through `git merge-base` with HEAD (as plan-symbols resolves it);
// - the second question's input: every REMOVED or RENAMED requirement of the change's delta
//   specs, with its `**Code Disposition:**` text, or null when it has none (itself a finding);
// - the DUP markers already in the tree, and the filter that drops a finding a marker accepts;
// - the debt records of the reply's dispositions, one per removed or renamed requirement.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changeDir, META_FILE } from './changes.mjs'
import { coveringMarker, findMarkers } from './dup.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { baseRef } from './plan-symbols.mjs'
import { appendRecord, readRecords } from './ledger.mjs'
import { findSection, parseSections } from './specs.mjs'

export const SWEEP_SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'sweep.schema.json')

const DISPOSITION = /^\s*\*\*Code Disposition(?::\*\*|\*\*:)\s*(.*)$/

// The disposition text: the label's line and its continuation, up to a blank line or the next
// bold label.
function dispositionIn(lines) {
  const i = lines.findIndex((l) => DISPOSITION.test(l))
  if (i === -1) return null
  const out = [DISPOSITION.exec(lines[i])[1]]
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || /^\s*\*\*\w/.test(l) || /^\s*-\s*(FROM|TO):/.test(l) || /^---\s*$/.test(l)) break
    out.push(l.trim())
  }
  const text = out.join(' ').replace(/<!--[\s\S]*?-->/g, '').trim()
  return text || null
}

// REMOVED and RENAMED requirements of one delta spec: [{ op, requirement, from?, codeDisposition }].
export function removalsIn(content) {
  const sections = parseSections(content)
  const out = []
  const removed = findSection(sections, 'REMOVED Requirements')
  for (const child of removed?.children ?? []) {
    const m = /^Requirement:\s*(.+)$/.exec(child.title)
    if (m) out.push({ op: 'REMOVED', requirement: m[1].trim(), codeDisposition: dispositionIn(child.content.split('\n')) })
  }
  const renamed = findSection(sections, 'RENAMED Requirements')
  if (renamed) {
    const lines = renamed.content.split('\n')
    const pairs = []
    lines.forEach((l, i) => {
      const from = /^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/.exec(l)
      const to = /^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/.exec(l)
      if (from) pairs.push({ from: from[1].trim(), start: i })
      else if (to && pairs.length && !pairs.at(-1).to) pairs.at(-1).to = to[1].trim()
    })
    pairs.forEach((p, k) => {
      const end = pairs[k + 1]?.start ?? lines.length
      out.push({ op: 'RENAMED', requirement: p.to ?? null, from: p.from, codeDisposition: dispositionIn(lines.slice(p.start, end)) })
    })
  }
  return out
}

function specFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md')) out.push(path)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

export function sweepInputs(root, change) {
  const dir = changeDir(root, change)
  if (!existsSync(dir)) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let meta = null
  try {
    meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
  } catch {
    // baseRef names the missing base
  }
  const ref = baseRef(meta, (name) => {
    try {
      git('rev-parse', '--verify', '--quiet', name)
      return true
    } catch {
      return false
    }
  })
  let mergeBase
  try {
    mergeBase = git('merge-base', ref, 'HEAD')
  } catch {
    throw new Error(`git merge-base ${ref} HEAD failed in ${root}; the base does not resolve`)
  }
  const head = git('rev-parse', 'HEAD')
  const removedOrRenamed = specFiles(join(dir, 'specs')).flatMap((file) =>
    removalsIn(readFileSync(file, 'utf8')).map((r) => ({ ...r, spec: file.slice(dir.length + 1).split('\\').join('/') }))
  )
  return {
    ok: true,
    change,
    base: ref,
    mergeBase,
    head,
    range: `${mergeBase}..${head}`,
    secondQuestion: removedOrRenamed.length > 0,
    removedOrRenamed,
    missingDisposition: removedOrRenamed.filter((r) => r.codeDisposition === null).map((r) => r.requirement ?? r.from),
    dupMarkers: findMarkers(root)
  }
}

// The sweep's findings with every one a DUP marker in the tree accepts dropped, and the verdict
// computed from what is left: { verdict: CLEAN | FINDINGS, findings, dropped }.
export function dupFilter(root, replyFindings) {
  const markers = findMarkers(root)
  const findings = []
  const dropped = []
  for (const finding of replyFindings) {
    const marker = coveringMarker(markers, finding)
    if (marker) dropped.push({ ...finding, marker: `${marker.file}:${marker.line}` })
    else findings.push(finding)
  }
  return { verdict: findings.length ? 'FINDINGS' : 'CLEAN', findings, dropped }
}

// The sweep reply, checked under sweep.schema.json, with every finding a DUP marker accepts
// dropped. A refused reply is no verdict, never CLEAN: the result is then { ok: false, reasons }.
// The coverage of the dispositions is checked where the change is known, by `dispatch.mjs reply`
// (lib/reply.mjs).
export function filterReply(root, text) {
  const parsed = parseReply(text)
  const reasons = parsed.errors.length ? parsed.errors : validateJson(readSchema(SWEEP_SCHEMA), parsed.reply)
  if (reasons.length) return { ok: false, error: 'the sweep reply is refused; it is no verdict', reasons }
  const reply = parsed.reply
  return { ok: true, ...dupFilter(root, reply.findings), ...(reply.dispositions ? { dispositions: reply.dispositions } : {}) }
}

// One `debt` record per disposition of an accepted sweep reply, carrying the sweep's answer as
// its reason; it never blocks apply, and archive places it. A disposition already recorded with
// the same text is skipped, so a repeated call records nothing twice.
// Returns [{ requirement, id } | { requirement, skipped }].
export function recordDispositions(root, change, dispositions, { env = process.env } = {}) {
  const out = []
  for (const { requirement, disposition } of dispositions ?? []) {
    const what = `the Code Disposition of the removed or renamed requirement "${requirement}"`
    const same = readRecords(root, change).find((r) => r.kind === 'debt' && r.what === what && r.reason === disposition)
    if (same) out.push({ requirement, skipped: `${same.id} already records it` })
    else out.push({ requirement, id: appendRecord(root, change, 'debt', { what, reason: disposition }, { env }).record.id })
  }
  return out
}
