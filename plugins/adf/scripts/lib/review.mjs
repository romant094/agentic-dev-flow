// The review stage's deterministic steps: the range and the files it reviews, the reviewer's
// input, the check of the reviewer's and the fixer's JSON replies, the verdict and the text a
// person reads. The review itself, each fix and a false-positive argument stay with agents.
//
// Nothing here needs a change directory or a Claude Code session except the range taken from a
// change: a CI job runs the same filter, payload, check and verdict on `--range` (decision D13).
// Nothing here names a model.
//
// Every git call runs at the root; paths are repository-relative with `/` separators.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changeDir, changeMeta, CHANGES_DIR, globToRegExp } from './changes.mjs'
import { baseRef } from './plan-symbols.mjs'
import { readRegistry, SEVERITIES, validateReviewSettings } from './registry.mjs'
import { pathMatcher, plannedPaths } from './verify.mjs'

export { SEVERITIES }
export const DEFAULT_BLOCK_ON = ['CRITICAL', 'HIGH']
// A diff larger than this goes to more than one reviewer, sliced by directory.
export const DEFAULT_MAX_BYTES = 400000
// A disposition that closes a finding; any other (`recorded`, none) leaves it open.
export const CLOSED = ['fixed', 'dismissed', 'accepted']

// The files no reviewer reads: prose, lock files, build output, generated code, snapshots and
// coverage. The union of the origin's local pathspecs and its CI filter, with `.md` excluded on
// both sides; generated files and `__snapshots__/` at any depth, the top level included. The
// change records are the flow's own and never code.
export const DEFAULT_EXCLUDE = [
  '**/*.md',
  'openspec/changes/**',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/generated.*',
  '**/*.generated.*',
  '**/__snapshots__/**',
  '**/coverage/**'
]

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
export const FINDINGS_SCHEMA_PATH = join(SCHEMA_DIR, 'review-findings.schema.json')
export const FIX_SCHEMA_PATH = join(SCHEMA_DIR, 'review-fix.schema.json')
export const readSchema = (path) => JSON.parse(readFileSync(path, 'utf8'))

// ---------------------------------------------------------------- configuration

// The review settings with their defaults. `root` may hold no registry: a CI checkout of a host
// that set nothing reviews with the defaults.
export function reviewConfig(root) {
  const review = readRegistry(root)?.review ?? {}
  const errors = validateReviewSettings(review)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return {
    prompt: review.prompt ?? null,
    exclude: [...DEFAULT_EXCLUDE, ...(review.exclude ?? [])],
    include: review.include ?? [],
    maxBytes: review.maxBytes ?? DEFAULT_MAX_BYTES,
    blockOn: review.blockOn ?? DEFAULT_BLOCK_ON
  }
}

// ---------------------------------------------------------------- filter

// { kept: [path], excluded: [{ file, pattern }] }. An include glob keeps a file any exclude glob
// matches; `pattern` is the first exclude glob that matched.
export function filterPaths(paths, { exclude = DEFAULT_EXCLUDE, include = [] } = {}) {
  const excludes = exclude.map((glob) => [glob, globToRegExp(glob)])
  const includes = include.map((glob) => globToRegExp(glob))
  const kept = []
  const excluded = []
  for (const file of paths) {
    const hit = excludes.find(([, re]) => re.test(file))
    if (hit && !includes.some((re) => re.test(file))) excluded.push({ file, pattern: hit[0] })
    else kept.push(file)
  }
  return { kept, excluded }
}

// ---------------------------------------------------------------- range and diff

const gitAt = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })

function commit(git, ref, what) {
  try {
    return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim()
  } catch {
    throw new Error(`${what} ${ref} is not a commit`)
  }
}

// `A..B` into its two ends; null when the text is not a two-dot range.
export function parseRange(text) {
  const at = String(text ?? '').indexOf('..')
  if (at <= 0 || text.includes('...')) return null
  const from = text.slice(0, at)
  const to = text.slice(at + 2)
  return to ? { from, to } : null
}

