// The run marker of a whole-suite run (#29): `suite.mjs run` writes it when it starts and when it
// ends, so an agent that started the run in the background waits for it by script (`suite.mjs
// wait`), never with a scheduled wakeup, and apply's report knows the recorded run ended.
//
// `.superpowers/sdd/<change>/suite/run.json` spans the whole command, the base check included;
// `base-run.json` beside it spans the base check's own run. Each holds:
//   running  { state, startedAt, pid, timeoutMs, commit? }
//   done     { state, startedAt, endedAt, durationMs, pid, exit, timedOut, status?, commit?,
//              outputFile?, error?, readAt? }
// `readAt` is when the result was first read (by `wait` or by apply's report), written once; the
// gap from `endedAt` is the idle time between the run's end and the next step. A run that died
// leaves `running`: it is stale when its process is gone, or when it has outlived twice its
// timeout and a margin, since a run is the main run and the base run.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const RUN_FILE = 'run.json'
export const BASE_RUN_FILE = 'base-run.json'
// The longest a `wait` blocks by default: under the Bash tool's 10-minute foreground limit.
export const WAIT_MINUTES = 9
// How long a `wait` that finds only a result already read waits for a new run to start.
export const GRACE_MS = 15000
const MARGIN_MS = 10 * 60000

export const runMarker = (root, change, kind = 'run') => join(root, '.superpowers', 'sdd', change, 'suite', kind === 'base' ? BASE_RUN_FILE : RUN_FILE)

export function readMarker(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Written whole through a temporary file, so a reader never sees half a marker.
function writeMarker(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function isStale(marker, { now = Date.now(), isAlive = alive } = {}) {
  if (marker?.state !== 'running') return false
  if (!Number.isInteger(marker.pid) || !isAlive(marker.pid)) return true
  const started = Date.parse(marker.startedAt)
  const limit = 2 * (Number(marker.timeoutMs) || 0) + MARGIN_MS
  return !Number.isFinite(started) || now - started > limit
}

// Runs fn under the marker: `running` before, `done` with fn's run result after, also when fn
// throws. `done(result)` maps fn's result to the done fields: { exit, timedOut, ... }.
export function marked(file, { timeoutMs, commit }, fn, done = (r) => ({ exit: r.exit, timedOut: Boolean(r.timedOut) })) {
  const startedAt = new Date()
  const base = { startedAt: startedAt.toISOString(), pid: process.pid, ...(commit ? { commit } : {}) }
  writeMarker(file, { state: 'running', ...base, timeoutMs })
  const end = (fields) => {
    const endedAt = new Date()
    writeMarker(file, { state: 'done', ...base, endedAt: endedAt.toISOString(), durationMs: endedAt - startedAt, ...fields })
  }
  let result
  try {
    result = fn()
  } catch (error) {
    end({ exit: null, timedOut: false, error: error.message })
    throw error
  }
  end(done(result))
  return result
}

// The result of a done marker, its first read recorded: `already` when an earlier read made it.
export function readResult(file, marker, { now = new Date() } = {}) {
  const already = typeof marker.readAt === 'string'
  const read = already ? marker : { ...marker, readAt: now.toISOString() }
  if (!already) writeMarker(file, read)
  const idleMs = Math.max(0, Date.parse(read.readAt) - Date.parse(read.endedAt))
  return { ...read, idleMs: Number.isFinite(idleMs) ? idleMs : null, already }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Blocks until the change's run is done and returns its result, or returns { state: 'running' }
// after `maxMs`, for the caller to wait again. A result already read is returned again only once
// `graceMs` passed with no new run started, since a run started in the background may not have
// written its marker yet. Throws when no run is recorded, or when the run died.
export function waitForRun(root, change, { maxMs = WAIT_MINUTES * 60000, graceMs = GRACE_MS, pollMs = 1000 } = {}) {
  const file = runMarker(root, change)
  const start = Date.now()
  for (;;) {
    const marker = readMarker(file)
    const waited = Date.now() - start
    if (marker?.state === 'running') {
      if (isStale(marker)) throw new Error(`the whole-suite run died: ${file} still says running (pid ${marker.pid}, started ${marker.startedAt}); run suite.mjs run again`)
    } else if (marker?.state === 'done' && (!marker.readAt || waited >= Math.min(graceMs, maxMs))) {
      return readResult(file, marker)
    } else if (!marker && waited >= Math.min(graceMs, maxMs)) {
      throw new Error(`no whole-suite run is recorded for ${change} (${existsSync(dirname(file)) ? 'no' : 'no suite directory and no'} ${RUN_FILE}); start it with suite.mjs run`)
    }
    if (waited >= maxMs) return { state: 'running', startedAt: marker?.startedAt ?? null, pid: marker?.pid ?? null, waitedMs: waited }
    sleep(Math.min(pollMs, Math.max(1, maxMs - waited)))
  }
}
