// The one retry mechanism of every dispatch: an events log per change,
// `.superpowers/sdd/<change>/attempts.jsonl`, one JSON object per line, keyed by the dispatch's
// fixed-form name (lib/dispatch.mjs parseName), never by a reply's content. A retrospective
// serves no change and keeps its own, `.superpowers/retro/<id>/attempts.jsonl` (lib/retro.mjs).
//
//   { name, at, event: "dispatch" }                           the dispatch was sent (or resent)
//   { name, at, event: "invalid", file, errors, mode, next }  its reply was refused
//   { name, at, event: "valid", file, result? }               its reply was accepted
//
// A line with no `event` is the format `dispatch.mjs attempt` wrote before the events, `{ name,
// at }`, and reads as a `dispatch`; `roundOf` reads names alone, so it counts the same rounds over
// either form.
//
// The retry rule (apply.md, archive.md, review.md): a refused reply goes back once; a second
// refused reply of one name stops it. The first invalid reply gives `retry`, the second `stop`,
// and nothing more is recorded for that name; a valid reply between them ends the streak, and
// the number of dispatches never stops one. Verify
// and the review stage count only their current run's events (runSince). A retry resumes the same agent with the errors
// (`mode: resume`); a fresh dispatch carries the errors as its question only where the harness
// cannot resume the agent (`mode: fresh`). The consequence of `stop` stays with each phase: apply
// marks the dispatch BLOCKED, the review stage writes its stopped record, archive stops.
//
// A stop the environment caused (a permission denial, a missing tool) ends only by a developer
// reset (`dispatch.mjs reset`): held, a preview with its plan id, until the developer's yes with
// that id; then an `attempt-reset` ledger record (lib/ledger.mjs). The log keeps every event, and
// the metrics count them all; only the limit counts the name's events after the last reset.
// `recordDispatch` and `recordReply` name that reset on a `stop` (`reset`, resetHint), for every
// name but a role whose run restarts its own count.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DispatchError, MAX_ATTEMPTS, parseName, sddDir, verifyDirOf } from './dispatch.mjs'
import { appendAttemptReset, ATTEMPT_RESET, readRecords } from './ledger.mjs'

export const EVENTS = ['dispatch', 'invalid', 'valid']
export const attemptsFile = (root, change) => join(sddDir(root, change), 'attempts.jsonl')

// Every well-formed event of the log, legacy lines as `dispatch`; a line that is not JSON or names
// nothing is skipped.
export function parseEvents(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || typeof value.name !== 'string') continue
    out.push({ ...value, event: value.event ?? 'dispatch' })
  }
  return out
}

export const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

// Where one name stands: its counts and what comes next. `next` is `dispatch` before any invalid
// reply, `retry` after the first, `stop` from the second (MAX_ATTEMPTS refused replies). `since`
// (an ISO time) counts only the events at or after it: a phase that starts its run again (the
// review stage's `start --fresh`) reuses its names, and the earlier run's events no longer count.
// `skip` passes over the name's first events, those a developer reset covers (resetSkip).
// `invalid` counts the refusal streak: only the invalid replies after the name's last valid one,
// so a valid reply (a NEEDS_CONTEXT) starts the limit anew for the dispatch that answers it.
export function standing(text, name, { since = null, skip = 0 } = {}) {
  const events = parseEvents(text)
    .filter((e) => e.name === name)
    .slice(skip)
    .filter((e) => since === null || String(e.at ?? '') >= since)
  const count = (event, list = events) => list.filter((e) => e.event === event).length
  const lastValid = events.findLastIndex((e) => e.event === 'valid')
  const invalid = count('invalid', events.slice(lastValid + 1))
  return { name, dispatches: count('dispatch'), invalid, valid: count('valid'), next: nextForInvalid(invalid) }
}

export const nextForInvalid = (invalid) => (invalid === 0 ? 'dispatch' : invalid < MAX_ATTEMPTS ? 'retry' : 'stop')

function append(file, event) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  return file
}