// The range the review reads: { base, head, spec, from }. `range` (`A..B`) names it outright;
// otherwise the change's base branch (its .adf.json, `origin/<base>` when the remote has it)
// merge base to HEAD. `since`, from round 2 on, replaces the base with the sha recorded before
// the round's fixes, so the reviewer reads the fix range only.
export function resolveRange(root, { change = null, range = null, since = null } = {}) {
  const git = gitAt(root)
  let base
  let head
  let out
  if (range) {
    const ends = parseRange(range)
    if (!ends) throw new Error(`--range ${range} is not a range A..B`)
    base = commit(git, ends.from, 'the range start')
    head = commit(git, ends.to, 'the range end')
    out = { from: 'range' }
  } else if (change) {
    const ref = baseRef(changeMeta(root, change), (name) => {
      try {
        git('rev-parse', '--verify', '--quiet', name)
        return true
      } catch {
        return false
      }
    })
    head = commit(git, 'HEAD', 'HEAD')
    try {
      base = git('merge-base', ref, head).trim()
    } catch {
      throw new Error(`${ref} and HEAD have no merge base`)
    }
    out = { from: 'change', baseRef: ref }
  } else throw new Error('name the range: --change <name> or --range A..B')
  if (since) {
    const sha = commit(git, since, '--since')
    try {
      git('merge-base', '--is-ancestor', sha, head)
    } catch {
      throw new Error(`--since ${since} is not an ancestor of ${head}`)
    }
    out = { ...out, since: sha }
    base = sha
  }
  return { base, head, spec: `${base}..${head}`, ...out }
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/']

// Every file the range changes, a rename as its two ends.
export function changedFiles(root, { base, head }) {
  return gitAt(root)('-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', base, head)
    .split('\0')
    .filter(Boolean)
}

// The diff of each kept file: Map file → text. One git call cut at its file headers; a file
// whose header git quotes (a tab or a quote in its name) is diffed on its own.
export function fileDiffs(root, { base, head }, files) {
  const git = gitAt(root)
  const diffs = new Map()
  if (files.length === 0) return diffs
  const wanted = new Map(files.map((f) => [`a/${f} b/${f}`, f]))
  const text = git('-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, base, head)
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    const header = /^diff --git (.*)$/m.exec(chunk)?.[1]
    const file = header === undefined ? undefined : wanted.get(header)
    if (file !== undefined) diffs.set(file, chunk)
  }
  for (const file of files) if (!diffs.has(file)) diffs.set(file, git('diff', ...DIFF_FLAGS, base, head, '--', file))
  return diffs
}

// The range's files after the filter, each with its diff's size in bytes.
export function collect(root, range, config) {
  const changed = changedFiles(root, range)
  const { kept, excluded } = filterPaths(changed, config)
  const diffs = fileDiffs(root, range, kept)
  const files = kept.map((file) => ({ file, bytes: Buffer.byteLength(diffs.get(file), 'utf8') }))
  return { changed, files, excluded, diffs, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
}

// ---------------------------------------------------------------- slices

const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '')
function commonDir(files) {
  let prefix = dirOf(files[0])
  for (const f of files) while (prefix && !f.startsWith(prefix)) prefix = dirOf(prefix.slice(0, -1))
  return prefix || './'
}

// Groups of files by directory, each at most `maxBytes`: the files and directories of one level,
// in path order, packed while they fit; a directory over the limit is split one level down. A
// single file over the limit is a slice of its own, marked `oversize`.
function pack(entries, depth, maxBytes) {
  const units = new Map()
  for (const e of entries) {
    const parts = e.file.split('/')
    const key = parts.length > depth + 1 ? `${parts[depth]}/` : parts[depth]
    if (!units.has(key)) units.set(key, { dir: key.endsWith('/'), files: [], bytes: 0 })
    const unit = units.get(key)
    unit.files.push(e)
    unit.bytes += e.bytes
  }
  const groups = []
  let current = null
  const flush = () => {
    if (current) groups.push(current.files)
    current = null
  }
  for (const key of [...units.keys()].sort()) {
    const unit = units.get(key)
    if (unit.bytes > maxBytes) {
      flush()
      if (unit.dir) groups.push(...pack(unit.files, depth + 1, maxBytes))
      else groups.push(unit.files)
    } else if (current && current.bytes + unit.bytes <= maxBytes) {
      current.files.push(...unit.files)
      current.bytes += unit.bytes
    } else {
      flush()
      current = { files: [...unit.files], bytes: unit.bytes }
    }
  }
  flush()
  return groups
}

// [{ index, dir, files, bytes, oversize }], 1-based, or null when the diff fits one reviewer.
export function proposeSlices(files, maxBytes) {
  const total = files.reduce((sum, f) => sum + f.bytes, 0)
  if (total <= maxBytes) return null
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return pack(sorted, 0, maxBytes).map((group, i) => {
    const bytes = group.reduce((sum, f) => sum + f.bytes, 0)
    return { index: i + 1, dir: commonDir(group.map((f) => f.file)), files: group.map((f) => f.file), bytes, oversize: bytes > maxBytes }
  })
}

// The proof that the slices cover the diff: every kept file in exactly one slice, and the
// slices' bytes summing to the diff's.
export function coverageProof(files, slices) {
  const seen = new Map(files.map((f) => [f.file, 0]))
  const strays = []
  for (const slice of slices) for (const file of slice.files) seen.has(file) ? seen.set(file, seen.get(file) + 1) : strays.push(file)
  const missing = [...seen].filter(([, n]) => n === 0).map(([f]) => f)
  const repeated = [...seen].filter(([, n]) => n > 1).map(([f]) => f)
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
  const sliceBytes = slices.reduce((sum, s) => sum + s.bytes, 0)
  const sliceFiles = slices.reduce((sum, s) => sum + s.files.length, 0)
  const ok = missing.length === 0 && repeated.length === 0 && strays.length === 0 && bytes === sliceBytes && sliceFiles === files.length
  return { ok, files: files.length, sliceFiles, bytes, sliceBytes, missing, repeated, strays }
}

// ---------------------------------------------------------------- the plan's files

// Which of the plan's `**Files:**` paths the range touches. None touched means the code reached
// the base some other way, and the range reviews only the change's records.
export function planTouch(root, change, changed) {
  const path = join(changeDir(root, change), 'plan.md')
  if (!existsSync(path)) return { paths: 0, touched: [], untouched: [], warning: `${change} has no plan.md: the range is not checked against the plan` }
  const { paths } = plannedPaths(readFileSync(path, 'utf8'))
  const prefix = `${CHANGES_DIR}/${change}/`
  const code = changed.filter((f) => !f.startsWith(prefix))
  const touched = paths.filter((p) => {
    const covers = pathMatcher(p)
    return code.some((f) => covers(f))
  })
  const untouched = paths.filter((p) => !touched.includes(p))
  const warning =
    paths.length > 0 && touched.length === 0
      ? `the range touches none of the plan's ${paths.length} **Files:** path(s): the code may have reached the base outside this change; name the commits with --range`
      : null
  return { paths: paths.length, touched, untouched, warning }
}

// ---------------------------------------------------------------- payload

const list = (items) => items.join(', ')
export const cell = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
export const where = (f) => (f.line === null || f.line === undefined ? f.file : `${f.file}:${f.line}`)

// The block the core appends to the host prompt: the reply's JSON schema, the severities and
// which of them block, and the marker grammar. The host prompt holds the criteria only.
export function coreBlock({ blockOn = DEFAULT_BLOCK_ON, schemaText = readFileSync(FINDINGS_SCHEMA_PATH, 'utf8') } = {}) {
  const passing = SEVERITIES.filter((s) => !blockOn.includes(s))
  return [
    '## Reply format',
    '',
    'This section is set by the review stage and overrides any reply format the text above asks for.',
    '',
    'Reply with one JSON object and nothing else, valid under this JSON Schema:',
    '',
    '```json',
    schemaText.trim(),
    '```',
    '',
    `- \`severity\` is one of ${list(SEVERITIES)}, most severe first. A finding of severity ${list(blockOn)} blocks the merge${passing.length ? `; ${list(passing)} is recorded and does not block` : ''}.`,
    '- `id` numbers the findings F1, F2, ... in the order you report them.',
    '- `file` is the path the diff names after `b/`; `line` is the line in the new file, or null when the finding has no single line.',
    '- `key` is the identifier a suppression marker names for this kind of finding, such as a CWE id (CWE-79), when it has one.',
    '- There is no verdict field: the verdict is computed from the severities. No findings is a valid reply: `{"summary": "...", "findings": []}`.',
    '',
    '## Suppression markers',
    '',
    'A comment `ADF IGNORE <key> -- <reason>` on the line directly above a line, or the pair `ADF IGNORE-START <key> -- <reason>` and `ADF IGNORE-END` around a block, means: do not report a finding with that `key` on that line or block. Still report any other key or issue on the same line or block. A marker with no key, or with a key no finding of yours carries, suppresses nothing and is not itself a finding.',
    '',
    'A comment `ADF DUP <existing> -- <reason>` records a duplicate of the code at `<existing>` that the developer accepted. Do not report that duplicate, and do not report the comment itself as dead code, an unexplained annotation or a magic value.'
  ].join('\n')
}

// The previous round's findings the fix range was made for, from round 2: each with its state
// now and the fixer's failure mode. `previous` is [{ id, severity, file, line, title, body,
// state, failureMode }].
export function previousBlock(round, previous) {
  const lines = [
    `## Round ${round - 1} findings`,
    '',
    `The fix range below was made for these findings of round ${round - 1}. Each gives its state now and, where a fixer answered it, the failure mode the fixer stated. Check each fix against its stated failure mode: a fix can miss its finding, fix it in part or add a new defect, and each of these is a finding of this round.`,
    ''
  ]
  for (const f of previous) {
    lines.push(`### ${f.id} (${f.severity}): ${f.title}`, '', `Location: \`${where(f)}\`. State: ${f.state}.`, '', f.body.trim(), '')
    lines.push(`Failure mode: ${f.failureMode ? f.failureMode.trim() : 'none stated: no fixer answered this finding.'}`, '')
  }
  return lines.join('\n').trimEnd()
}

// The reviewer's whole input: the host prompt, the core block, then the diff. From round 2 the
// diff is the fix range only, after the previous round's findings; a slice says which part of
// the diff it is.
export function buildPayload({ prompt, diff, range, blockOn = DEFAULT_BLOCK_ON, round = 1, slice = null, previous = [], schemaText }) {
  const scope = []
  if (round > 1) {
    scope.push(`This is review round ${round}. The diff is the fix range ${range.spec}: the commits made to fix the previous round's findings. Review it on its own merits; do not rely on the previous round's verdict.`)
  }
  if (slice) {
    scope.push(`This is slice ${slice.index} of ${slice.of}: the files under ${slice.dir}. The other slices go to other reviewers; do not report code as missing only because it lies outside this slice.`)
  }
  return [
    prompt.trim(),
    '',
    '---',
    '',
    coreBlock({ blockOn, ...(schemaText ? { schemaText } : {}) }),
    '',
    ...(round > 1 && previous.length ? [previousBlock(round, previous), ''] : []),
    '## Diff',
    '',
    ...(scope.length ? [...scope, ''] : []),
    `Range: ${range.spec}`,
    '',
    'Here is the diff:',
    '',
    diff
  ].join('\n')
}

// The reviewer's input for a range: { ok: true, payload, files, bytes, slice, slices } or
// { ok: false, error, ... }. Over `config.maxBytes` the diff goes by slices and `slice` (1-based)
// picks one; `slicesApproved` false refuses a slice, with the proposal and its proof to show.
export function prepareInput(root, { range, config, prompt, round = 1, slice = null, previous = [], slicesApproved = true }) {
  const { files, diffs } = collect(root, range, config)
  if (files.length === 0) return { ok: false, error: `the filtered diff of ${range.spec} is empty: there is nothing to review`, range }
  const slices = proposeSlices(files, config.maxBytes)
  let chosen = files.map((f) => f.file)
  let picked = null
  if (slices) {
    if (slice === null) return { ok: false, error: `the diff is over review.maxBytes (${config.maxBytes}): pass --slice <n>, 1-${slices.length}, as start proposed`, range, slices: slices.length }
    if (!slicesApproved) return { ok: false, error: 'the slices have no developer approval: the developer approves them with a review-slices ruling', needsRuling: true, range, slices, proof: coverageProof(files, slices) }
    const s = slices[slice - 1]
    if (!s) return { ok: false, error: `--slice ${slice} is not a slice: 1-${slices.length}`, range }
    chosen = s.files
    picked = { index: s.index, of: slices.length, dir: s.dir }
  } else if (slice !== null) return { ok: false, error: `the diff fits one reviewer (${config.maxBytes} bytes): there are no slices`, range }
  const diff = chosen.map((f) => diffs.get(f)).join('')
  const payload = buildPayload({ prompt, diff, range, blockOn: config.blockOn, round, slice: picked, previous })
  return { ok: true, payload, files: chosen.length, bytes: Buffer.byteLength(diff, 'utf8'), slice: picked, slices: slices ? slices.length : null }
}

// ---------------------------------------------------------------- the replies

const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', '$defs', 'items', '$ref', 'enum', 'const', 'pattern', 'minLength', 'minimum', 'allOf', 'if', 'then'])

// The keywords of a schema this validator does not implement; a schema must use none.
export function unknownKeywords(schema, path = '$') {
  if (schema === null || typeof schema !== 'object') return []
  const out = []
  for (const [key, value] of Object.entries(schema)) {
    if (!KNOWN.has(key)) out.push(`${path}.${key}`)
    if (key === 'properties' || key === '$defs') for (const [name, sub] of Object.entries(value)) out.push(...unknownKeywords(sub, `${path}.${key}.${name}`))
    else if (key === 'allOf') value.forEach((sub, i) => out.push(...unknownKeywords(sub, `${path}.allOf[${i}]`)))
    else if (['items', 'if', 'then'].includes(key)) out.push(...unknownKeywords(value, `${path}.${key}`))
  }
  return out
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const TYPES = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null
}

// The errors of `value` under the subset of JSON Schema draft 2020-12 the review schemas use.
export function validateJson(schema, value, path = '$', root = schema) {
  if (schema.$ref) return validateJson(root.$defs[schema.$ref.replace('#/$defs/', '')], value, path, root)
  const errors = []
  if (schema.type) {
    const types = [].concat(schema.type)
    if (!types.some((t) => TYPES[t](value))) return [`${path}: expected ${types.join(' or ')}`]
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: must not be empty`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`)
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validateJson(schema.items, item, `${path}[${i}]`, root)))
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: ${key} is required`)
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validateJson(schema.properties[key], item, `${path}.${key}`, root))
      else if (schema.additionalProperties === false) errors.push(`${path}: ${key} is not allowed`)
    }
  }
  for (const sub of schema.allOf ?? []) {
    if (!sub.if) errors.push(...validateJson(sub, value, path, root))
    else if (validateJson(sub.if, value, path, root).length === 0 && sub.then) errors.push(...validateJson(sub.then, value, path, root))
  }
  return errors
}

// A reply's JSON. One surrounding ```json fence is tolerated and reported.
export function parseReply(text) {
  const trimmed = String(text ?? '').trim()
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed)
  try {
    return { reply: JSON.parse(fence ? fence[1] : trimmed), fenced: Boolean(fence), errors: [] }
  } catch (error) {
    return { reply: null, fenced: Boolean(fence), errors: [`not JSON: ${error.message}`] }
  }
}

