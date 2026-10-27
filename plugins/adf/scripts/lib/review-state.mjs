// The review stage of one change, held as state under `.superpowers/sdd/<change>/review/`: what
// `start` measured, each round's base, input and validated findings, the fixers' replies, every
// finding's disposition, the suite run after the fixes; and the record `assemble` renders from
// it. The scripts decide everything that can be decided from that state, git and the ledger; the
// review, each fix, a false-positive argument and the developer's rulings stay with people and
// agents.
//
//   start.json            the range, the filter's counts, the slices and their proof (start)
//   r<k>/round.json       round k opened: the fix range's base from round 2 (round)
//   r<k>/input.json       the range the round's input was built from (input)
//   r<k>/reply[-s<n>].json  a reviewer's valid reply, one per slice (response)
//   r<k>/findings.json    the round's findings, slices merged and ids renumbered (response)
//   r<k>/fixes/F<n>.json  a fixer's valid reply (fix)
//   r<k>/fixplan.json     the round's fixes in sequential order, `next` first (fixplan)
//   dispositions.json     F<n> -> { as: fixed | dismissed | accepted | recorded, ... }
//   suite.json            the suite run after the last fix (suite.mjs run --section review)
//
// The replies' retry count is not review state: every checked reply is an event of the change's
// shared log, `.superpowers/sdd/<change>/attempts.jsonl` (lib/attempts.mjs), keyed by the dispatch
// name, `ai-review r<k>[ s<n>]` or `ai-fix F<n> r<k>`, never by the reply's content. Only the
// events at or after this run's start count, so `start --fresh` begins the count again. The stage
// is stopped while a name of this run has two invalid replies; `dispatch.mjs reply` records into
// the same log, so a stop it records stops the stage too.
//
// Legacy files: `attempts.json`, the counter of review stages started before the shared log, is
// ignored: such a run has at most one invalid reply per key (a second wrote `stopped.json`), so
// the worst case is one more retry than the old counter allowed. A legacy `stopped.json` is still
// read and keeps its run stopped until `start --fresh`; nothing writes it any more.
//
// Finding ids run on across rounds and slices (F1.. in round 1, then on in round 2), so `F<n>`
// names one finding of the run; a ledger ruling on a finding counts only when it was written
// after this run's start, so a ruling of an earlier run never decides a finding of this one.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { attemptsFile, parseEvents, readLog, recordReply, standing } from './attempts.mjs'
import { commitPaths } from './commit.mjs'
import { MAX_ATTEMPTS, parseName } from './dispatch.mjs'
import { readRecords } from './ledger.mjs'
import { commentFor, coveringIgnore, parseMarker } from './marker.mjs'
import { cell, checkFindings, checkFix, CLOSED, computeVerdict, filterPaths, reviewConfig, SEVERITIES, where } from './review.mjs'
import { isTestFile } from './tdd-proof.mjs'

export const ROUND_CAP = 3
export const REVIEWER_LEVEL = 'architecture'
export const fixLevel = (round) => (round >= 2 ? 'architecture' : 'integration')
export const fixName = (id, round) => `ai-fix ${id} r${round}`
export const RULINGS = { range: 'review-range', slices: 'review-slices', suite: 'review-suite', round: (k) => `review-round-${k}` }
export const recordPath = (change) => `openspec/changes/${change}/review.md`
export const recordMessage = (change) => `docs(openspec): review ${change}`
// A fix commit touches the finding's file, its tests, or both. A test of a file is a test file
// (lib/tdd-proof.mjs's recognition) whose name, without its extension and its test marker, is
// the file's name without its extension: `__tests__/a.spec.ts`, `a.test.ts` or `test_a.py` for `a.ts`.
const bareName = (path) => path.split('/').pop().replace(/\.[^.]*$/, '')
export const isTestOf = (test, file) => test !== file && isTestFile(test) && bareName(test).replace(/[._-](?:test|spec)$/, '').replace(/^test_/, '') === bareName(file)

export class Refusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}
const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

