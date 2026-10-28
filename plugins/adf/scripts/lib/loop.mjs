// The state of apply's review loops, computed by script from the accepted replies' results
// (lib/attempts.mjs `valid` events, which lib/reply.mjs computes) and the ledger's rulings, so
// the orchestrator neither copies findings between dispatches nor remembers which are open.
//
// A loop's subject is a task (T<n>), a group after its merge review (its letter), or the final
// review (`final`); the reuse sweep is the subject `sweep`. A ruling on one item of a subject:
//
//   ledger.mjs ruling --change <c> --subject <subject> --finding <id> --as accepted|dismissed|fix
//                     --decision "<why>"
//
// accepted and dismissed close the item; fix sends a plan-mandated finding, or a deferred one,
// into the fix loop. The last ruling of an id wins.
//
// loopState(history, rulings): the subject's
//   open          the last result's open set, plus each finding ruled fix that no re-review has
//                 addressed, less the ones ruled accepted or dismissed: what the next fix
//                 fixes and its re-review answers;
//   toRule        every plan-mandated finding of the history no ruling names (a re-review does
//                 not carry them forward, so they are collected from every result);
//   unverifiable  every item a review could not verify, U<k> in log order, not yet accepted or
//                 dismissed (a defect found while checking one is a new review's finding);
//   state         unreviewed (no result) | rule (toRule or unverifiable left) | fix (open left)
//                 | clean.
//
// sweepState(root, change): the reuse sweep's findings, S<k> by first report, and the open ones.
// The first sweep is two passes, `sweep p1` and `sweep p2`, read as one run once both are
// accepted on one HEAD (`ran` false until then, with `missing` naming the pass not yet accepted,
// or `error` when the HEADs differ); the re-sweeps `sweep r<k>` follow. One duplicate keeps one
// S<k> across passes and runs: a finding whose `introduced` and `existing` name the same files
// with overlapping lines as an earlier report is that report (lib/dup.mjs sameDuplicate).
// A finding stays open across sweep runs until one of: a DUP marker in the tree now accepts it
// (`dup.mjs mark`, the developer's dismissal, at any location it was reported at); a ruling accepts or dismisses it; or a later sweep
// no longer reports it and its introduced file changed between the sweep that last reported it
// and that later one (a consolidation), unless the round's `re-review sweep r<k>` listed it in
// `notConsolidated`, or an accepted `debt` record of `dup.mjs mark` names
// the pair (lib/dup.mjs dismissalOf): its marker commit changed the file, and the finding was
// dismissed. That record also clears a finding no later sweep has run on, where no marker fits. A later CLEAN with the file unchanged clears nothing: a second CLEAN on an
// unchanged branch would launder the first finding. Locations are read relative to the
// repository root (lib/dup.mjs relativeFindings), whatever a recorded reply wrote.
//
// An apply round (`plan.mjs reopen`) runs the final review and the sweep again: the subjects
// `final` and `sweep` (ROUND_SUBJECTS) read only the events, rulings and consolidation records at
// or after the current round's start (lib/ledger.mjs applyRound), so their ids, rounds and state
// start anew; round 0, a change with no round record, reads them all. A task's or a group's loop
// is its own and reads them all.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { attemptsFile, parseEvents, readLog } from './attempts.mjs'
import { parseName, sddDir, SWEEP_SUBJECT } from './dispatch.mjs'
import { coveringMarker, dismissalOf, findMarkers, locate, relativeFindings, relativeLocation, sameDuplicate } from './dup.mjs'
import { applyRound, readRecords } from './ledger.mjs'
import { gitIn } from './workspace.mjs'

export const REVIEW_ROLES = ['review', 'final-review', 'merge-review']
export const LOOP_ROLES = [...REVIEW_ROLES, 're-review']
export { SWEEP_SUBJECT }
export const CLOSING = ['accepted', 'dismissed']

const unique = (list) => [...new Set(list)]

export const ROUND_SUBJECTS = ['final', SWEEP_SUBJECT]
// The current apply round's start, null in round 0; the filter of what is at or after it.
export const roundStart = (records) => applyRound(records)?.at ?? null
export const atOrAfter = (since) => (x) => since === null || String(x.at ?? '') >= since
export const subjectSince = (records, subject) => (ROUND_SUBJECTS.includes(subject) ? roundStart(records) : null)

// The subject a review loop belongs to: T<n>, a group letter, `sweep` for a consolidation's fix
// and re-review, or `final`.
export const subjectOf = (parts) =>
  parts.subject !== undefined ? parts.subject : parts.task !== undefined ? `T${parts.task}` : parts.group !== undefined ? parts.group : 'final'

