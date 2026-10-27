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
// A finding stays open across sweep runs until one of: a DUP marker in the tree now accepts it
// (`dup.mjs mark`, the developer's dismissal); a ruling accepts or dismisses it; or a later sweep
// no longer reports it and its introduced file changed between the sweep that last reported it
// and that later one (a consolidation), unless an accepted `debt` record of `dup.mjs mark` names
// the pair (lib/dup.mjs dismissalOf): its marker commit changed the file, and the finding was
// dismissed. That record also clears a finding no later sweep has run on, where no marker fits. A later CLEAN with the file unchanged clears nothing: a second CLEAN on an
// unchanged branch would launder the first finding. Locations are read relative to the
// repository root (lib/dup.mjs relativeFindings), whatever a recorded reply wrote.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { attemptsFile, parseEvents, readLog } from './attempts.mjs'
import { parseName, sddDir, SWEEP_SUBJECT } from './dispatch.mjs'
import { coveringMarker, dismissalOf, findMarkers, locate, relativeFindings, relativeLocation } from './dup.mjs'
import { readRecords } from './ledger.mjs'
import { gitIn } from './workspace.mjs'

export const REVIEW_ROLES = ['review', 'final-review', 'merge-review']
export const LOOP_ROLES = [...REVIEW_ROLES, 're-review']
export { SWEEP_SUBJECT }
export const CLOSING = ['accepted', 'dismissed']

const unique = (list) => [...new Set(list)]

// The subject a review loop belongs to: T<n>, a group letter, `sweep` for a consolidation's fix
// and re-review, or `final`.
export const subjectOf = (parts) =>
  parts.subject !== undefined ? parts.subject : parts.task !== undefined ? `T${parts.task}` : parts.group !== undefined ? parts.group : 'final'

// The computed results of the subject's accepted reviews and re-reviews, in log order.
export function subjectHistory(eventsText, subject) {
  return parseEvents(eventsText)
    .filter((e) => e.event === 'valid' && e.result)
    .filter((e) => {
      const parts = parseName(e.name)
      return parts && LOOP_ROLES.includes(parts.role) && subjectOf(parts) === subject
    })
    .map((e) => e.result)
}

// The last ruling of each id of one subject: Map id -> ledger record.
export function subjectRulings(records, subject) {
  return new Map(records.filter((r) => r.kind === 'ruling' && r.subject === subject && typeof r.as === 'string').map((r) => [r.finding, r]))
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
  const rulings = subjectRulings(readRecords(root, change), subject)
  return { subject, ...loopState(subjectHistory(readLog(attemptsFile(root, change)), subject), rulings), rulings }
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
// item of a re-review, in log order, with its subject and the dispatch that reported it.
export function deferredItems(eventsText) {
  const items = []
  for (const e of parseEvents(eventsText)) {
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
  const items = deferredItems(readLog(attemptsFile(root, change)))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`)
  return { file, items }
}

export const renderDeferred = (item) =>
  item.source === 'minor' ? indent(`${item.subject} ${item.id} (minor, ${item.category}) ${where(item)}: ${item.title}\n${item.body}`) : `${item.subject} out of scope ${where(item)}: ${item.title}`

// ---------------------------------------------------------------- the reuse sweep

const sweepKey = (f) => `${String(f.introduced).trim()}\u0000${String(f.existing).trim()}`

function changedBetween(git, from, to, file) {
  if (!from || !to || !file) return false
  try {
    return git('diff', '--name-only', from, to, '--', file) !== ''
  } catch {
    return false
  }
}

export function sweepState(root, change, { git = gitIn(root) } = {}) {
  // The first sweep and every re-sweep (`sweep r<k>`), in log order.
  const runs = parseEvents(readLog(attemptsFile(root, change))).filter((e) => e.event === 'valid' && parseName(e.name)?.role === 'sweep' && e.result)
  if (runs.length === 0) return { ran: false, ids: [], open: [], cleared: [] }
  const records = readRecords(root, change)
  const ids = new Map()
  const open = new Map()
  const cleared = []
  for (const { result } of runs) {
    const findings = relativeFindings(root, result.findings)
    const reported = new Set(findings.map(sweepKey))
    for (const [key, f] of open) {
      if (reported.has(key)) continue
      if (changedBetween(git, f.head, result.head, locate(f.introduced)?.file)) {
        open.delete(key)
        const debt = dismissalOf(root, records, f)
        cleared.push(debt ? { id: f.id, by: 'dismissed', debt: debt.id } : { id: f.id, by: 'consolidated' })
      }
    }
    for (const f of findings) {
      const key = sweepKey(f)
      if (!ids.has(key)) ids.set(key, `S${ids.size + 1}`)
      open.set(key, { id: ids.get(key), introduced: f.introduced, existing: f.existing, why: f.why, head: result.head ?? null })
    }
  }
  const rulings = subjectRulings(records, SWEEP_SUBJECT)
  const markers = findMarkers(root)
  const still = []
  for (const f of open.values()) {
    const marker = coveringMarker(markers, f)
    if (marker) cleared.push({ id: f.id, by: 'marker', marker: `${marker.file}:${marker.line}` })
    else if (CLOSING.includes(rulings.get(f.id)?.as)) cleared.push({ id: f.id, by: 'ruling', ruling: rulings.get(f.id).id })
    else if (dismissalOf(root, records, f)) cleared.push({ id: f.id, by: 'dismissed', debt: dismissalOf(root, records, f).id })
    else still.push(f)
  }
  return { ran: true, ids: [...ids.values()], open: still, cleared }
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
  const rulings = subjectRulings(readRecords(root, change), SWEEP_SUBJECT)
  const loop = loopState(subjectHistory(readLog(attemptsFile(root, change)), SWEEP_SUBJECT), rulings)
  const byId = new Map(loop.findings.map((f) => [f.id, f]))
  const rendered = [
    ...sweep.open.map((f) => `${f.id} ${f.introduced} repeats ${f.existing}: ${f.why}`),
    ...loop.open.map((id) => renderFinding(byId.get(id), rulings.get(id)))
  ]
  const files = unique([
    ...sweep.open.flatMap((f) => [locate(f.introduced)?.file, locate(f.existing)?.file]),
    ...loop.open.map((id) => byId.get(id)?.file)
  ].filter(Boolean).map((f) => (relativeLocation(root, f) ?? f).replace(/^\.\//, '')))
  return { subject: SWEEP_SUBJECT, sweep, loop, open: [...sweep.open.map((f) => f.id), ...loop.open], rendered, files }
}