export const reviewDir = (root, change) => join(root, '.superpowers', 'sdd', change, 'review')
export const inputFile = (root, change, round, slice = null) => join(reviewDir(root, change), `input-r${round}${slice === null ? '' : `-s${slice}`}.md`)
const roundDir = (root, change, k) => join(reviewDir(root, change), `r${k}`)
const replyName = (slice) => `reply${slice === null ? '' : `-s${slice}`}.json`

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)
function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const gitAt = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trimEnd()
function tryGit(git, ...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const isAncestor = (git, a, b) => tryGit(git, 'merge-base', '--is-ancestor', a, b) !== null

// The fixed findings whose commit no round has reviewed yet: not in the last stored round's
// reviewed head.
function unreviewedFixes(git, state) {
  const last = state.rounds.filter((r) => r.findings).at(-1)
  return Object.entries(state.dispositions)
    .filter(([, d]) => d.as === 'fixed' && !(last && isAncestor(git, d.sha, last.findings.head)))
    .map(([id]) => id)
}

// ---------------------------------------------------------------- state

export function loadState(root, change) {
  const dir = reviewDir(root, change)
  const start = readJson(join(dir, 'start.json'))
  const rounds = []
  for (let k = 1; existsSync(join(dir, `r${k}`, 'round.json')); k++) {
    const rd = join(dir, `r${k}`)
    rounds.push({ round: k, meta: readJson(join(rd, 'round.json')), input: readJson(join(rd, 'input.json')), findings: readJson(join(rd, 'findings.json')) })
  }
  return {
    dir,
    start,
    rounds,
    dispositions: readJson(join(dir, 'dispositions.json'), {}),
    stopped: readJson(join(dir, 'stopped.json')) ?? stoppedBy(root, change, start),
    suite: readJson(join(dir, 'suite.json'))
  }
}

const REVIEW_ROLES = ['ai-review', 'ai-fix']

// The first name of this run, a reviewer's or a fixer's, whose second invalid reply stopped the
// stage, read from the shared events log; null while none has.
function stoppedBy(root, change, start) {
  if (!start) return null
  const text = readLog(attemptsFile(root, change))
  const names = [...new Set(parseEvents(text).filter((e) => REVIEW_ROLES.includes(parseName(e.name)?.role)).map((e) => e.name))]
  for (const name of names) {
    if (standing(text, name, { since: start.at }).invalid < MAX_ATTEMPTS) continue
    const last = parseEvents(text).filter((e) => e.name === name && e.event === 'invalid' && String(e.at) >= start.at).at(-1)
    return { at: last.at, key: name, reason: `a second invalid reply from ${name}`, errors: last.errors ?? [] }
  }
  return null
}

export function liveState(root, change) {
  const state = loadState(root, change)
  if (!state.start) refuse(`no review of ${change} is started: run review.mjs start --change ${change}`)
  if (state.stopped) refuse(`the review stage of ${change} stopped: ${state.stopped.reason}; nothing is recorded, fixed or reviewed again until review.mjs start --change ${change} --fresh`, { stopped: true, next: 'stop' })
  return state
}

// Every stored finding, each with its round.
export const allFindings = (state) => state.rounds.flatMap((r) => (r.findings ? r.findings.findings.map((f) => ({ ...f, round: r.round })) : []))
const dispositionAs = (state) => Object.fromEntries(Object.entries(state.dispositions).map(([id, d]) => [id, d.as]))
function findingOf(state, id) {
  const f = allFindings(state).find((x) => x.id === id)
  if (!f) refuse(`${id} is not a stored finding of this review`)
  return f
}
const fixReply = (root, change, f) => readJson(join(roundDir(root, change, f.round), 'fixes', `${f.id}.json`))

// The rulings of this run: written at or after its start.
function rulings(root, change, state) {
  return readRecords(root, change).filter((r) => r.kind === 'ruling' && (!state.start || r.at >= state.start.at))
}
const lastCheckRuling = (records, check) => records.filter((r) => r.check === check).at(-1) ?? null
// A ruling naming a subject is an apply loop's (lib/loop.mjs), never the review stage's.
const lastFindingRuling = (records, id) => records.filter((r) => r.finding === id && typeof r.as === 'string' && r.subject === undefined).at(-1) ?? null
const rulingCommand = (change, id, text = '--reason "<the developer\'s reason, in their words>"') => `ledger.mjs ruling --change ${change} --check ${id} ${text}`

// Records a checked reply of `name` in the shared events log (lib/attempts.mjs). A valid one
// returns null. One invalid reply is retried: the same agent is resumed with the errors, or, when
// the harness cannot resume it (`resume: false`), dispatched afresh with the errors as its
// question; the second stops the stage, with no record and no dispatch.
function recordChecked(root, change, state, { name, file, errors, resume = true, result }) {
  const out = recordReply(root, change, { name, file, errors, resume, result, since: state.start.at })
  if (out.valid) return null
  const common = { ok: false, valid: false, name, errors, next: out.next, mode: out.mode, invalid: out.invalid, log: out.log }
  if (out.next === 'retry') {
    const how = out.mode === 'resume' ? `resume ${name} with the errors` : `dispatch ${name} afresh with the errors as its question (dispatch.mjs prompt --question-file)`
    return { ...common, retry: true, error: `the reply is invalid: ${how}; one retry is all there is` }
  }
  return { ...common, stopped: true, error: `a second invalid reply from ${name} stops the stage: no record, no fix dispatch, no second reviewer` }
}

// ---------------------------------------------------------------- start and rounds

// Records what `start --change` measured. A run with rounds is kept unless `fresh`, which clears
// the whole review state. An explicit range needs the developer's `review-range` ruling.
export function recordStart(root, change, measured, { fresh = false, now = new Date().toISOString() } = {}) {
  const state = loadState(root, change)
  if (!fresh && (state.rounds.length > 0 || state.stopped)) {
    refuse(`a review run of ${change} is under way (${state.stopped ? 'stopped' : `round${state.rounds.length > 1 ? 's' : ''} 1-${state.rounds.length}`}); pass --fresh to discard it and start again`)
  }
  let rangeRuling = null
  if (measured.range.from === 'range') {
    rangeRuling = lastCheckRuling(readRecords(root, change).filter((r) => r.kind === 'ruling'), RULINGS.range)
    if (!rangeRuling) refuse(`an explicit range for ${change} needs the developer's ruling: ${rulingCommand(change, RULINGS.range)}`, { rulingCommand: rulingCommand(change, RULINGS.range) })
  }
  if (fresh) rmSync(state.dir, { recursive: true, force: true })
  const start = {
    at: now,
    change,
    range: measured.range,
    rangeRuling: rangeRuling ? { id: rangeRuling.id, reason: rangeRuling.reason } : null,
    counts: measured.counts,
    bytes: measured.bytes,
    maxBytes: measured.maxBytes,
    empty: measured.empty,
    slices: measured.slices,
    proof: measured.proof,
    warnings: measured.warnings
  }
  writeJson(join(state.dir, 'start.json'), start)
  return { file: join(state.dir, 'start.json'), rangeRuling: start.rangeRuling }
}

// Opens the next round and returns its number. Round 1 needs a start with a diff; round k + 1
// needs round k's findings stored and a fix landed in round k. Past ROUND_CAP each round needs
// the developer's `review-round-<k>` ruling, which the round records. A round opened and not
// yet answered is returned as it is.
export function openRound(root, change, { now = new Date().toISOString() } = {}) {
  const state = liveState(root, change)
  const git = gitAt(root)
  const head = git('rev-parse', 'HEAD')
  if (state.start.empty) refuse(`the filtered diff of ${change} is empty: nothing to review; record it with assemble --change ${change} --not-reviewed "<reason>"`)
  const last = state.rounds.at(-1)
  if (last && !last.findings) return { ok: true, round: last.round, already: true, since: last.meta.since, ruling: last.meta.ruling, cap: ROUND_CAP }
  let k = 1
  let since = null
  if (last) {
    k = last.round + 1
    if (unreviewedFixes(git, state).length === 0) {
      const { blocking } = computeVerdict(allFindings(state), { blockOn: reviewConfig(root).blockOn, dispositions: dispositionAs(state) })
      refuse(
        blocking.length > 0
          ? `no fix landed in round ${last.round}, so there is nothing to re-review; the open blocking findings (${blocking.join(', ')}) wait for a fix or the developer's ruling`
          : `round ${last.round} left nothing to re-review: assemble the record`
      )
    }
    since = last.findings.fixBase
  } else if (state.start.range.from !== 'range' && head !== state.start.range.head) {
    refuse(`HEAD is ${head.slice(0, 7)}, not ${state.start.range.head.slice(0, 7)} measured by start: run review.mjs start --change ${change} again`)
  }
  let ruling = null
  if (k > ROUND_CAP) {
    const r = lastCheckRuling(rulings(root, change, state), RULINGS.round(k))
    if (!r) {
      refuse(`round ${k} is past the cap of ${ROUND_CAP}: escalate to the developer; the record is BLOCKED unless they allow round ${k}: ${rulingCommand(change, RULINGS.round(k))}`, {
        escalate: true,
        rulingCommand: rulingCommand(change, RULINGS.round(k))
      })
    }
    ruling = { id: r.id, reason: r.reason }
  }
  writeJson(join(roundDir(root, change, k), 'round.json'), { round: k, at: now, since, ruling })
  return { ok: true, round: k, already: false, since, ruling, cap: ROUND_CAP }
}

// The range a round reads: round 1 the start's, round k the fix range from the commit round
// k - 1's fixes were made on to HEAD.
export function roundRange(root, change, state, k) {
  const git = gitAt(root)
  const head = git('rev-parse', 'HEAD')
  if (k === 1) {
    const r = state.start.range
    if (r.from !== 'range' && head !== r.head) refuse(`HEAD is ${head.slice(0, 7)}, not ${r.head.slice(0, 7)} measured by start: run review.mjs start --change ${change} again`)
    return { base: r.base, head: r.head, spec: r.spec, from: r.from }
  }
  const since = state.rounds[k - 1].meta.since
  return { base: since, head, spec: `${since}..${head}`, from: 'fix-range', since }
}

// What the input of round k adds from round 2: the previous round's blocking findings and any
// other the fixers answered, each with its state and failure mode.
export function previousFindings(root, change, state, k) {
  if (k < 2) return []
  const prev = state.rounds[k - 2]
  const { blockOn } = reviewConfig(root)
  const out = []
  for (const f of prev.findings.findings) {
    const fix = fixReply(root, change, { ...f, round: prev.round })
    if (!blockOn.includes(f.severity) && !fix) continue
    const d = state.dispositions[f.id]
    const status = d ? describe(d) : fix?.outcome === 'false-positive' ? 'open: the fixer claims a false positive, which waits for the developer' : 'open'
    out.push({ ...f, state: status, failureMode: fix?.failureMode ?? null })
  }
  return out
}

// Checks round k is open and unanswered, and that the range matches its first input.
export function checkRoundInput(root, change, state, k, range, slices) {
  const r = state.rounds[k - 1]
  if (!r) refuse(`round ${k} is not open: run review.mjs round --change ${change}`)
  if (r.findings) refuse(`round ${k}'s findings are stored; open the next round with review.mjs round --change ${change}`)
  if (r.input && r.input.head !== range.head) refuse(`HEAD moved since round ${k}'s first input (${r.input.head.slice(0, 7)}): start the review again with --fresh`)
  writeJson(join(roundDir(root, change, k), 'input.json'), { round: k, base: range.base, head: range.head, spec: range.spec, slices })
}

export const slicesApproved = (root, change, state) => lastCheckRuling(rulings(root, change, state), RULINGS.slices)

// ---------------------------------------------------------------- the reviewer's reply

// Stores a valid reply as round k's reply (of slice `slice`); once every slice is in, merges them
// into the round's findings, numbering on from the earlier rounds: slice by slice, each in the
// reviewer's order.
export function storeReply(root, change, { round: k, slice = null, text, file = null, resume = true }) {
  const state = liveState(root, change)
  const r = state.rounds[k - 1]
  if (!r?.input) refuse(`round ${k} has no input: run review.mjs input --round ${k} --change ${change}`)
  if (r.findings) refuse(`round ${k}'s findings are already stored`)
  const sliced = r.input.slices !== null
  if (sliced && slice === null) refuse(`round ${k} goes by ${r.input.slices} slices: pass --slice <n>`)
  if (!sliced && slice !== null) refuse(`round ${k} has no slices`)
  if (sliced && (slice < 1 || slice > r.input.slices)) refuse(`--slice ${slice} is not a slice: 1-${r.input.slices}`)
  const rd = roundDir(root, change, k)
  if (existsSync(join(rd, replyName(slice)))) refuse(`the reply of round ${k}${slice === null ? '' : ` slice ${slice}`} is already stored`)
  const checked = checkFindings(text)
  const name = `ai-review r${k}${slice === null ? '' : ` s${slice}`}`
  const refused = recordChecked(root, change, state, { name, file, errors: checked.valid ? [] : checked.errors, resume })
  if (refused) return { ...refused, fenced: checked.fenced }
  writeJson(join(rd, replyName(slice)), checked.reply)
  const parts = sliced ? Array.from({ length: r.input.slices }, (_, i) => i + 1) : [null]
  const missing = parts.filter((s) => !existsSync(join(rd, replyName(s))))
  if (missing.length > 0) return { ok: true, valid: true, fenced: checked.fenced, round: k, slice, complete: false, missing }
  let n = allFindings(state).length
  const findings = []
  const renumbered = {}
  const summaries = []
  for (const s of parts) {
    const reply = readJson(join(rd, replyName(s)))
    summaries.push(s === null ? reply.summary : `Slice ${s}: ${reply.summary}`)
    for (const f of reply.findings) {
      const id = `F${++n}`
      renumbered[id] = { slice: s, id: f.id }
      findings.push({ ...f, id })
    }
  }
  const fixBase = gitAt(root)('rev-parse', 'HEAD')
  const stored = { round: k, base: r.input.base, head: r.input.head, fixBase, summary: summaries.join('\n\n'), findings, renumbered }
  writeJson(join(rd, 'findings.json'), stored)
  const after = loadState(root, change)
  const verdict = computeVerdict(allFindings(after), { blockOn: reviewConfig(root).blockOn, dispositions: dispositionAs(after) })
  return { ok: true, valid: true, fenced: checked.fenced, round: k, slice, complete: true, findingsFile: join(rd, 'findings.json'), ids: findings.map((f) => f.id), renumbered, ...verdict }
}

// ---------------------------------------------------------------- fixes

// The open blocking findings of round k (and `also`, open findings the orchestrator chose to fix,
// kept from the round's earlier plan) in sequential order, the findings of one file adjacent:
// every fixer works in the one change worktree, so one fixer runs at a time, the rule apply
// follows inside one worktree. `next` is the fix to dispatch now; the plan is computed again after
// each stored reply. A false-positive claim waits for the developer, apart; once they reject it
// (`ruling --as fix`, written after the claim), the finding is listed again as a fix carrying the
// rejected argument and their decision, which the fixer's prompt shows.
export function fixPlan(root, change, { round: k, also = [] }) {
  const state = liveState(root, change)
  const r = state.rounds[k - 1]
  if (!r?.findings) refuse(`round ${k}'s findings are not stored`)
  const { blockOn } = reviewConfig(root)
  const own = new Map(r.findings.findings.map((f) => [f.id, f]))
  for (const id of also) if (!own.has(id)) refuse(`${id} is not a finding of round ${k}`)
  const file = join(roundDir(root, change, k), 'fixplan.json')
  const chosen = [...new Set([...(readJson(file)?.also ?? []), ...also])]
  const records = rulings(root, change, state)
  const open = (f) => !CLOSED.includes(state.dispositions[f.id]?.as)
  const claimed = []
  const byFile = new Map()
  for (const f of r.findings.findings) {
    if (!open(f) || !(blockOn.includes(f.severity) || chosen.includes(f.id))) continue
    const fix = fixReply(root, change, { ...f, round: k })
    let rejected = null
    if (fix?.outcome === 'false-positive') {
      const ruling = lastFindingRuling(records, f.id)
      if (ruling?.as !== 'fix' || ruling.at < fix.at) {
        claimed.push({ finding: f.id, argument: fix.argument })
        continue
      }
      rejected = { argument: fix.argument, decision: ruling.decision, ruling: ruling.id }
    }
    const entry = { finding: f.id, severity: f.severity, file: f.file, line: f.line, title: f.title, name: fixName(f.id, k), level: fixLevel(k), ...(rejected ? { rejected } : {}) }
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), entry])
  }
  const fixes = [...byFile.values()].flat()
  const plan = { round: k, level: fixLevel(k), also: chosen, next: fixes[0] ?? null, fixes, awaitingDeveloper: claimed }
  writeJson(file, plan)
  return { ok: true, ...plan }
}