// The computed results of the subject's accepted reviews and re-reviews, in log order, from `since`.
export function subjectHistory(eventsText, subject, since = null) {
  return parseEvents(eventsText)
    .filter((e) => e.event === 'valid' && e.result)
    .filter(atOrAfter(since))
    .filter((e) => {
      const parts = parseName(e.name)
      return parts && LOOP_ROLES.includes(parts.role) && subjectOf(parts) === subject
    })
    .map((e) => e.result)
}

// The last ruling of each id of one subject, from `since`: Map id -> ledger record.
export function subjectRulings(records, subject, since = null) {
  return new Map(records.filter((r) => r.kind === 'ruling' && r.subject === subject && typeof r.as === 'string').filter(atOrAfter(since)).map((r) => [r.finding, r]))
}

export function loopState(history, rulings = new Map()) {
  if (history.length === 0) return { state: 'unreviewed', findings: [], open: [], toRule: [], unverifiable: [], addressed: [] }
  const findings = new Map(history.flatMap((r) => r.findings ?? []).map((f) => [f.id, f]))
  const addressed = new Set(history.flatMap((r) => r.addressed ?? []))
  const as = (id) => rulings.get(id)?.as
  const ruledFix = [...rulings.keys()].filter((id) => as(id) === 'fix' && findings.has(id) && !addressed.has(id))
  const open = unique([...history.at(-1).open, ...ruledFix]).filter((id) => !CLOSING.includes(as(id)))
  const toRule = unique(history.flatMap((r) => r.toRule ?? [])).filter((id) => !rulings.has(id))
  const unverifiable = history
    .flatMap((r) => r.unverifiable ?? [])
    .map((u, i) => ({ id: `U${i + 1}`, ...u }))
    .filter((u) => !CLOSING.includes(as(u.id)))
  const state = toRule.length || unverifiable.length ? 'rule' : open.length ? 'fix' : 'clean'
  return { state, findings: [...findings.values()], open, toRule, unverifiable, addressed: [...addressed] }
}

// One subject's loop state, read from the change worktree's events log and ledger.
export function subjectState(root, change, subject) {
  const records = readRecords(root, change)
  const since = subjectSince(records, subject)
  const rulings = subjectRulings(records, subject, since)
  return { subject, ...loopState(subjectHistory(readLog(attemptsFile(root, change)), subject, since), rulings), rulings }
}

export const rulingCommand = (change, subject, id = '<id>') =>
  `ledger.mjs ruling --change ${change} --subject ${subject} --finding ${id} --as accepted|dismissed|fix --decision "<why>"`

// What keeps a subject from clean, in one sentence; null when it is clean.
export function notClean(state, change) {
  if (state.state === 'clean') return null
  if (state.state === 'unreviewed') return `no accepted review of ${state.subject} is recorded (dispatch.mjs reply records it)`
  const parts = [
    state.open.length ? `open ${state.open.join(', ')}` : null,
    state.toRule.length ? `to rule ${state.toRule.join(', ')}` : null,
    state.unverifiable.length ? `unverifiable ${state.unverifiable.map((u) => u.id).join(', ')}` : null
  ].filter(Boolean)
  return `${state.subject} is not clean (${parts.join('; ')}): fix the open findings in a round, or rule on each with ${rulingCommand(change, state.subject)}`
}

// ---------------------------------------------------------------- rendering for prompts

const where = (f) => `${f.file}${Number.isInteger(f.line) ? `:${f.line}` : ''}`
const indent = (text) => String(text).split('\n').join('\n    ')

// One finding as a prompt field entry: the id, severity, category and location, then its title,
// its body on the lines below, and a fix ruling's decision.
export function renderFinding(f, ruling) {
  const decided = ruling?.as === 'fix' ? `\nRuled fix: ${ruling.decision}` : ''
  return indent(`${f.id} (${f.severity}, ${f.category}) ${where(f)}: ${f.title}\n${f.body}${decided}`)
}

// The subject's open findings, each rendered; refuses when there is none to fix.
export function openFindings(state, change) {
  if (state.open.length === 0) {
    const why = state.state === 'rule' ? `; ${notClean(state, change)}` : ''
    throw new Error(`${state.subject} has no open finding to fix${why}`)
  }
  const byId = new Map(state.findings.map((f) => [f.id, f]))
  return state.open.map((id) => renderFinding(byId.get(id), state.rulings?.get(id)))
}

// ---------------------------------------------------------------- the test-first proof

