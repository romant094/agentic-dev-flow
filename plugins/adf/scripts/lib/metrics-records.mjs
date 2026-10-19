// The metrics' readers over one change's SDD directory, `.superpowers/sdd/<change>/` in the
// change worktree: the dispatch events and their computed results, the test-run records, the
// review stage's state, the verify run and the ledger. Each reader returns `{ value, reason }`:
// `value` is null and `reason` names what is missing when its source is absent, never a 0 that
// reads as a measurement. Pure apart from reading files; nothing is written.
//
//   readReplies     attempts.jsonl   per role { dispatches, valid, invalid, retries, stops }
//   readImpl        attempts.jsonl   the impl replies' computed status counts
//   readFindings    attempts.jsonl   per review layer, from the accepted (checked) replies only;
//                   + review/        ai-review from review/r<k>/findings.json; an absent layer
//                                    has no entry
//   readCompliance  plan.md          wave-1 fan-out: the wave-1 groups (two or more) against the
//                   + attempts.jsonl groups a group dispatch name of the log carries
//   readTests       tests/*.json     { runs, failed, uncounted }
//   readReview      review/          verdict (review.md), rounds, dispositions
//   readVerify      verify/run.json  each check's verdict, warnings, the out-of-plan files
//   readLedger      ledger.jsonl     counts per kind, unresolved debt, deviations, handoffs,
//                                    rulings, sessions
//
// The severity map puts the apply reviews' Superpowers scale on the review stage's: the record
// keeps both the native counts and the mapped ones; the sweep has no severity and is counted only.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attemptsFile, parseEvents } from './attempts.mjs'
import { changeDir } from './changes.mjs'
import { MAX_ATTEMPTS, parseGraph, parseName, sddDir } from './dispatch.mjs'
import { ledgerPath, readLedger as parseLedger, unresolvedDebt } from './ledger.mjs'
import { checkRecord, loadState, recordPath, reviewDir } from './review-state.mjs'
import { readTestRecord, TESTS_DIR } from './suite.mjs'
import { computeVerdict, verifyDir } from './verify.mjs'

export const SEVERITY_MAP = { critical: 'CRITICAL', important: 'HIGH', minor: 'MEDIUM' }
export const MAPPED = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
export const LAYERS = ['review', 're-review', 'final-review', 'merge-review', 'sweep', 'ai-review']
export const IMPL_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT']
export const FANOUT_RULE = 'wave-1 fan-out'
export const QUIET_RUN = 3

const present = (value) => ({ value, reason: null })
const absent = (reason) => ({ value: null, reason })
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const rel = (change, file) => `.superpowers/sdd/${change}/${file}`

// The events of the change's log, or the reason there are none to read.
function events(root, change) {
  const file = attemptsFile(root, change)
  if (!existsSync(file)) return absent(`no ${rel(change, 'attempts.jsonl')}`)
  return present(parseEvents(readFileSync(file, 'utf8')))
}

// ---------------------------------------------------------------- attempts

export function readReplies(root, change) {
  const log = events(root, change)
  if (log.value === null) return log
  const out = {}
  const invalidOf = new Map()
  for (const e of log.value) {
    const role = parseName(e.name)?.role
    if (!role) continue
    const entry = (out[role] ??= { dispatches: 0, valid: 0, invalid: 0, retries: 0, stops: 0 })
    if (e.event === 'dispatch') entry.dispatches++
    else if (e.event === 'valid') entry.valid++
    else if (e.event === 'invalid') {
      entry.invalid++
      const n = (invalidOf.get(e.name) ?? 0) + 1
      invalidOf.set(e.name, n)
      // The log's own `next` when it carries one; else the retry rule counted over the name.
      const next = e.next ?? (n < MAX_ATTEMPTS ? 'retry' : 'stop')
      if (next === 'retry') entry.retries++
      else if (next === 'stop') entry.stops++
    }
  }
  return present(out)
}

const accepted = (log, roles) => log.filter((e) => e.event === 'valid' && roles.includes(parseName(e.name)?.role))

export function readImpl(root, change) {
  const log = events(root, change)
  if (log.value === null) return log
  const replies = accepted(log.value, ['impl'])
  if (replies.length === 0) return absent('no accepted impl reply in attempts.jsonl')
  const out = Object.fromEntries(IMPL_STATUSES.map((s) => [s, 0]))
  for (const e of replies) if (Object.hasOwn(out, e.result?.status)) out[e.result.status]++
  return present(out)
}

const emptyMapped = () => Object.fromEntries(MAPPED.map((s) => [s, 0]))