// What the fixer of `id` in round k is given: the round's findings file and the finding, and the
// rejected false-positive argument with the developer's decision when the plan carries them.
// Refused unless `id` is the plan's `next`: one fixer at a time, in the plan's order.
export function fixTarget(root, change, { round: k, finding: id }) {
  const rd = roundDir(root, change, k)
  const findingsFile = join(rd, 'findings.json')
  const stored = readJson(findingsFile)
  if (!stored) refuse(`round ${k}'s findings are not stored: run review.mjs response --change ${change} --round ${k}`)
  const finding = stored.findings.find((f) => f.id === id)
  if (!finding) refuse(`${id} is not a finding of round ${k}`)
  const plan = readJson(join(rd, 'fixplan.json'))
  const again = `review.mjs fixplan --change ${change} --round ${k}`
  if (!plan) refuse(`round ${k} has no fix plan: run ${again}`)
  if (plan.next?.finding !== id) refuse(`${id} is not the next fix of round ${k} (${plan.next ? plan.next.finding : 'none'}): run ${again} after each stored reply`)
  return { findingsFile, finding, rejected: plan.next.rejected ?? null }
}

// A fixer's reply to the fix of `finding` (the dispatch `ai-fix F<n> r<k>`, named by the command,
// never by the reply): a reply naming another finding is invalid. `fixed` with a commit in round
// k's fix range that touches the finding's file, its tests or both closes the finding; a commit
// that fails the check makes the reply invalid, so it uses the finding's one retry like any other
// invalid reply. `false-positive` leaves it open with its argument, for the developer. Every
// refusal carries `next`: `retry` (dispatch the fixer again) or `stop` (no fixer is dispatched
// for this finding; `stopped` when the stage stopped).
export function recordFix(root, change, options) {
  try {
    return fixReplyChecked(root, change, options)
  } catch (error) {
    if (error instanceof Refusal && error.extra?.next === undefined) error.extra = { ...error.extra, retry: false, next: 'stop' }
    throw error
  }
}