// The reviewer's reply: { valid, errors, fenced, reply }. Ids must be distinct.
export function checkFindings(text, { schema = readSchema(FINDINGS_SCHEMA_PATH) } = {}) {
  const parsed = parseReply(text)
  if (parsed.errors.length > 0) return { valid: false, ...parsed }
  const errors = validateJson(schema, parsed.reply)
  if (errors.length === 0) {
    const seen = new Set()
    for (const f of parsed.reply.findings) {
      if (seen.has(f.id)) errors.push(`$.findings: ${f.id} appears more than once`)
      seen.add(f.id)
    }
  }
  return { valid: errors.length === 0, ...parsed, errors }
}

// The fixer's reply: { valid, errors, fenced, reply }.
export function checkFix(text, { schema = readSchema(FIX_SCHEMA_PATH) } = {}) {
  const parsed = parseReply(text)
  if (parsed.errors.length > 0) return { valid: false, ...parsed }
  const errors = validateJson(schema, parsed.reply)
  return { valid: errors.length === 0, ...parsed, errors }
}

// ---------------------------------------------------------------- verdict and text

// BLOCKED while a finding whose severity is in `blockOn` is open; PASS otherwise.
// `dispositions` maps a finding id to its disposition; fixed, dismissed and accepted close it.
export function computeVerdict(findings, { blockOn = DEFAULT_BLOCK_ON, dispositions = {} } = {}) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
  for (const f of findings) counts[f.severity]++
  const blocking = findings.filter((f) => blockOn.includes(f.severity) && !CLOSED.includes(dispositions[f.id])).map((f) => f.id)
  return { verdict: blocking.length > 0 ? 'BLOCKED' : 'PASS', blocking, counts, blockOn }
}