// The review result of a test-first task with the proof's verdict: `proof` false with
// `commitPasses` true (the new test passes without the task's code) adds a critical tests
// finding, after the subject's highest id, to the open set.
export function withProofFinding(result, proof, history = []) {
  if (!proof) return result
  const summary = { proof: proof.proof, parentFails: proof.parentFails, commitPasses: proof.commitPasses, commit: proof.commit, file: proof.file }
  if (!(proof.proof === false && proof.commitPasses === true)) return { ...result, tddProof: summary }
  const ids = [...history, result].flatMap((r) => r.findings ?? []).map((f) => Number(/^F(\d+)$/.exec(f.id ?? '')?.[1] ?? 0))
  const finding = {
    id: `F${Math.max(0, ...ids) + 1}`,
    severity: 'critical',
    kind: 'quality',
    category: 'tests',
    file: proof.testFiles?.[0] ?? proof.file,
    line: null,
    title: "The new test passes without the task's code",
    body: `tdd-proof ran the commit's test files on its parent ${String(proof.parent ?? '').slice(0, 7)}, where they passed, so the test cannot fail. Outputs: ${proof.outputFiles?.parent}, ${proof.outputFiles?.commit}.`,
    planMandated: false,
    source: 'tdd-proof'
  }
  const open = [...result.open, finding.id]
  return {
    ...result,
    findings: [...result.findings, finding],
    quality: 'needs-fixes',
    open,
    result: result.toRule.length || result.unverifiable?.length ? 'rule' : 'fix',
    tddProof: summary
  }
}

// ---------------------------------------------------------------- the deferred list

export const deferredFile = (root, change) => join(sddDir(root, change), 'deferred.json')

// What the reviews left for the final review: each deferred minor finding and each out-of-scope
// item of a re-review, in log order, with its subject and the dispatch that reported it; from
// `since`, the current apply round's start.
export function deferredItems(eventsText, since = null) {
  const items = []
  for (const e of parseEvents(eventsText).filter(atOrAfter(since))) {
    const parts = e.event === 'valid' && e.result ? parseName(e.name) : null
    if (!parts || !LOOP_ROLES.includes(parts.role)) continue
    const { subject, findings = [], deferred = [], outOfScope = [] } = e.result
    const byId = new Map(findings.map((f) => [f.id, f]))
    for (const id of deferred) {
      const f = byId.get(id)
      if (f) items.push({ subject, dispatch: e.name, source: 'minor', id, severity: f.severity, category: f.category, file: f.file, line: f.line, title: f.title, body: f.body })
    }
    for (const o of outOfScope) items.push({ subject, dispatch: e.name, source: 'out-of-scope', file: o.file, line: o.line, title: o.title })
  }
  return items
}