// What is wrong with `sha` as the fix of `f` in round `r`: { errors, sha, files }.
function fixCommitErrors(root, state, r, f, sha0) {
  const git = gitAt(root)
  const no = (message) => ({ errors: [`$.sha: ${message}`] })
  const sha = tryGit(git, 'rev-parse', '--verify', '--quiet', `${sha0}^{commit}`)
  if (!sha) return no(`${sha0} is not a commit`)
  const head = git('rev-parse', 'HEAD')
  if (sha === r.findings.fixBase || !isAncestor(git, r.findings.fixBase, sha) || !isAncestor(git, sha, head)) {
    return no(`${sha.slice(0, 7)} is not in round ${r.round}'s fix range ${r.findings.fixBase.slice(0, 7)}..${head.slice(0, 7)}`)
  }
  if (git('rev-list', '--parents', '-n', '1', sha).split(' ').length > 2) return no(`${sha.slice(0, 7)} is a merge commit; a fix is one commit of its own`)
  const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', sha).split('\0').filter(Boolean)
  if (files.length === 0) return no(`${sha.slice(0, 7)} touches no file; a fix commit touches ${f.file}, the file ${f.id} names, or its tests`)
  const others = files.filter((x) => x !== f.file && !isTestOf(x, f.file))
  if (others.length > 0) return no(`${sha.slice(0, 7)} touches ${others.join(', ')}, which is neither ${f.file} nor a test of it; a fix commit touches its finding's file and its tests only`)
  const reused = Object.entries(state.dispositions).find(([, x]) => x.as === 'fixed' && x.sha === sha)
  if (reused) return no(`${sha.slice(0, 7)} is already the fix of ${reused[0]}; each fix is its own commit`)
  return { errors: [], sha, files }
}

