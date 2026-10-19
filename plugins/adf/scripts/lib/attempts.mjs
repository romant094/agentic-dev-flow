// The one retry mechanism of every dispatch: an events log per change,
// `.superpowers/sdd/<change>/attempts.jsonl`, one JSON object per line, keyed by the dispatch's
// fixed-form name (lib/dispatch.mjs parseName), never by a reply's content.
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
// and nothing more is recorded for that name. A retry resumes the same agent with the errors
// (`mode: resume`); a fresh dispatch carries the errors as its question only where the harness
// cannot resume the agent (`mode: fresh`). The consequence of `stop` stays with each phase: apply
// marks the dispatch BLOCKED, the review stage writes its stopped record, archive stops.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { countAttempts, DispatchError, MAX_ATTEMPTS, nextFor, parseName, sddDir } from './dispatch.mjs'

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

const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

// Where one name stands: its counts and what comes next. `next` is `dispatch` before any invalid
// reply, `retry` after the first, `stop` from the second (MAX_ATTEMPTS refused replies).
export function standing(text, name) {
  const events = parseEvents(text).filter((e) => e.name === name)
  const count = (event) => events.filter((e) => e.event === event).length
  const invalid = count('invalid')
  return { name, dispatches: count('dispatch'), invalid, valid: count('valid'), next: nextForInvalid(invalid) }
}

export const nextForInvalid = (invalid) => (invalid === 0 ? 'dispatch' : invalid < MAX_ATTEMPTS ? 'retry' : 'stop')

function append(root, change, event) {
  const file = attemptsFile(root, change)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  return file
}

const checkName = (name) => {
  if (!parseName(name)) throw new DispatchError(`"${name}" is not a dispatch name in the fixed form`)
}

// `dispatch.mjs attempt`: records one dispatch of `name`. `attempt` counts the dispatches of the
// name, legacy lines included: 1 dispatches, 2 retries, 3 stops.
export function recordDispatch(root, change, name, { now = new Date().toISOString() } = {}) {
  checkName(name)
  const file = append(root, change, { name, at: now, event: 'dispatch' })
  const attempt = countAttempts(readLog(file), name)
  return { name, attempt, next: nextFor(attempt), file }
}

// Records a checked reply of `name`: `invalid` when `errors` is not empty, else `valid` with the
// computed `result` (when the checker gives one). Returns { ok, valid, errors, next, mode, invalid,
// replyFile, log }: `next` is `proceed` for a valid reply, else `retry` or `stop`; `mode` is `resume` or
// `fresh` on a retry (`resume: false` when the harness cannot resume the agent), null otherwise.
// Refused once the name has stopped: nothing a stopped dispatch replies is recorded.
export function recordReply(root, change, { name, file, errors = [], result, resume = true, now = new Date().toISOString() }) {
  checkName(name)
  const before = standing(readLog(attemptsFile(root, change)), name)
  if (before.next === 'stop') throw new DispatchError(`${name} stopped after ${before.invalid} invalid replies; nothing it replies is recorded`)
  if (errors.length === 0) {
    const log = append(root, change, { name, at: now, event: 'valid', file, ...(result === undefined ? {} : { result }) })
    return { ok: true, valid: true, errors: [], next: 'proceed', mode: null, invalid: before.invalid, replyFile: file, log }
  }
  const invalid = before.invalid + 1
  const next = nextForInvalid(invalid)
  const mode = next === 'retry' ? (resume ? 'resume' : 'fresh') : null
  const log = append(root, change, { name, at: now, event: 'invalid', file, errors, mode, next })
  return { ok: false, valid: false, errors, next, mode, invalid, replyFile: file, log }
}
