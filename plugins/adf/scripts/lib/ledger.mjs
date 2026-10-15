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
export const RESOLUTIONS = ['tech-debt', 'flow-debt', 'follow-up', 'accepted']
// A developer ruling on a failing verify check: `ruling --check <id> --reason <text>`, the
// second shape of the `ruling` kind. It turns that check into an accepted failure; it is kept
// out of KINDS, which lists the shapes the origin's ledger shares.
export const CHECK_RULING = { required: ['check', 'reason'], optional: [] }
const CHECK_ID = /^[a-z][a-z0-9-]*$/
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
  const spec = checkRuling ? CHECK_RULING : KINDS[kind]
  if (!spec) throw new Error(`unknown kind "${kind}"; one of: ${Object.keys(KINDS).join(', ')}`)
  const allowed = new Set([...spec.required, ...spec.optional])
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new Error(`${kind} takes no --${key}; it takes ${[...allowed].map((k) => `--${k}`).join(', ')}`)
    }
  }
  for (const key of spec.required) {
    if (typeof fields[key] !== 'string' || fields[key].trim() === '') throw new Error(`${kind} needs --${key}`)
  }
  if (checkRuling && !CHECK_ID.test(fields.check)) throw new Error(`--check must be a check id such as out-of-plan, got "${fields.check}"`)
  if ('task' in fields && !/^\d+(\.\d+)?$/.test(fields.task)) {
    throw new Error(`--task must be a task number, got "${fields.task}"`)
  }
  if (kind === 'session' && !sessionId) {
    throw new Error(`session needs ${SESSION_ENV} in the environment; it is read, never typed`)
  }
  if (kind === 'resolve') {
    if (!RESOLUTIONS.includes(fields.as)) throw new Error(`--as must be one of: ${RESOLUTIONS.join(', ')}`)
    const debt = existing.find((r) => r.id === fields.debt && r.kind === 'debt')
    if (!debt) throw new Error(`no debt record "${fields.debt}" to resolve`)
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