function fixReplyChecked(root, change, { round: k, finding: id, text, file = null, resume = true, now = new Date().toISOString() }) {
  const state = liveState(root, change)
  const r = state.rounds[k - 1]
  if (!r?.findings) refuse(`round ${k}'s findings are not stored`)
  const f = r.findings.findings.find((x) => x.id === id)
  if (!f) refuse(`${id} is not a finding of round ${k}`)
  const d = state.dispositions[f.id]
  if (CLOSED.includes(d?.as)) refuse(`${f.id} is already ${describe(d)}`)
  const checked = checkFix(text)
  let commit = { errors: [] }
  if (checked.valid && checked.reply.finding === id && checked.reply.outcome === 'fixed') commit = fixCommitErrors(root, state, r, f, checked.reply.sha)
  const errors = !checked.valid ? checked.errors : checked.reply.finding === id ? commit.errors : [`$.finding: ${checked.reply.finding} is not ${id}, the finding this dispatch was sent to fix`]
  const refused = recordChecked(root, change, state, { name: fixName(id, k), file, errors, resume })
  if (refused) return { ...refused, fenced: checked.fenced }
  const reply = checked.reply
  const fixFile = join(roundDir(root, change, k), 'fixes', `${f.id}.json`)
  if (reply.outcome === 'false-positive') {
    writeJson(fixFile, { ...reply, at: now })
    return {
      ok: true,
      finding: f.id,
      outcome: reply.outcome,
      awaiting: 'developer',
      next: `put the argument to the developer: a dismissal needs ledger.mjs ruling --change ${change} --finding ${f.id} --as dismissed --decision "<their reason>", then the marker and review.mjs disposition --as dismissed; a rejected claim needs ledger.mjs ruling --change ${change} --finding ${f.id} --as fix --decision "<their reason>", then review.mjs fixplan lists it again`
    }
  }
  const { sha, files } = commit
  writeJson(fixFile, { ...reply, sha, at: now })
  const record = { as: 'fixed', round: k, sha, files, failureMode: reply.failureMode, at: now }
  writeJson(join(state.dir, 'dispositions.json'), { ...state.dispositions, [f.id]: record })
  return { ok: true, finding: f.id, outcome: 'fixed', sha, files, tests: files.filter((x) => x !== f.file) }
}

// ---------------------------------------------------------------- dispositions

// Where line `line` of the old side of a `git diff -U0` stands on the new side; null when a hunk
// changed or removed it.
export function mapLine(diff, line) {
  let shift = 0
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1])
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    if (oldCount === 0) {
      if (oldStart < line) shift += newCount
      else break
      continue
    }
    if (line < oldStart) break
    if (line < oldStart + oldCount) return null
    shift += newCount - oldCount
  }
  return line + shift
}

const showLines = (git, rev, file) => {
  const text = tryGit(git, 'show', `${rev}:${file}`)
  return text === null ? null : text.split(/\r?\n/)
}

// Whether a dismissed finding carries its marker at HEAD: { marker } on a covering ADF IGNORE
// (of the finding's key, when it has one), { absent } when its line is gone from HEAD, or a
// refusal naming the line to mark.
export function markerCheck(root, reviewedHead, f) {
  if (f.line === null || f.line === undefined) return { absent: 'the finding names no line' }
  const git = gitAt(root)
  const old = showLines(git, reviewedHead, f.file)
  if (old === null) return { absent: `${f.file} is not in the reviewed commit` }
  if (f.line > old.length) return { absent: `line ${f.line} is beyond ${f.file} in the reviewed commit` }
  const now = showLines(git, 'HEAD', f.file)
  if (now === null) return { absent: `${f.file} is gone from HEAD` }
  const line = mapLine(git('diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', reviewedHead, 'HEAD', '--', f.file), f.line)
  if (line === null) return { absent: `line ${f.line} of ${f.file} was changed or removed after the review` }
  if (!commentFor(f.file)) refuse(`${f.file} has no comment syntax, so it cannot carry a marker: record the developer's ruling as accepted instead`)
  const marker = coveringIgnore(now, line, f.key ?? null)
  if (marker) return { marker: { file: f.file, line: marker.line, kind: marker.kind, key: marker.key }, line }
  const mark = `review.mjs mark --file ${f.file} --line ${line} --key ${f.key ?? '<KEY>'} --reason "<the developer's reason>" --commit`
  refuse(`no committed ADF IGNORE${f.key ? ` ${f.key}` : ''} marker covers ${f.file}:${line} at HEAD (line ${f.line} when reviewed): ${mark}`, { line, markCommand: mark })
}

function describe(d) {
  if (d.as === 'fixed') return `fixed in \`${d.sha.slice(0, 7)}\``
  if (d.as === 'dismissed') {
    const m = d.marker ? `; marker ADF IGNORE${d.marker.kind === 'start' ? '-START' : ''} ${d.marker.key} at \`${d.marker.file}:${d.marker.line}\`` : `; no marker: ${d.absent}`
    return `dismissed — ${d.reason}${m}`
  }
  if (d.as === 'accepted') return `accepted — ${d.reason}`
  return 'recorded, non-blocking'
}

// The developer's disposition of a finding: `dismissed` with a ruling and the marker (or the line
// gone from HEAD), `accepted` with a ruling, `recorded` for a non-blocking severity with the
// reason it was left. A fixed finding keeps its fix.
export function dispose(root, change, { finding: id, as, body = null, now = new Date().toISOString() }) {
  const state = liveState(root, change)
  const f = findingOf(state, id)
  const before = state.dispositions[id]
  if (before?.as === 'fixed') refuse(`${id} is ${describe(before)}`)
  const { blockOn } = reviewConfig(root)
  let record
  if (as === 'dismissed' || as === 'accepted') {
    if (as === 'dismissed' && body !== null) refuse('a dismissed finding keeps no body: the marker carries it')
    const ruling = lastFindingRuling(rulings(root, change, state), id)
    const command = `ledger.mjs ruling --change ${change} --finding ${id} --as ${as} --decision "<the developer's reason, in their words>"`
    if (!ruling) refuse(`${id} has no developer ruling in this review: ${command}`, { rulingCommand: command })
    if (ruling.as !== as) refuse(`the developer ruled ${id} ${ruling.as} (${ruling.id}), not ${as}`)
    record = { as, round: f.round, ruling: ruling.id, reason: ruling.decision, at: now }
    if (as === 'dismissed') {
      const head = state.rounds[f.round - 1].findings.head
      const found = markerCheck(root, head, f)
      record = found.marker ? { ...record, marker: found.marker } : { ...record, marker: null, absent: found.absent }
    } else if (body !== null) record.body = body
  } else if (as === 'recorded') {
    if (blockOn.includes(f.severity)) refuse(`${id} is ${f.severity}, a blocking severity: it is fixed, dismissed or accepted by the developer's ruling, never recorded`)
    if (body === null || !body.trim()) refuse('a recorded finding needs --body-file: why it was left, for a reader who never saw the review')
    record = { as, round: f.round, body: body.trim(), at: now }
  } else refuse(`--as must be dismissed, accepted or recorded, not "${as}"`)
  writeJson(join(state.dir, 'dispositions.json'), { ...state.dispositions, [id]: record })
  return { ok: true, finding: id, disposition: describe(record), ...record }
}

// ---------------------------------------------------------------- the record

