// The inputs of apply's code reuse sweep and the filter over its reply. The sweep's question —
// does the branch add what the tree already has — is the dispatched agent's; everything around
// it is computed here:
//
// - the range: the change's base from its metadata, `origin/<base>` when that remote-tracking
//   ref exists, else `<base>`, through `git merge-base` with HEAD (as plan-symbols resolves it);
// - the second question's input: every REMOVED or RENAMED requirement of the change's delta
//   specs, with its `**Code Disposition:**` text, or null when it has none (itself a finding);
// - the DUP markers already in the tree, and the filter that drops a finding a marker accepts;
// - the debt records of the reply's dispositions, one per removed or renamed requirement;
// - a consolidation round over the open findings (`consolidate`), its `consolidation` ledger
//   record, and the `re-sweep` record of the round's re-sweep.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changeDir, readChangeMeta } from './changes.mjs'
import { coveringMarker, findMarkers, relativeFindings, relativeLocation, TRAILING_TEXT } from './dup.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { baseRef } from './plan-symbols.mjs'
import { appendRecord, appendScripted, readRecords } from './ledger.mjs'
import { attemptsFile, parseEvents, readLog } from './attempts.mjs'
import { MAX_ROUNDS } from './dispatch.mjs'
import { consolidationState, sweepState } from './loop.mjs'
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
  // No metadata: baseRef names the missing base.
  const ref = baseRef(readChangeMeta(root, dir), (name) => {
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

// No finding's `introduced` or `existing` may carry text after its line (lib/dup.mjs
// TRAILING_TEXT): a symbol after the line once kept `locate` from reading the file, and a
// consolidated duplicate stayed open. A bare path, `path:line` and `path:line-line` pass. Nor,
// given `root`, may it be absolute outside the repository (lib/dup.mjs relativeLocation); one
// absolute under it is accepted and recorded relative. One error per location at fault.
export function locationErrors(findings, root) {
  const errors = []
  ;(findings ?? []).forEach((f, i) => {
    for (const key of ['introduced', 'existing']) {
      if (TRAILING_TEXT.test(String(f[key] ?? '').trim())) errors.push(`$.findings[${i}].${key}: "${f[key]}" has text after its line; write path, path:line or path:line-line, with nothing after the line`)
      else if (root !== undefined && relativeLocation(root, f[key]) === null) errors.push(`$.findings[${i}].${key}: "${f[key]}" is outside the repository; write the path relative to the repository root`)
    }
  })
  return errors
}

// The sweep reply, checked under sweep.schema.json and locationErrors, its locations made
// relative to `root`, with every finding a DUP marker accepts dropped. A refused reply is no verdict, never CLEAN: the result is then { ok:
// false, reasons }. The coverage of the dispositions is checked where the change is known, by
// `dispatch.mjs reply` (lib/reply.mjs).
export function filterReply(root, text) {
  const parsed = parseReply(text)
  const schemaErrors = parsed.errors.length ? parsed.errors : validateJson(readSchema(SWEEP_SCHEMA), parsed.reply)
  const reasons = schemaErrors.length ? schemaErrors : locationErrors(parsed.reply.findings, root)
  if (reasons.length) return { ok: false, error: 'the sweep reply is refused; it is no verdict', reasons }
  const reply = parsed.reply
  return { ok: true, ...dupFilter(root, relativeFindings(root, reply.findings)), ...(reply.dispositions ? { dispositions: reply.dispositions } : {}) }
}

// The names of consolidation round k: its fix, the fix's re-review, and the re-sweep.
export const roundNames = (k) => ({ fix: `fix sweep r${k}`, reReview: `re-review sweep r${k}`, sweep: `sweep r${k}` })

// Opens a consolidation round on what is open (lib/loop.mjs consolidationState): the sweep's
// findings and its review loop's, recorded as a `consolidation` ledger record with the reason
// before the fix is dispatched; `dispatch.mjs prompt --role fix --subject sweep` refuses a round
// with no record. A round whose re-sweep has no accepted reply yet is in flight: it is returned
// again (`already`), nothing recorded. At MAX_ROUNDS the developer decides.
// Returns { ok, round, findings, fix, reReview, sweep, record, already }.
export function consolidate(root, change, { reason, env = process.env } = {}) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('--reason is empty: say why the findings are consolidated rather than dismissed')
  const rounds = readRecords(root, change).filter((r) => r.kind === 'consolidation')
  const last = rounds.at(-1)
  if (last) {
    const k = Number(last.round)
    const reswept = parseEvents(readLog(attemptsFile(root, change))).some((e) => e.event === 'valid' && e.name === roundNames(k).sweep)
    if (!reswept) return { ok: true, round: k, findings: last.findings.split(','), ...roundNames(k), record: last, already: true }
  }
  const state = consolidationState(root, change)
  if (state.open.length === 0) throw new Error('nothing to consolidate: no sweep finding and no finding of a consolidation is open')
  const k = rounds.length + 1
  if (k > MAX_ROUNDS) throw new Error(`the consolidation has run ${MAX_ROUNDS} rounds; escalate to the developer with what is open: ${state.open.join(', ')}`)
  const { record } = appendScripted(root, change, 'consolidation', { round: String(k), findings: state.open.join(','), reason: reason.trim() }, { env })
  return { ok: true, round: k, findings: state.open, ...roundNames(k), record, already: false }
}

// The `re-sweep` ledger record of an accepted `sweep r<k>` reply: what round k's re-sweep
// cleared and what stays open, read from the sweep state once the reply is recorded.
export function recordReSweep(root, change, round, { env = process.env } = {}) {
  const state = sweepState(root, change)
  const list = (ids) => (ids.length ? ids.join(',') : 'none')
  const cleared = state.cleared.map((c) => c.id)
  return appendScripted(root, change, 're-sweep', { round: String(round), cleared: list(cleared), open: list(state.open.map((f) => f.id)) }, { env }).record
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