const checkName = (name) => {
  if (!parseName(name)) throw new DispatchError(`"${name}" is not a dispatch name in the fixed form`)
}

// `dispatch.mjs attempt`: records one dispatch of `name`. `attempt` counts the dispatches of the
// name, legacy lines included, for the metrics; `next` follows its refused replies as `standing`
// gives it, never the dispatch count: a valid reply (a NEEDS_CONTEXT) and its re-dispatch use up
// nothing. Counted from the name's last developer reset and from its phase's run start
// (runSince). On a stop, `reset` names the developer reset.
export function recordDispatch(root, change, name, options = {}) {
  const since = runSince(root, change, parseName(name)?.role)
  return withReset(change, name, recordDispatchAt(attemptsFile(root, change), name, { ...options, since, skip: resetSkip(root, change, name) }))
}

// The same, into the log `file`: a dispatch that serves no change keeps its own (lib/retro.mjs).
export function recordDispatchAt(file, name, { now = new Date().toISOString(), since = null, skip = 0 } = {}) {
  checkName(name)
  append(file, { name, at: now, event: 'dispatch' })
  const { dispatches, next } = standing(readLog(file), name, { since, skip })
  return { name, attempt: dispatches, next, file }
}

// Where the current run of the name's phase starts, the time its count restarts from: verify's
// session (`started` in its run.json), the review stage's run (`at` in its start.json); null for
// every other role, counted over the change's life. An apply round's start is not recorded yet.
export function runSince(root, change, role) {
  if (role === 'verify') {
    const run = readJsonOr(join(verifyDirOf(root, change), 'run.json'))
    return run ? (run.started ?? run.at ?? null) : null
  }
  if (role === 'ai-review' || role === 'ai-fix') return readJsonOr(join(sddDir(root, change), 'review', 'start.json'))?.at ?? null
  return null
}

const readJsonOr = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)

// Records a checked reply of `name`: `invalid` when `errors` is not empty, else `valid` with the
// computed `result` (when the checker gives one). Returns { ok, valid, errors, next, mode, invalid,
// replyFile, log }: `next` is `proceed` for a valid reply, else `retry` or `stop`; `mode` is `resume` or
// `fresh` on a retry (`resume: false` when the harness cannot resume the agent), null otherwise.
// Refused once the name has stopped: nothing a stopped dispatch replies is recorded. `since` as
// `standing` takes it.
// Counted from the name's last developer reset. On a stop, `reset` names the developer reset.
export function recordReply(root, change, reply) {
  return withReset(change, reply.name, recordReplyAt(attemptsFile(root, change), { ...reply, skip: resetSkip(root, change, reply.name) }))
}

const withReset = (change, name, out) => {
  const reset = out.next === 'stop' ? resetHint(change, name) : null
  return reset ? { ...out, reset } : out
}

// The same, into the log `logFile`.
export function recordReplyAt(logFile, { name, file, errors = [], result, resume = true, since = null, skip = 0, now = new Date().toISOString() }) {
  checkName(name)
  const before = standing(readLog(logFile), name, { since, skip })
  if (before.next === 'stop') throw new DispatchError(`${name} stopped after ${before.invalid} invalid replies; nothing it replies is recorded`)
  if (errors.length === 0) {
    const log = append(logFile, { name, at: now, event: 'valid', file, ...(result === undefined ? {} : { result }) })
    return { ok: true, valid: true, errors: [], next: 'proceed', mode: null, invalid: before.invalid, replyFile: file, log }
  }
  const invalid = before.invalid + 1
  const next = nextForInvalid(invalid)
  const mode = next === 'retry' ? (resume ? 'resume' : 'fresh') : null
  const log = append(logFile, { name, at: now, event: 'invalid', file, errors, mode, next })
  return { ok: false, valid: false, errors, next, mode, invalid, replyFile: file, log }
}

// ---------------------------------------------------------------- the developer reset