function stamp(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Whether a commit is nothing a round reads: every path it changes is under the change's own
// directory, or every one is excluded by the review's filter (lib/review.mjs filterPaths).
function outsideReview(git, sha, change, config) {
  const paths = git('-c', 'core.quotePath=false', 'show', '--name-only', '-z', '--no-renames', '--format=', sha)
    .split('\0')
    .map((p) => p.replace(/^\n+/, ''))
    .filter(Boolean)
  return paths.length > 0 && (paths.every((p) => p.startsWith(`openspec/changes/${change}/`)) || filterPaths(paths, config).kept.length === 0)
}

// The committed PASS record of `change` that still stands: { file, verdict, commit } when
// review.md at HEAD reads PASS and every commit after its reviewed commit, the record's own
// among them, is nothing a round reads; null otherwise.
export function standingRecord(root, change) {
  const git = gitAt(root)
  const file = recordPath(change)
  const text = tryGit(git, 'show', `HEAD:${file}`)
  if (text === null) return null
  const parsed = checkRecord(text)
  if (!parsed.ok || parsed.verdict !== 'PASS') return null
  const commit = tryGit(git, 'rev-parse', '--verify', '--quiet', `${parsed.commit}^{commit}`)
  return commit && onlyOutsideReview(root, change, commit) ? { file, verdict: 'PASS', commit } : null
}

// Whether HEAD moved from `from` only by commits no round reads (outsideReview); false when
// `from` is not an ancestor of HEAD. Verify reads it too: such a move opens no new session.
export function onlyOutsideReview(root, change, from) {
  const git = gitAt(root)
  if (!isAncestor(git, from, 'HEAD')) return false
  const config = reviewConfig(root)
  return git('rev-list', `${from}..HEAD`).split('\n').filter(Boolean).every((sha) => outsideReview(git, sha, change, config))
}

// The commits after the last round's fix base that no round reviewed and that are neither a
// recorded fix, nor a commit adding ADF IGNORE marker lines only, nor one no round reads
// (outsideReview).
function unreviewedCommits(git, from, fixShas, { change, config }) {
  const shas = git('rev-list', '--reverse', `${from}..HEAD`).split('\n').filter(Boolean)
  return shas.filter((sha) => {
    if (fixShas.has(sha) || outsideReview(git, sha, change, config)) return false
    const diff = git('show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha)
    const changed = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    return !(changed.length > 0 && changed.every((l) => l.startsWith('+') && parseMarker(l.slice(1)) && !parseMarker(l.slice(1)).error))
  })
}

function dirtyOutside(git, file) {
  return git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => p !== file)
}

// Renders `openspec/changes/<change>/review.md` from the state, the ledger and HEAD, and with
// `commit` commits it alone. Refuses what no verdict can be given for; an open blocking finding
// is a BLOCKED record, not a refusal.
export function assemble(rootArg, { change, notReviewed = null, commit = false, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  const state = liveState(root, change)
  const git = gitAt(root)
  const file = recordPath(change)
  const dirty = dirtyOutside(git, file)
  if (dirty.length > 0) refuse(`the tree has changes outside ${file}: ${dirty.join(', ')}; commit each fix or marker first, or let the developer deal with them`)
  const head = git('rev-parse', 'HEAD')
  const config = reviewConfig(root)
  const { blockOn } = config
  const records = rulings(root, change, state)
  const start = state.start
  const lines = ['# AI Code Review Record', '', `**Change**: \`${change}\``, `**Reviewed at**: \`${stamp(now)}\``, `**Reviewed commit**: \`${head}\``]
  const rangeLine = `**Range**: \`${start.range.spec}\` (${start.range.from === 'range' ? `an explicit range, ${start.rangeRuling.id}: ${start.rangeRuling.reason}` : `the change's base \`${start.range.baseRef}\``})`
  const excludedLine = `**Excluded files**: \`${start.counts.excluded}\` of ${start.counts.changed} by the review filter`

  if (notReviewed !== null) {
    if (!notReviewed.trim()) refuse('--not-reviewed needs the reason')
    if (!start.empty) refuse(`the filtered diff of ${change} is not empty (${start.counts.kept} file(s)): it is reviewed`)
    if (state.rounds.length > 0) refuse('rounds ran: the record is assembled from them, not as not reviewed')
    if (start.range.from !== 'range' && head !== start.range.head) refuse(`HEAD is ${head.slice(0, 7)}, not ${start.range.head.slice(0, 7)} measured by start: run review.mjs start --change ${change} --fresh`)
    lines.push('**Verdict**: PASS', '', '**Rounds**: `0`', `**Reviewer**: none dispatched`, rangeLine, excludedLine, '', '**Counts**: CRITICAL `0` | HIGH `0` | MEDIUM `0` | LOW `0`', '', '---', '', '## Findings', '')
    lines.push('| # | Round | Severity | Where | Title | Disposition |', '|---|---|---|---|---|---|', '| — | — | — | — | — | no findings |', '')
    lines.push('## Not reviewed', '', `The filtered diff was empty: no reviewer was dispatched. ${notReviewed.trim()}`, '', `The review filter excluded ${start.counts.excluded} of the ${start.counts.changed} changed file(s).`, '')
    return finish(root, { change, file, lines, verdict: 'PASS', counts: zero(), rounds: 0, outstanding: [], commit })
  }

  if (state.rounds.length === 0) refuse(`no round ran: run review.mjs round --change ${change}`)
  const unanswered = state.rounds.filter((r) => !r.findings).map((r) => r.round)
  if (unanswered.length > 0) refuse(`round ${unanswered.join(', ')} has no stored findings: store the reviewer's reply with review.mjs response --change ${change} --round ${unanswered[0]}`)
  const findings = allFindings(state)
  const dispositions = state.dispositions
  const refusals = []
  for (const f of findings) {
    const d = dispositions[f.id]
    if (blockOn.includes(f.severity)) {
      const ruling = lastFindingRuling(records, f.id)
      if (!d && ruling && ruling.as !== 'fix') refusals.push(`${f.id}: the developer ruled it ${ruling.as} (${ruling.id}); apply it with review.mjs disposition --change ${change} --finding ${f.id} --as ${ruling.as}`)
    } else if (!d) refusals.push(`${f.id} (${f.severity}) has no disposition: fix it, or record it with review.mjs disposition --change ${change} --finding ${f.id} --as recorded --body-file <why it was left>`)
    if (d?.as === 'recorded' && !d.body?.trim()) refusals.push(`${f.id} is recorded with no body`)
  }
  const last = state.rounds.at(-1)
  const fixes = Object.entries(dispositions).filter(([, d]) => d.as === 'fixed')
  const stray = unreviewedCommits(git, last.findings.fixBase, new Set(fixes.map(([, d]) => d.sha)), { change, config })
  if (stray.length > 0) refusals.push(`commit(s) after round ${last.round} that no round reviewed and that are not a recorded fix: ${stray.map((s) => s.slice(0, 7)).join(', ')}; review them in another round or start again`)
  const suite = state.suite
  if (fixes.length > 0 && !suite) refusals.push(`a fix landed and the suite has not run after it: suite.mjs run --change ${change} --section review`)
  else if (fixes.length > 0 && suite.commit !== head) refusals.push(`the suite ran at ${String(suite.commit).slice(0, 7)}, not HEAD ${head.slice(0, 7)}: run it again after the last commit`)
  if (refusals.length > 0) refuse(`the record cannot be assembled: ${refusals.join('; ')}`, { refusals })

  const as = Object.fromEntries(Object.entries(dispositions).map(([id, d]) => [id, d.as]))
  const { blocking, counts } = computeVerdict(findings, { blockOn, dispositions: as })
  const notReReviewed = unreviewedFixes(git, state)
  const suiteRuling = lastCheckRuling(records, RULINGS.suite)
  const suiteBlocks = Boolean(suite && fixes.length > 0 && suite.blocking && !suiteRuling)
  const outstanding = [
    ...blocking.map((id) => `${id}: open ${findings.find((f) => f.id === id).severity} finding${fixReply(root, change, findings.find((f) => f.id === id))?.outcome === 'false-positive' ? ', a false-positive claim waiting for the developer' : ''}`),
    ...notReReviewed.map((id) => `${id}: fixed in \`${dispositions[id].sha.slice(0, 7)}\` and not re-reviewed; open round ${last.round + 1} with review.mjs round`),
    ...(suiteBlocks ? [`the suite after the fixes: ${suite.status}${suite.newFailures.length ? `, new failures: ${suite.newFailures.join('; ')}` : ''}${suite.reason ? `: ${suite.reason}` : ''}`] : [])
  ]
  const verdict = outstanding.length > 0 ? 'BLOCKED' : 'PASS'
  const roundRulings = state.rounds.filter((r) => r.meta.ruling)
  lines.push(`**Verdict**: ${verdict}`, '', `**Rounds**: \`${state.rounds.length}\``)
  if (roundRulings.length > 0) lines.push(`**Round cap**: ${ROUND_CAP}, passed by the developer's ruling: ${roundRulings.map((r) => `round ${r.round} (${r.meta.ruling.id}: ${r.meta.ruling.reason})`).join('; ')}`)
  lines.push(`**Reviewer**: \`ai-review\` at the ${REVIEWER_LEVEL} level; fixes by \`ai-fix\` at the integration level, ${fixLevel(2)} from round 2`, rangeLine, excludedLine)
  lines.push('', `**Counts**: ${SEVERITIES.map((s) => `${s} \`${counts[s]}\``).join(' | ')}`, '', '---', '', '## Findings', '', '| # | Round | Severity | Where | Title | Disposition |', '|---|---|---|---|---|---|')
  if (findings.length === 0) lines.push('| — | — | — | — | — | no findings |')
  for (const f of findings) lines.push(`| ${f.id} | ${f.round} | ${f.severity} | \`${cell(where(f))}\` | ${cell(f.title)} | ${cell(dispositions[f.id] ? describe(dispositions[f.id]) : 'outstanding')} |`)
  lines.push('')
  if (outstanding.length > 0) lines.push('## Outstanding', '', ...outstanding.map((o) => `- ${o}`), '')
  const kept = findings.filter((f) => ['recorded', 'accepted'].includes(dispositions[f.id]?.as))
  if (kept.length > 0) {
    lines.push('## Recorded findings', '')
    for (const f of kept) {
      const d = dispositions[f.id]
      lines.push(`### ${f.id}. \`${where(f)}\` — ${d.as === 'recorded' ? 'recorded, non-blocking' : 'accepted'}`, '', `${f.severity}, ${f.category}: ${f.title}`, '', f.body.trim(), '')
      if (f.suggestion) lines.push(`Suggestion: ${f.suggestion.trim()}`, '')
      lines.push(`Why it was left: ${d.as === 'recorded' ? d.body : d.reason}`, '')
      if (d.as === 'accepted' && d.body) lines.push(d.body.trim(), '')
    }
  }
  const used = [
    ...findings.filter((f) => ['dismissed', 'accepted'].includes(dispositions[f.id]?.as)).map((f) => `- \`${f.id}\` ${dispositions[f.id].as}: ${dispositions[f.id].reason} (${dispositions[f.id].ruling})`),
    ...roundRulings.map((r) => `- \`${RULINGS.round(r.round)}\`: ${r.meta.ruling.reason} (${r.meta.ruling.id})`),
    ...(start.rangeRuling ? [`- \`${RULINGS.range}\`: ${start.rangeRuling.reason} (${start.rangeRuling.id})`] : []),
    ...(state.rounds.some((r) => r.input?.slices) ? records.filter((r) => r.check === RULINGS.slices).slice(-1).map((r) => `- \`${RULINGS.slices}\`: ${r.reason} (${r.id})`) : []),
    ...(suite?.blocking && suiteRuling && fixes.length > 0 ? [`- \`${RULINGS.suite}\`: ${suiteRuling.reason} (${suiteRuling.id})`] : [])
  ]
  if (used.length > 0) lines.push('## Developer rulings', '', ...used, '')
  if (suite && fixes.length > 0) {
    lines.push('## Suite after the fixes', '', `- command: ${suite.command ? `\`${suite.command}\`` : 'none'}; ran at \`${suite.commit ?? head}\``, `- result: ${suite.status}${suite.exit === null || suite.exit === undefined ? '' : `, exit ${suite.exit}`}${suite.reason ? `: ${suite.reason}` : ''}`)
    if (suite.outputFile) lines.push(`- output: \`${suite.outputFile}\``)
    if (suite.base) lines.push(`- base check: \`${suite.base.ref}\` at \`${suite.base.commit}\`, exit ${suite.base.exit}; comparison: ${suite.comparison}`)
    if (suite.preExisting.length) lines.push(`- pre-existing failures: ${suite.preExisting.join('; ')}`)
    if (suite.newFailures.length) lines.push(`- new failures: ${suite.newFailures.join('; ')}`)
    lines.push('')
  }
  const rows = findings.filter((f) => blockOn.includes(f.severity)).map((f) => `${f.id} ${f.severity}: ${dispositions[f.id] ? describe(dispositions[f.id]) : 'outstanding'}`)
  return finish(root, { change, file, lines, verdict, counts, rounds: state.rounds.length, outstanding, commit, rows })
}

