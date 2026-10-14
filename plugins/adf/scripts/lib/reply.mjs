// A subagent's final reply is a JSON object whose shape depends on the role it was
// dispatched in. This validates that shape so the controller reads fields instead of
// prose. The table is keyed by role, in the style of KINDS in lib/ledger.mjs.
//
// Every reply, in every role, carries a top-level `role` key whose value is exactly the
// role it is validated as (`"role": "spec-merge"` for a spec-merge reply). ROLES below
// lists only the fields beside it. No other field is accepted: an unknown key is refused
// at the top level and inside every nested object. The shapes in full:
//
//   impl, fix
//     role      "impl" | "fix"
//     status    "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT"
//     commits   [{ sha: string, subject: string }]
//     tests     { command: string, result: "pass" | "fail", summary: string }
//               may be absent only when status is BLOCKED or NEEDS_CONTEXT
//     concerns  [string]
//     report    string
//
//   review, re-review, final-review, merge-review
//     role      the role name
//     verdict   "pass" | "fail"; "pass" is refused while any finding is critical or important
//     findings  [{ severity: "critical" | "important" | "minor", file: string,
//                  line?: number, summary: string }]
//
//   sweep
//     role          "sweep"
//     verdict       "CLEAN" | "FINDINGS"; CLEAN requires findings empty, FINDINGS non-empty
//     findings      [{ introduced: string, existing: string, why: string }]
//     dispositions? [{ requirement: string, disposition: string }]
//
//   investigate
//     role      "investigate"
//     answer    string
//     evidence  [{ file: string, line?: number }]
//
//   spec-merge
//     role          "spec-merge"
//     capabilities  [{ name: string, added: count, modified: count, removed: count,
//                      renamed: count }]   (count = non-negative integer)
//
// A field marked `?` may be absent; every other field is required.
//
// Field specs in the table: 'string' | 'number' | 'count' (non-negative integer) |
// ['a', 'b'] (enum) | { array: spec } | { object: fields } . A field spec with
// `optional: true` may be absent. The cross-field rules above live in validateReply.

const str = 'string'
const opt = (spec) => ({ optional: true, spec })
const arr = (spec) => ({ array: spec })
const obj = (fields) => ({ object: fields })

const IMPL = {
  status: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'],
  commits: arr(obj({ sha: str, subject: str })),
  tests: opt(obj({ command: str, result: ['pass', 'fail'], summary: str })),
  concerns: arr(str),
  report: str
}

const REVIEW = {
  verdict: ['pass', 'fail'],
  findings: arr(obj({ severity: ['critical', 'important', 'minor'], file: str, line: opt('number'), summary: str }))
}

// Fields beside the required `role` key, which validateReply checks before this table.
export const ROLES = {
  impl: IMPL,
  fix: IMPL,
  review: REVIEW,
  're-review': REVIEW,
  'final-review': REVIEW,
  'merge-review': REVIEW,
  sweep: {
    verdict: ['CLEAN', 'FINDINGS'],
    findings: arr(obj({ introduced: str, existing: str, why: str })),
    dispositions: opt(arr(obj({ requirement: str, disposition: str })))
  },
  investigate: {
    answer: str,
    evidence: arr(obj({ file: str, line: opt('number') }))
  },
  'spec-merge': {
    capabilities: arr(obj({ name: str, added: 'count', modified: 'count', removed: 'count', renamed: 'count' }))
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const checkValue = (spec, value, path, out) => {
  if (Array.isArray(spec)) {
    if (!spec.includes(value)) out.push(`${path} must be one of ${spec.join(', ')}`)
  } else if (spec === 'string') {
    if (typeof value !== 'string') out.push(`${path} must be a string`)
  } else if (spec === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path} must be a number`)
  } else if (spec === 'count') {
    if (!Number.isInteger(value) || value < 0) out.push(`${path} must be a non-negative integer`)
  } else if (spec.array) {
    if (!Array.isArray(value)) out.push(`${path} must be an array`)
    else value.forEach((item, i) => checkValue(spec.array, item, `${path}[${i}]`, out))
  } else if (spec.object) {
    checkFields(spec.object, value, path, out)
  }
}

const checkFields = (fields, value, path, out) => {
  if (!isObject(value)) {
    out.push(`${path || 'reply'} must be an object`)
    return
  }
  for (const [name, def] of Object.entries(fields)) {
    const here = path ? `${path}.${name}` : name
    const optional = isObject(def) && def.optional === true
    if (!Object.hasOwn(value, name)) {
      if (!optional) out.push(`${here} is required`)
      continue
    }
    checkValue(optional ? def.spec : def, value[name], here, out)
  }
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(fields, name)) out.push(`${path ? `${path}.${name}` : name} is not a known field`)
  }
}

export function validateReply(role, value) {
  if (!Object.hasOwn(ROLES, role)) return [`role ${String(role)} is not a known role`]
  if (!isObject(value)) return ['reply must be a JSON object']
  const out = []
  if (value.role !== role) out.push(`role must be ${role}`)
  const { role: _role, ...rest } = value
  const fields = ROLES[role]
  checkFields(fields, rest, '', out)

  if (role === 'impl' || role === 'fix') {
    if (!('tests' in rest) && rest.status !== 'BLOCKED' && rest.status !== 'NEEDS_CONTEXT') {
      out.push('tests may be absent only when status is BLOCKED or NEEDS_CONTEXT')
    }
  } else if (fields === REVIEW && Array.isArray(rest.findings)) {
    const blocking = rest.findings.some((f) => isObject(f) && (f.severity === 'critical' || f.severity === 'important'))
    if (rest.verdict === 'pass' && blocking)
      out.push('verdict pass is refused while a critical or important finding is present')
  } else if (role === 'sweep' && Array.isArray(rest.findings)) {
    if (rest.verdict === 'CLEAN' && rest.findings.length > 0)
      out.push('verdict CLEAN is refused while findings is not empty')
    if (rest.verdict === 'FINDINGS' && rest.findings.length === 0)
      out.push('verdict FINDINGS is refused while findings is empty')
  }
  return out
}

// The reasons a reply file's text is refused: those of validateReply, or one reason when the
// text is not JSON at all.
export function checkReplyText(role, text) {
  try {
    return validateReply(role, JSON.parse(text))
  } catch {
    return ['file is not valid JSON']
  }
}