// Roles whose run restarts its own count: the review stage (`review.mjs start --fresh`) and
// verify (`verify.mjs run`); a reset of theirs is refused with that pointer.
const OWN_RESTART = { 'ai-review': 'review.mjs start --fresh', 'ai-fix': 'review.mjs start --fresh', verify: 'verify.mjs run' }

// The way out of a stop on the limit: { command, note }, the `dispatch.mjs reset` preview and
// that the developer is asked first; null for a role whose run restarts its own count.
export function resetHint(change, name) {
  if (OWN_RESTART[parseName(name)?.role]) return null
  return {
    command: `dispatch.mjs reset --change ${change} --name "${name}" --reason "<the developer's reason>"`,
    note: 'only when the environment caused the stop (a permission denial, a missing tool) and is fixed now, ask the developer first, show them the preview this command prints (it writes nothing), and on their yes run it with --yes <plan>'
  }
}

// How many of the name's events the limit passes over: the last reset's `skip`, else 0.
export function resetSkip(root, change, name) {
  const last = readRecords(root, change).filter((r) => r.kind === ATTEMPT_RESET && r.name === name).at(-1)
  return Number.isInteger(last?.skip) ? last.skip : 0
}

// Where the name stands for the limit, from its last reset; `since` as `standing` takes it.
export const standingOf = (root, change, name, { since = null } = {}) =>
  standing(readLog(attemptsFile(root, change)), name, { since, skip: resetSkip(root, change, name) })

// `dispatch.mjs reset`: without `yes`, the held plan: which events of the stopped name stop
// counting, and its id; nothing is written. With `yes` equal to that id (the log and the reason
// unchanged since the preview), the `attempt-reset` ledger record, and the name dispatches again.
// Refused for a name that has not stopped, for a role whose run restarts on its own, and for an
// id that is not the current plan's.
export function resetAttempts(root, change, name, { reason, yes = null, env, now } = {}) {
  checkName(name)
  const role = parseName(name).role
  if (OWN_RESTART[role]) refuseReset(`${name} restarts its own count: run ${OWN_RESTART[role]} instead of a reset`)
  if (typeof reason !== 'string' || reason.trim() === '') refuseReset('a reset needs the developer\'s --reason')
  const all = parseEvents(readLog(attemptsFile(root, change))).filter((e) => e.name === name)
  const from = resetSkip(root, change, name)
  const covered = all.slice(from)
  const count = (event) => covered.filter((e) => e.event === event).length
  const covers = { events: covered.length, dispatches: count('dispatch'), invalid: count('invalid'), valid: count('valid') }
  if (covers.invalid < MAX_ATTEMPTS) {
    refuseReset(`${name} has not stopped (${covers.dispatches} dispatches, ${covers.invalid} invalid replies since ${from ? 'its last reset' : 'its first dispatch'}); a reset is only for a stopped dispatch`)
  }
  const plan = `reset-${createHash('sha256').update(JSON.stringify({ change, name, reason, from, covered })).digest('hex').slice(0, 12)}`
  const command = `dispatch.mjs reset --change ${change} --name "${name}" --reason "${reason}"`
  if (yes === null) {
    return {
      ok: true,
      state: 'pending',
      held: true,
      name,
      plan,
      covers,
      preview: [
        `${name}: ${covers.dispatches} dispatches and ${covers.invalid} invalid replies stop counting toward the limit; they stay in attempts.jsonl and in the metrics`,
        `reason: ${reason}`,
        `writes the ledger record ${ATTEMPT_RESET} by the developer; the next dispatch of ${name} is its first again`
      ],
      waiting: `the developer's yes: ${command} --yes ${plan}`
    }
  }
  if (yes !== plan) refuseReset(`plan ${yes} does not match the current reset plan of ${name}; run ${command} without --yes for a new preview`)
  const { record, path } = appendAttemptReset(root, change, { name, reason, plan, covers, skip: all.length }, { ...(env ? { env } : {}), ...(now ? { now } : {}) })
  return { ok: true, state: 'done', name, record, ledger: path, next: 'dispatch' }
}

function refuseReset(message) {
  throw new DispatchError(message)
}