const zero = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]))

function finish(root, { change, file, lines, verdict, counts, rounds, outstanding, commit, rows = [] }) {
  writeFileSync(join(root, file), `${lines.join('\n').trimEnd()}\n`)
  const parsed = checkRecord(readFileSync(join(root, file), 'utf8'))
  if (!parsed.ok || parsed.verdict !== verdict) throw new Error(`the rendered record does not read back: ${parsed.errors.join('; ')}`)
  const sha = commit ? commitPaths(root, { only: [file], message: recordMessage(change) }).commit : null
  const report = [
    `## Review ${verdict}`,
    '',
    `**Change:** ${change}`,
    `**Record:** ${file}, ${sha ? `commit ${sha}` : 'not committed yet'}`,
    `**Rounds:** ${rounds}`,
    `**Counts:** ${SEVERITIES.map((s) => `${s} ${counts[s]}`).join(', ')}`,
    '',
    `Blocking findings:${rows.length ? `\n${rows.map((r) => `- ${r}`).join('\n')}` : ' none'}`,
    '',
    verdict === 'PASS' ? 'Next step: /adf:archive.' : `Outstanding, for the developer:\n${outstanding.map((o) => `- ${o}`).join('\n')}`
  ].join('\n')
  return { ok: true, file, verdict, commit: sha, counts, rounds, outstanding, report }
}

