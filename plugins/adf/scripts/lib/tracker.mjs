// The core side of the tracker role (contract 1.7), shared by propose's scope (lib/scope.mjs)
// and the hand-off after the merge (lib/land.mjs): the role call, the held write, and the
// hand-off fields the core checks before the provider renders its comment from them.
//
// The fields are an agent's plain text, never markup: the provider owns the template and the
// markup (contract/README.md, `tracker`), and adds the merge request line itself from the `mr`
// the core passes. Per hand-off state:
//   taken           done (at most 80 words), test (at most 120)
//   partial         done, test, remains (at most 80): what the change left undone
//   not-reproduced  tried (at most 80), what the check tried
// Every required field is present and holds text; no other field is allowed; no field holds a
// link or a URL (a scheme such as https://, a www. host, or Markdown link syntax). An agent
// writes a field as a text or a list of texts; the provider always gets a list of one-line
// texts (handoffFields), and a limit counts the words of the whole list.
import { mkdirSync } from 'node:fs'
import { readRegistry } from './registry.mjs'
import { callRole, trackerReport } from './roles.mjs'

// ---------------------------------------------------------------- the call

// The tracker role, or none on a host with no registry.
export function trackerCall(root, operation, input, core) {
  if (!readRegistry(root)) return { state: 'none', point: 'tracker' }
  return callRole(root, 'tracker', operation, input, core)
}

const keyOf = (entry) => (typeof entry === 'string' ? entry : entry?.key)

// ---------------------------------------------------------------- the held write

// A tracker write held for the developer's yes: without `yes` the provider's plan and its
// preview, with it the held plan applied. `record` is the step's record so far (null before the
// first call); `command` is the call that runs the step again, as the developer sees it
// (`scope.mjs retest --change <name>`); `label` names the plan in a refusal. Returns { record,
// out, applied }: `record` is the step's new record, or null when nothing is recorded (a
// degraded tracker); `out` the result fields; `applied` the keys applied, once applied.
export function heldWrite({ root, operation, input, stateDir, record, yes, core, command, label, refuse }) {
  mkdirSync(stateDir, { recursive: true })
  if (yes && !(record?.plan && ['held', 'failed'].includes(record.state))) refuse(`there is no held ${label} plan to apply; run ${command} without --yes first`)
  const result = trackerCall(root, operation, { ...input, stateDir, ...(yes ? { apply: record.plan } : {}) }, core)
  const report = trackerReport(operation, result)
  if (result.state === 'none') return { record: { state: 'skipped', report }, out: { ok: true, state: 'skipped', report } }
  if (result.state === 'refused') {
    return { record: { state: 'refused', report }, out: { ok: false, state: 'refused', report, error: result.error ?? report, next: `run ${command} without --yes to build a new plan` } }
  }
  if (result.state === 'degraded') return { record: null, out: { ok: true, state: 'degraded', report, hint: result.hint ?? null } }
  if (result.held) {
    const plan = result.plan ?? null
    const preview = result.preview ?? []
    return { record: { state: 'held', plan, preview, report }, out: { ok: true, state: 'pending', held: true, plan, preview, report, waiting: `the developer's yes: ${command} --yes` } }
  }
  const failed = result.failed ?? []
  const state = failed.length ? 'failed' : 'done'
  const applied = result.applied ?? []
  const skipped = result.skipped ?? []
  return {
    record: { state, plan: record?.plan ?? result.plan ?? null, applied, skipped, failed, report },
    out: { ok: failed.length === 0, state, applied, skipped, failed, report, ...(failed.length ? { next: `rerun ${command} --yes: the plan resumes where it stopped` } : {}) },
    applied: applied.map(keyOf)
  }
}

// ---------------------------------------------------------------- the hand-off fields

export const FIELD_LIMITS = { done: 80, test: 120, remains: 80, tried: 80 }
export const HANDOFF_FIELDS = { taken: ['done', 'test'], partial: ['done', 'test', 'remains'], 'not-reproduced': ['tried'] }
const LINK = [/\b[a-z][a-z0-9+.-]*:\/\/\S*/i, /\bwww\.\S*/i, /\[[^\]]*\]\([^)]*\)/]

export const wordCount = (text) => text.split(/\s+/).filter(Boolean).length

// A field as the provider gets it: a list of one-line texts. The agent's text, or each text of
// its list, is split at its line breaks, each line trimmed and the empty ones dropped. Null for
// a value that is neither a text nor a list of texts.
export function fieldLines(value) {
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) && value.every((t) => typeof t === 'string') ? value : null
  // A list marker the agent wrote ("1.", "-", "*") is dropped: the provider renders its own list.
  return texts && texts.flatMap((t) => t.split(/\r?\n/)).map((l) => l.trim().replace(/^(?:\d+[.)]|[-*•])\s+/, '')).filter(Boolean)
}

// The fields of a hand-off item as the core sends them: each text field a list of one-line
// texts; any other value (retest's commit) as it is.
export const handoffFields = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, Object.hasOwn(FIELD_LIMITS, name) ? fieldLines(value) ?? value : value]))

// The errors of an agent's hand-off fields for an item in `state`; [] when they pass. A field is
// a text or a list of texts, checked as the list handoffFields sends. `prefix` names the fields
// in the errors (`fields.done`, or `bug.tried` for the scope check's reply).
export function checkFields(state, fields, { prefix = 'fields' } = {}) {
  const wanted = HANDOFF_FIELDS[state]
  if (!wanted) return [`${state} is not a hand-off state; one of ${Object.keys(HANDOFF_FIELDS).join(', ')}`]
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return [`${prefix} must be an object`]
  const errors = []
  for (const name of Object.keys(fields)) {
    if (wanted.includes(name)) continue
    errors.push(name === 'remains' ? `${prefix}.remains is only for a partial item; a ${state} item has nothing left` : `${prefix}.${name} is not a field of a ${state} item; its fields: ${wanted.join(', ')}`)
  }
  for (const name of wanted) {
    if (!Object.hasOwn(fields, name)) {
      errors.push(`${prefix}.${name} is required for a ${state} item`)
      continue
    }
    const lines = fieldLines(fields[name])
    if (!lines) {
      errors.push(`${prefix}.${name} must be text or a list of texts`)
      continue
    }
    if (lines.length === 0) {
      errors.push(`${prefix}.${name} is empty`)
      continue
    }
    const text = lines.join('\n')
    const count = wordCount(text)
    if (count > FIELD_LIMITS[name]) errors.push(`${prefix}.${name} has ${count} words; the limit is ${FIELD_LIMITS[name]}`)
    const link = LINK.map((re) => re.exec(text)?.[0]).find(Boolean)
    if (link) errors.push(`${prefix}.${name} holds a link or URL ("${link}"); write plain text: the provider adds the merge request link itself`)
  }
  return errors
}