// The ai-review layer from the review stage's stored rounds: one dispatch per stored reply (a
// sliced round has one per slice), the round's renumbered findings already on the CRITICAL..LOW
// scale. Null when no round stored its findings.
function aiReviewLayer(root, change) {
  const dir = reviewDir(root, change)
  if (!existsSync(dir)) return null
  let entry = null
  for (let k = 1; existsSync(join(dir, `r${k}`)); k++) {
    const rd = join(dir, `r${k}`)
    if (!existsSync(join(rd, 'findings.json'))) continue
    const stored = readJson(join(rd, 'findings.json'))
    entry ??= { dispatches: 0, findings: 0, native: {}, mapped: emptyMapped() }
    entry.dispatches += readdirSync(rd).filter((f) => /^reply(?:-s\d+)?\.json$/.test(f)).length
    for (const f of stored.findings ?? []) {
      entry.findings++
      entry.native[f.severity] = (entry.native[f.severity] ?? 0) + 1
      if (Object.hasOwn(entry.mapped, f.severity)) entry.mapped[f.severity]++
    }
  }
  return entry
}

export function readFindings(root, change) {
  const log = events(root, change)
  const ai = aiReviewLayer(root, change)
  if (log.value === null && ai === null) return absent(`${log.reason}, and no stored review round`)
  const out = {}
  for (const e of accepted(log.value ?? [], LAYERS)) {
    const layer = parseName(e.name).role
    const sweep = layer === 'sweep'
    const entry = (out[layer] ??= { dispatches: 0, findings: 0, native: {}, mapped: sweep ? null : emptyMapped() })
    entry.dispatches++
    const list = e.result?.findings
    if (!Array.isArray(list)) {
      // An accepted reply whose event carries no computed result: a dispatch with no count.
      entry.uncounted = (entry.uncounted ?? 0) + 1
      continue
    }
    entry.findings += list.length
    if (sweep) continue
    for (const f of list) {
      entry.native[f.severity] = (entry.native[f.severity] ?? 0) + 1
      const mapped = SEVERITY_MAP[f.severity]
      if (mapped) entry.mapped[mapped]++
    }
  }
  if (ai !== null) out['ai-review'] = ai
  return present(out)
}

// ---------------------------------------------------------------- compliance

// Required: the plan's wave-1 group letters when there are two or more (one wave-1 group runs as
// a single pass, with nothing to fan out). Performed: the wave-1 letters a group dispatch name of
// the log carries (`merge-review <G>`, `fix <G>`, `re-review <G>`): a group merged from its own
// worktree is merge-reviewed under its letter. Never `git worktree list`, empty by archive.
export function readCompliance(root, change) {
  const planFile = join(changeDir(root, change), 'plan.md')
  if (!existsSync(planFile)) return absent(`no openspec/changes/${change}/plan.md`)
  const groups = parseGraph(readFileSync(planFile, 'utf8'))
  if (groups.length === 0) return absent('the plan has no Execution Graph group table')
  const log = events(root, change)
  if (log.value === null) return log
  const wave1 = groups.filter((g) => g.wave === 1).map((g) => g.letter)
  const required = wave1.length >= 2 ? wave1 : []
  const seen = new Set(log.value.map((e) => parseName(e.name)?.group).filter(Boolean))
  return present([{ rule: FANOUT_RULE, required, performed: wave1.filter((g) => seen.has(g)) }])
}

// ---------------------------------------------------------------- tests

// A run fails on a non-zero or missing exit, a timeout, or a failed count; a run with no count
// line is uncounted. A file that is no test-run record is listed, not counted.
export function readTests(root, change) {
  const dir = join(sddDir(root, change), TESTS_DIR)
  if (!existsSync(dir)) return absent(`no ${rel(change, `${TESTS_DIR}/`)}`)
  const out = { runs: 0, failed: 0, uncounted: 0, unreadable: [] }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let record
    try {
      record = readTestRecord(join(dir, file))
    } catch {
      out.unreadable.push(file)
      continue
    }
    out.runs++
    if (record.exit !== 0 || record.timedOut || (record.counts?.fail ?? 0) > 0) out.failed++
    if (record.counts === null) out.uncounted++
  }
  return present(out)
}

// ---------------------------------------------------------------- review

// The verdict is the committed record's (`review.md`), null until it is assembled; the rounds and
// the dispositions are the state's, counted per `as`.
export function readReview(root, change) {
  const state = loadState(root, change)
  if (!state.start) return absent(`no ${rel(change, 'review/start.json')}: the review stage did not start`)
  const file = join(root, recordPath(change))
  const record = existsSync(file) ? checkRecord(readFileSync(file, 'utf8')) : null
  const dispositions = {}
  for (const d of Object.values(state.dispositions)) dispositions[d.as] = (dispositions[d.as] ?? 0) + 1
  return present({ verdict: record?.verdict ?? null, rounds: state.rounds.length, dispositions, stopped: Boolean(state.stopped) })
}

// ---------------------------------------------------------------- verify

// The files `out-of-plan.txt` lists under `out of plan:`, one `  <sha> <file> (<why>)` line each.
function outOfPlanFiles(text) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.startsWith('out of plan:'))
  if (at === -1) return null
  const files = []
  for (const line of lines.slice(at + 1)) {
    const m = /^ {2}[0-9a-f]{7,40} (.+) \([^()]*\)$/.exec(line)
    if (!m) break
    if (!files.includes(m[1])) files.push(m[1])
  }
  return files
}

