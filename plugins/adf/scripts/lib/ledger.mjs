// A change's execution ledger: the judgements only the executing agent knows — sessions it
// entered, rules it departed from, compromises it took, rulings it made, where it handed off.
// One JSON record per line in `.superpowers/sdd/<change>/ledger.jsonl`, written only through
// the ledger CLI.
//
// A record is checked when it is written, and a malformed one is refused with the reason, so
// nothing is lost silently. Facts the harness already records (dispatches, tokens, models,
// timings) are not written here.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Each kind and the fields a record of it must carry; `optional` fields may be omitted.
export const KINDS = {
  session: { required: ['phase'], optional: [] },
  deviation: { required: ['rule', 'reason'], optional: ['task'] },
  debt: { required: ['what', 'reason'], optional: ['task', 'accepted'] },
  ruling: { required: ['finding', 'decision'], optional: ['task'] },
  handoff: { required: ['merged', 'remaining', 'next'], optional: ['blocked', 'openDeviations'] },
  resolve: { required: ['debt', 'as', 'where'], optional: [] }
}
export const RESOLUTIONS = ['tech-debt', 'adf-debt', 'follow-up', 'accepted']
// A developer ruling on a failing verify check: `ruling --check <id> --reason <text>`, the
// second shape of the `ruling` kind. It turns that check into an accepted failure; it is kept
// out of KINDS, which lists the shapes the origin's ledger shares.
export const CHECK_RULING = { required: ['check', 'reason'], optional: [] }
const CHECK_ID = /^[a-z][a-z0-9-]*$/
// An approved skill edit verify committed: `skill-edit --sha <commit> [--message <m>]`. Its sha
// is exempt from the out-of-plan check for its files under `.claude/skills/` on every later
// verify run. Kept out of KINDS for the same reason as CHECK_RULING.
export const SKILL_EDIT = { required: ['sha'], optional: ['message'] }
// A handoff that blocks a group carries the orchestrator's reason (`apply-status.mjs handoff
// --block`). The field is the port's own, so it is kept out of KINDS as well.
export const HANDOFF_EXTRA = ['blockedReason']
// A ruling on a review finding names what the developer decided: `ruling --finding F<n>
// --as dismissed|accepted|fix --decision <reason>` (lib/review-state.mjs reads it; a disposition
// must match it; `fix` rejects a fixer's false-positive claim, and the fix plan lists the finding
// again). The field is the port's own, kept out of KINDS like HANDOFF_EXTRA.
export const RULING_EXTRA = ['as']
export const RULING_AS = ['dismissed', 'accepted', 'fix']
// A ruling on one item of an apply review loop or of the reuse sweep: `ruling --subject
// T<n>|<G>|final|sweep --finding <id> --as dismissed|accepted|fix --decision <reason>`, where the
// id is the computed result's F<n>, an unverifiable item's U<n> or a sweep finding's S<n>
// (lib/loop.mjs reads it; the review stage's rulings carry no subject). An unverifiable item or a
// sweep finding is accepted or dismissed, never ruled fix: a sweep finding is consolidated.
export const SUBJECT_RULING = { required: ['subject', 'finding', 'as', 'decision'], optional: ['task'] }
export const SUBJECT = /^(T[1-9]\d*|[A-Z]|final|sweep)$/
// A recorded or accepted review finding is placed like a debt: `resolve --finding F<n> --as
// <destination> --where <where>`, the second shape of the `resolve` kind. The origin's `resolve`
// took debt records only, so nothing checked a recorded finding's placement; archive's
// placements read these. Kept out of KINDS like CHECK_RULING.
export const RESOLVE_FINDING = { required: ['finding', 'as', 'where'], optional: [] }
const FINDING_ID = /^F\d+$/
const SHA = /^[0-9a-f]{7,40}$/
export const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID'

export const ledgerPath = (root, change) => join(root, '.superpowers', 'sdd', change, 'ledger.jsonl')

export function readLedger(text) {
  const records = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    records.push(JSON.parse(line))
  }
  return records
}