// Writes `.superpowers/sdd/<change>/deferred.json` from the events log: { file, items }.
export function writeDeferred(root, change) {
  const file = deferredFile(root, change)
  const items = deferredItems(readLog(attemptsFile(root, change)), roundStart(readRecords(root, change)))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`)
  return { file, items }
}

export const renderDeferred = (item) =>
  item.source === 'minor' ? indent(`${item.subject} ${item.id} (minor, ${item.category}) ${where(item)}: ${item.title}\n${item.body}`) : `${item.subject} out of scope ${where(item)}: ${item.title}`

// ---------------------------------------------------------------- the reuse sweep

function changedBetween(git, from, to, file) {
  if (!from || !to || !file) return false
  try {
    return git('diff', '--name-only', from, to, '--', file) !== ''
  } catch {
    return false
  }
}

// The first sweep of the current apply round: the accepted `sweep p1` and `sweep p2`, read as
// one run, p1's findings first and then each p2 finding no p1 finding matches (lib/dup.mjs
// sameDuplicate). { run } once both are accepted on one HEAD; { missing } while a pass has no
// accepted reply; { error } when the two ran on different HEADs. A change whose log holds the
// single `sweep` of before the two passes reads that one as its first sweep.
function firstPass(root, events) {
  const last = (name) => events.findLast((e) => e.name === name)
  const [p1, p2] = [last('sweep p1'), last('sweep p2')]
  if (!p1 && !p2) {
    const single = last('sweep')
    return single ? { run: { findings: relativeFindings(root, single.result.findings), head: single.result.head ?? null } } : {}
  }
  if (!p1 || !p2) return { missing: [p1 ? 'sweep p2' : 'sweep p1'] }
  if (p1.result.head !== p2.result.head) {
    return { error: `sweep p1 ran on ${p1.result.head} and sweep p2 on ${p2.result.head}: the two passes read one HEAD; dispatch the pass that ran on the older one again` }
  }
  const one = relativeFindings(root, p1.result.findings)
  const two = relativeFindings(root, p2.result.findings).filter((f) => !one.some((g) => sameDuplicate(f, g)))
  return { run: { findings: [...one, ...two], head: p1.result.head ?? null } }
}

// The S<n> a consolidation's re-review of round k found not consolidated: its last accepted result.
const notConsolidatedOf = (events, round) => events.findLast((e) => e.name === `re-review sweep r${round}`)?.result.notConsolidated ?? []

export const renderSweepFinding = (f) => `${f.id} ${f.introduced} repeats ${f.existing}: ${f.why}`

export function sweepState(root, change, { git = gitIn(root) } = {}) {
  const records = readRecords(root, change)
  const since = roundStart(records)
  const events = parseEvents(readLog(attemptsFile(root, change))).filter((e) => e.event === 'valid' && e.result).filter(atOrAfter(since))
  const sweeps = events.filter((e) => parseName(e.name)?.role === 'sweep')
  const first = firstPass(root, sweeps)
  if (!first.run) return { ran: false, ids: [], open: [], cleared: [], ...(first.missing ? { missing: first.missing } : {}), ...(first.error ? { error: first.error } : {}) }
  // The first sweep, then every re-sweep (`sweep r<k>`) of the current apply round, in log order.
  const runs = [
    first.run,
    ...sweeps
      .filter((e) => parseName(e.name).round !== undefined)
      .map((e) => ({ round: parseName(e.name).round, findings: relativeFindings(root, e.result.findings), head: e.result.head ?? null }))
  ]
  // Each S<n> with every location it was reported at; its open entry keeps the first report's text.
  const known = new Map()
  const open = new Map()
  const cleared = []
  for (const run of runs) {
    const kept = new Set(run.round === undefined ? [] : notConsolidatedOf(events, run.round))
    for (const [id, f] of open) {
      if (run.findings.some((g) => known.get(id).seen.some((s) => sameDuplicate(s, g)))) continue
      // The consolidation's re-review found it not consolidated: the re-sweep's silence clears nothing.
      if (kept.has(id)) continue
      if (changedBetween(git, f.head, run.head, locate(f.introduced)?.file)) {
        open.delete(id)
        const debt = dismissalOf(root, records, f)
        cleared.push(debt ? { id, by: 'dismissed', debt: debt.id } : { id, by: 'consolidated' })
      }
    }
    for (const f of run.findings) {
      let entry = [...known.values()].find((k) => k.seen.some((s) => sameDuplicate(s, f)))
      if (!entry) {
        entry = { id: `S${known.size + 1}`, first: f, seen: [] }
        known.set(entry.id, entry)
      }
      entry.seen.push(f)
      open.set(entry.id, { id: entry.id, introduced: entry.first.introduced, existing: entry.first.existing, why: entry.first.why, head: run.head })
    }
  }
  const rulings = subjectRulings(records, SWEEP_SUBJECT, since)
  const markers = findMarkers(root)
  const still = []
  for (const f of open.values()) {
    // A marker may sit at any location the finding was reported at.
    const marker = known.get(f.id).seen.map((s) => coveringMarker(markers, s)).find(Boolean)
    if (marker) cleared.push({ id: f.id, by: 'marker', marker: `${marker.file}:${marker.line}` })
    else if (CLOSING.includes(rulings.get(f.id)?.as)) cleared.push({ id: f.id, by: 'ruling', ruling: rulings.get(f.id).id })
    else if (dismissalOf(root, records, f)) cleared.push({ id: f.id, by: 'dismissed', debt: dismissalOf(root, records, f).id })
    else still.push(f)
  }
  return { ran: true, ids: [...known.keys()], open: still, cleared }
}

// ---------------------------------------------------------------- the consolidation

// What a consolidation round works on: the sweep's open findings (S<n>) and the open findings of
// its own review loop (F<n>, from the accepted `re-review sweep r<k>` results). The re-sweep, not
// the re-review, clears a sweep finding, so a re-review's not-addressed S<n> never enters the
// loop's open set. { subject, sweep, loop, open, rendered, files }: `files` the introduced and
// existing files of the open sweep findings and the files of the open loop findings, the fix's
// scope, each relative to the repository root.
export function consolidationState(root, change, options = {}) {
  const sweep = sweepState(root, change, options)
  const records = readRecords(root, change)
  const since = roundStart(records)
  const rulings = subjectRulings(records, SWEEP_SUBJECT, since)
  const loop = loopState(subjectHistory(readLog(attemptsFile(root, change)), SWEEP_SUBJECT, since), rulings)
  const byId = new Map(loop.findings.map((f) => [f.id, f]))
  const rendered = [
    ...sweep.open.map(renderSweepFinding),
    ...loop.open.map((id) => renderFinding(byId.get(id), rulings.get(id)))
  ]
  const files = unique([
    ...sweep.open.flatMap((f) => [locate(f.introduced)?.file, locate(f.existing)?.file]),
    ...loop.open.map((id) => byId.get(id)?.file)
  ].filter(Boolean).map((f) => (relativeLocation(root, f) ?? f).replace(/^\.\//, '')))
  return { subject: SWEEP_SUBJECT, sweep, loop, open: [...sweep.open.map((f) => f.id), ...loop.open], rendered, files }
}