// Each check's verdict: run.json's script checks and the agents' sections, a failure or a
// not-run the developer accepted by a ruling read as `ruled`. `verdict` is the overall line, null
// while the record cannot be given one. `filesOutsidePlan` is null when the check did not run or
// its output is gone.
export function readVerify(root, change) {
  const dir = verifyDir(root, change)
  if (!existsSync(join(dir, 'run.json'))) return absent(`no ${rel(change, 'verify/run.json')}`)
  const result = computeVerdict(root, { change })
  const checks = Object.fromEntries(result.checks.map((c) => [c.id, c.accepted ? 'ruled' : c.verdict]))
  const run = readJson(join(dir, 'run.json'))
  const warnings = [
    ...result.checks.filter((c) => c.verdict === 'warn').map((c) => ({ check: c.id, summary: c.summary })),
    ...run.checks.flatMap((c) => (c.countWarnings ?? []).map((w) => ({ check: c.id, summary: typeof w === 'string' ? w : JSON.stringify(w) })))
  ]
  const outOfPlan = result.checks.find((c) => c.id === 'out-of-plan')
  let filesOutsidePlan = null
  if (outOfPlan && outOfPlan.verdict !== 'not-run' && existsSync(join(root, outOfPlan.output))) {
    filesOutsidePlan = outOfPlanFiles(readFileSync(join(root, outOfPlan.output), 'utf8'))
  }
  return present({ verdict: result.ok === false && result.refusals ? null : result.verdict, checks, warnings, filesOutsidePlan })
}

// ---------------------------------------------------------------- ledger

export function readLedger(root, change) {
  const file = ledgerPath(root, change)
  if (!existsSync(file)) return absent(`no ${rel(change, 'ledger.jsonl')}`)
  let records
  try {
    records = parseLedger(readFileSync(file, 'utf8'))
  } catch (error) {
    return absent(`${rel(change, 'ledger.jsonl')} does not parse: ${error.message}`)
  }
  const counts = {}
  for (const r of records) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const pick = (r, keys) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  return present({
    counts,
    unresolvedDebt: unresolvedDebt(records).map((r) => pick(r, ['id', 'what', 'reason', 'task'])),
    deviations: records.filter((r) => r.kind === 'deviation').map((r) => pick(r, ['id', 'rule', 'reason', 'task'])),
    handoffs: counts.handoff ?? 0,
    rulings: counts.ruling ?? 0,
    sessions: records.filter((r) => r.kind === 'session').map((r) => pick(r, ['id', 'sessionId', 'phase', 'at']))
  })
}

// ---------------------------------------------------------------- all of them

const READERS = {
  replies: readReplies,
  impl: readImpl,
  findings: readFindings,
  compliance: readCompliance,
  tests: readTests,
  review: readReview,
  verify: readVerify,
  ledger: readLedger
}

// Every group, plus `isolation.filesOutsidePlan` from verify, and `coverage`: `record` for a
// group read, `{ none: reason }` for one whose source is absent. A reader that throws (a source
// that exists and is malformed) is a gap too, named by its error.
export function readSddRecords(root, change) {
  const out = { coverage: {} }
  for (const [group, read] of Object.entries(READERS)) {
    let got
    try {
      got = read(root, change)
    } catch (error) {
      got = absent(`could not be read: ${error.message}`)
    }
    out[group] = got.value
    out.coverage[group] = got.value === null ? { none: got.reason } : 'record'
  }
  out.isolation = { filesOutsidePlan: out.verify?.filesOutsidePlan ?? null }
  return out
}

// ---------------------------------------------------------------- removal candidates

// The review layers and verify checks quiet for `run` consecutive changes, newest first by
// `generatedAt`: a zero (a `pass` for a check) extends the run, anything else ends it, and a
// change without the layer or the check is skipped.
export function removalCandidates(records, run = QUIET_RUN) {
  const newestFirst = [...records].sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')))
  const quiet = (signal) => {
    let n = 0
    for (const r of newestFirst) {
      const s = signal(r)
      if (s === null) continue
      if (!s) return false
      if (++n >= run) return true
    }
    return false
  }
  const layers = LAYERS.filter((layer) =>
    quiet((r) => {
      const entry = r.findings?.[layer]
      if (!entry || typeof entry.findings !== 'number') return null
      return entry.findings === 0
    })
  )
  // A record's verify group is `{ <check>: verdict }`, or readVerify's value with them under `checks`.
  const verdictsOf = (r) => r.verify?.checks ?? r.verify ?? {}
  const ids = [...new Set(newestFirst.flatMap((r) => Object.keys(verdictsOf(r))))].sort()
  const checks = ids.filter((id) =>
    quiet((r) => {
      const verdict = verdictsOf(r)[id]
      if (typeof verdict !== 'string' || verdict === 'not-run') return null
      return verdict === 'pass'
    })
  )
  return { layers, checks }
}