// Build a record from `--field value` pairs, or throw naming what is wrong.
export function buildRecord(kind, fields, { existing = [], sessionId = null, now = new Date().toISOString() } = {}) {
  const checkRuling = kind === 'ruling' && ('check' in fields || 'reason' in fields)
  const findingResolve = kind === 'resolve' && 'finding' in fields
  const subjectRuling = kind === 'ruling' && !checkRuling && 'subject' in fields
  const spec = checkRuling ? CHECK_RULING : subjectRuling ? SUBJECT_RULING : findingResolve ? RESOLVE_FINDING : kind === 'skill-edit' ? SKILL_EDIT : KINDS[kind]
  if (!spec) throw new Error(`unknown kind "${kind}"; one of: ${Object.keys(KINDS).join(', ')}`)
  const extra = kind === 'handoff' ? HANDOFF_EXTRA : kind === 'ruling' && !checkRuling && !subjectRuling ? RULING_EXTRA : []
  const allowed = new Set([...spec.required, ...spec.optional, ...extra])
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      // The message names the shape's own fields: HANDOFF_EXTRA is written by apply-status, not typed.
      throw new Error(`${kind} takes no --${key}; it takes ${[...spec.required, ...spec.optional].map((k) => `--${k}`).join(', ')}`)
    }
  }
  for (const key of spec.required) {
    if (typeof fields[key] !== 'string' || fields[key].trim() === '') throw new Error(`${kind} needs --${key}`)
  }
  if (checkRuling && !CHECK_ID.test(fields.check)) throw new Error(`--check must be a check id such as out-of-plan, got "${fields.check}"`)
  if (kind === 'ruling' && 'as' in fields && !RULING_AS.includes(fields.as)) throw new Error(`--as must be one of: ${RULING_AS.join(', ')}`)
  if (subjectRuling) {
    if (!SUBJECT.test(fields.subject)) throw new Error(`--subject must be T<n>, a group letter, final or sweep, got "${fields.subject}"`)
    const id = fields.subject === 'sweep' ? /^S[1-9]\d*$/ : /^[FU][1-9]\d*$/
    if (!id.test(fields.finding)) throw new Error(`--finding must be ${fields.subject === 'sweep' ? 'a sweep finding id such as S2' : 'a finding id such as F3, or an unverifiable item such as U1'}, got "${fields.finding}"`)
    if (fields.as === 'fix' && (fields.subject === 'sweep' || fields.finding.startsWith('U'))) {
      throw new Error(`${fields.finding} is accepted or dismissed, never ruled fix: ${fields.subject === 'sweep' ? 'a sweep finding is consolidated by a fix and its re-review' : 'a defect found while checking it is a finding of its own'}`)
    }
  }
  if (kind === 'skill-edit' && !SHA.test(fields.sha)) throw new Error(`--sha must be a commit sha in lower-case hex, got "${fields.sha}"`)
  if ('task' in fields && !/^\d+(\.\d+)?$/.test(fields.task)) {
    throw new Error(`--task must be a task number, got "${fields.task}"`)
  }
  if (kind === 'session' && !sessionId) {
    throw new Error(`session needs ${SESSION_ENV} in the environment; it is read, never typed`)
  }
  if (kind === 'resolve') {
    if (!RESOLUTIONS.includes(fields.as)) throw new Error(`--as must be one of: ${RESOLUTIONS.join(', ')}`)
    if (findingResolve) {
      if (!FINDING_ID.test(fields.finding)) throw new Error(`--finding must be a review finding id such as F3, got "${fields.finding}"`)
    } else {
      const debt = existing.find((r) => r.id === fields.debt && r.kind === 'debt')
      if (!debt) throw new Error(`no debt record "${fields.debt}" to resolve`)
    }
  }
  const n = existing.filter((r) => r.kind === kind).length + 1
  return { id: `${kind}-${n}`, kind, at: now, ...(sessionId ? { sessionId } : {}), ...fields }
}

// The debt records no `resolve` record has closed: what archive must still place.
export function unresolvedDebt(records) {
  const closed = new Set(records.filter((r) => r.kind === 'resolve').map((r) => r.debt))
  return records.filter((r) => r.kind === 'debt' && !closed.has(r.id))
}

// `--field value` pairs into an object; a bare word or a flag without a value is refused.
export function parseFlags(argv) {
  const fields = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument "${flag}"`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    fields[flag.slice(2)] = value
    i += 1
  }
  return fields
}

// The shas of every approved skill edit the ledger records, oldest first, without repeats.
export function skillEditShas(records) {
  return [...new Set(records.filter((r) => r.kind === 'skill-edit').map((r) => r.sha))]
}

export function readRecords(root, change) {
  const path = ledgerPath(root, change)
  return existsSync(path) ? readLedger(readFileSync(path, 'utf8')) : []
}

export function listRecords(root, change, { unresolvedOnly = false } = {}) {
  const records = readRecords(root, change)
  return unresolvedOnly ? unresolvedDebt(records) : records
}

export function appendRecord(root, change, kind, fields, { env = process.env, now } = {}) {
  const path = ledgerPath(root, change)
  const existing = readRecords(root, change)
  const record = buildRecord(kind, fields, { existing, sessionId: env[SESSION_ENV] ?? null, ...(now ? { now } : {}) })
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
  return { record, path }
}

// The session record of a phase, written once per harness session: a second call in the session
// that already holds a `session` record of this phase writes nothing. propose records its session
// when it makes the change and again whenever it continues one, so both routes call this. The
// result says why nothing was written; a missing session id is not an error of the caller's.
export function recordSessionOnce(root, change, phase, { env = process.env, now } = {}) {
  const sessionId = env[SESSION_ENV] ?? null
  if (!sessionId) return { recorded: false, error: `session needs ${SESSION_ENV} in the environment; it is read, never typed` }
  const existing = readRecords(root, change).find((r) => r.kind === 'session' && r.phase === phase && r.sessionId === sessionId)
  if (existing) return { recorded: false, id: existing.id, already: true }
  const { record, path } = appendRecord(root, change, 'session', { phase }, { env, ...(now ? { now } : {}) })
  return { recorded: true, id: record.id, path }
}