// ---------------------------------------------------------------- reading a record

const field = (text, name) => text.split('\n').find((l) => new RegExp(`^\\*\\*${name}[:*]`).test(l)) ?? null
// The disposition cell's whole forms, as the template defines them and `describe` renders them;
// any other cell reads as `other` and is warned about.
const KINDS = [
  [/^fixed in `[0-9a-f]{7,40}`$/, 'fixed'],
  [/^dismissed — .+; (?:marker ADF IGNORE(?:-START)? \S+ at `[^`]+`|no marker: .+)$/, 'dismissed'],
  [/^recorded, non-blocking$/, 'recorded'],
  [/^accepted — .+$/, 'accepted'],
  [/^outstanding$/, 'outstanding']
]

// Reads a review record as archive does: the verdict token compared for equality after the
// field's colon (backticks, asterisks and spaces dropped), the reviewed commit's sha, the rounds,
// the counts as the metrics read them, and the findings table's dispositions. ok is false when the
// verdict or the sha cannot be read; what else is missing or malformed is in `warnings`: rounds
// above the cap with no **Round cap** line, a disposition cell outside the template's forms.
export function checkRecord(text) {
  const errors = []
  const warnings = []
  const verdictLine = field(text, 'Verdict')
  const verdict = verdictLine ? verdictLine.replace(/^[^:]*:\s*/, '').replace(/[`*\s]/g, '').toUpperCase() : null
  if (verdict !== 'PASS' && verdict !== 'BLOCKED') errors.push(verdictLine ? `the verdict reads "${verdict}", not PASS or BLOCKED` : 'no **Verdict** line')
  const shaLine = field(text, 'Reviewed commit')
  const commit = shaLine ? /[0-9a-f]{7,40}/.exec(shaLine.replace(/^[^:]*:/, ''))?.[0] ?? null : null
  if (!commit) errors.push('no reviewed commit sha')
  const changeLine = field(text, 'Change')
  const change = changeLine ? /`([^`]+)`/.exec(changeLine)?.[1] ?? null : null
  const roundsLine = field(text, 'Rounds')
  const roundsMatch = roundsLine ? /\d+/.exec(roundsLine.replace(/^[^:]*:/, '')) : null
  const rounds = roundsMatch ? Number(roundsMatch[0]) : null
  if (rounds === null) warnings.push('no **Rounds** count')
  const countsLine = /\*\*Counts\*\*:(.*)/.exec(text)
  const parts = countsLine ? [...countsLine[1].matchAll(/(CRITICAL|HIGH|MEDIUM|LOW)\s+`?(\d+)`?/g)] : []
  const counts = parts.length === 4 ? Object.fromEntries(parts.map((m) => [m[1], Number(m[2])])) : null
  if (counts === null) warnings.push('no **Counts** line with the four severities')
  const dispositions = []
  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^## Findings\s*$/.test(l))
  if (at < 0) warnings.push('no ## Findings section')
  else {
    const rows = []
    for (const l of lines.slice(at + 1)) {
      if (/^#{1,2} /.test(l)) break
      if (/^\s*\|/.test(l)) rows.push(l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()))
    }
    const header = (rows[0] ?? []).map((c) => c.toLowerCase())
    const col = (...names) => header.findIndex((h) => names.includes(h))
    const [id, severity, location, disposition] = [col('#', 'id'), col('severity'), col('where', 'location'), col('disposition')]
    if (disposition < 0) warnings.push('the findings table has no Disposition column')
    else {
      for (const row of rows.slice(2)) {
        const text = row[disposition] ?? ''
        if (/no findings/i.test(text)) continue
        const kind = KINDS.find(([re]) => re.test(text))?.[1] ?? 'other'
        dispositions.push({ id: row[id] ?? null, severity: row[severity] ?? null, where: (row[location] ?? '').replace(/`/g, ''), disposition: text, kind })
      }
    }
  }
  const other = dispositions.filter((d) => d.kind === 'other')
  if (other.length > 0) warnings.push(`disposition outside the vocabulary: ${other.map((d) => `${d.id ?? '?'} "${d.disposition}"`).join('; ')}`)
  if (rounds !== null && rounds > ROUND_CAP && field(text, 'Round cap') === null) warnings.push(`${rounds} rounds, above the round cap of ${ROUND_CAP}, and no **Round cap** line names the developer's ruling`)
  if (verdict === 'PASS' && dispositions.some((d) => d.kind === 'outstanding')) warnings.push('a PASS record lists an outstanding finding')
  return { ok: errors.length === 0, verdict: verdict === 'PASS' || verdict === 'BLOCKED' ? verdict : null, commit, change, rounds, counts, dispositions, errors, warnings }
}