// The reply as markdown: summary, verdict, counts per severity, the table and each body. The
// text of review.md and of a merge request comment.
export function renderFindings(reply, { blockOn = DEFAULT_BLOCK_ON, dispositions = {} } = {}) {
  const { verdict, blocking, counts } = computeVerdict(reply.findings, { blockOn, dispositions })
  const withDisposition = Object.keys(dispositions).length > 0
  const lines = ['## Summary', '', reply.summary.trim(), '']
  lines.push(`**Verdict:** ${verdict}${blocking.length ? ` (open blocking findings: ${blocking.join(', ')})` : ''}; blocks on ${list(blockOn)}`, '')
  lines.push('| Severity | Count |', '|---|---|', ...SEVERITIES.map((s) => `| ${s} | ${counts[s]} |`), '')
  lines.push('## Findings', '')
  if (reply.findings.length === 0) {
    lines.push('No findings.', '')
    return lines.join('\n')
  }
  lines.push(
    `| ID | Severity | Category | Location | Title |${withDisposition ? ' Disposition |' : ''}`,
    `|---|---|---|---|---|${withDisposition ? '---|' : ''}`,
    ...reply.findings.map((f) => `| ${f.id} | ${f.severity} | ${cell(f.category)} | \`${cell(where(f))}\` | ${cell(f.title)} |${withDisposition ? ` ${cell(dispositions[f.id] ?? 'open')} |` : ''}`),
    ''
  )
  for (const f of reply.findings) {
    lines.push(`### ${f.id}: ${f.title}`, '', `${f.severity}, ${f.category}, \`${where(f)}\`${f.key ? `, key ${f.key}` : ''}`, '', f.body.trim(), '')
    if (f.suggestion) lines.push(`Suggestion: ${f.suggestion.trim()}`, '')
  }
  return lines.join('\n')
}
