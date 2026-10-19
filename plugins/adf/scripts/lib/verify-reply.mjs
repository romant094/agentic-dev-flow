// The replies of the verify dispatches, `verify c4` and `verify c8`: one JSON object under
// schema/verify-c4.schema.json or verify-c8.schema.json, checked by script against what the script
// itself lists, recorded through the shared attempts log (lib/attempts.mjs recordReply), and turned
// into the section `<verify>/<id>.json` that `verify.mjs verdict` reads. The reply states no
// verdict: the script computes it.
//
//   verify c4   the script lists the commits of the range that edit a capability's spec.md, with
//               each edit's position against `## Requirements` (proseEditsIn), and the REMOVED and
//               RENAMED requirements of the deltas (lib/sweep.mjs sweepInputs). The reply's
//               `proseEdits` and `removalAccounting` must answer each listed entry exactly once,
//               and its `case` must be the one the change's files give.
//               fail: a finding of a FAIL_KIND, an edit at or below `## Requirements`, a removal
//               with no Code Disposition, one the code contradicts, or one whose old path is
//               still reachable;
//               warn: a finding of a WARN_KIND, an edit with no stated reason, a path of a new
//               mechanism nothing exercised (`exercisedBy: null`);
//               pass: anything else.
//   verify c8   each candidate line of `<verify>/c8-candidates.json` (verify.mjs prompts writes it
//               with the .txt the agent reads) is answered exactly once; a CONFIRMED item carries a
//               patch that touches its skill file, stays under .claude/skills/ and passes
//               `git apply --check` in <root>, alone and joined with the others; no other item
//               carries a patch. The patches are joined into `<verify>/c8.diff`, the default diff
//               of `verify.mjs skill-edit`.
//               fail: a CONFIRMED item; warn: a PLAUSIBLE item; pass: anything else. A developer's
//               ruling on c8 (a declined edit) is applied by the verdict, as for every check.
//
// The retry of a refused reply follows the shared rule; its count starts again with each verify
// session, at `started` in run.json (lib/verify.mjs runChecks).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { attemptsFile, readLog, recordReply, standing } from './attempts.mjs'
import { changeDir } from './changes.mjs'
import { DispatchError, parseName, VERIFY_CHECKS } from './dispatch.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { sweepInputs } from './sweep.mjs'
import { applyCheck, C8_CANDIDATES, C8_DIFF, patchPaths, resolveBase, SKILLS_DIR, verifyDir } from './verify.mjs'
import { gitIn } from './workspace.mjs'

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
export const TITLES = { c4: 'Design and specs coherence', c8: 'Stale skills' }
export const schemaPath = (check) => join(SCHEMA_DIR, `verify-${check}.schema.json`)
export const FAIL_KINDS = ['exec-contradiction', 'prose-edit-below-requirements', 'disposition-contradicted', 'disposition-missing', 'old-path-reachable']
// Drift between two documents is a warning (schema/instructions/verify.md, verify c4): a decision
// no requirement traces, and a requirement that contradicts a decision, are drift between the
// design and the specs.
export const WARN_KINDS = ['doc-drift', 'prose-edit-unstated', 'decision-untraced', 'requirement-contradicts-decision']

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const readOr = (path) => attempt(() => readFileSync(path, 'utf8'))
const rawGit = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const short = (sha) => sha.slice(0, 7)
const REQUIREMENTS = /^##\s+Requirements\s*$/i
const SPEC_FILE = /^openspec\/specs\/([^/]+)\/spec\.md$/

// ---------------------------------------------------------------- what the script lists

// Where one commit's edit of a capability spec lies: `below` when a hunk touches the
// `## Requirements` heading or anything after it, when the commit adds or deletes the file, or
// when it removes the heading; `above` otherwise.
function editPosition(root, sha, file) {
  const post = attempt(() => rawGit(root, 'show', `${sha}:${file}`))
  const pre = attempt(() => rawGit(root, 'show', `${sha}^:${file}`))
  if (post === null || pre === null) return 'below'
  const header = post.split('\n').findIndex((l) => REQUIREMENTS.test(l)) + 1
  if (header === 0) return pre.split('\n').some((l) => REQUIREMENTS.test(l)) ? 'below' : 'above'
  const diff = rawGit(root, 'diff', '--no-color', '--no-ext-diff', '-U0', `${sha}^`, sha, '--', file)
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    // A pure deletion (+c,0) removed lines after new line c.
    const last = count === 0 ? start : start + count - 1
    if (last >= header) return 'below'
  }
  return 'above'
}

// The commits of the change's range that edit `openspec/specs/<capability>/spec.md`, oldest
// first: [{ capability, commit, file, position: above | below }].
export function proseEditsIn(root, change) {
  const git = gitIn(root)
  const base = resolveBase(root, change, git)
  if (base.error) throw new Error(`no commit range: ${base.error}`)
  const log = rawGit(root, 'log', '--no-renames', '--name-only', '--format=%x1e%H', `${base.ref}..HEAD`, '--', 'openspec/specs')
  const out = []
  for (const chunk of log.split('\x1e').map((c) => c.trim()).filter(Boolean).reverse()) {
    const [sha, ...files] = chunk.split('\n').map((l) => l.trim())
    for (const file of files) {
      const m = SPEC_FILE.exec(file)
      if (m) out.push({ capability: m[1], commit: sha, file, position: editPosition(root, sha, file) })
    }
  }
  return out
}

// The REMOVED and RENAMED requirements of the change's deltas, keyed as the sweep keys them
// (a RENAMED requirement by its TO name): [{ op, requirement, from?, spec, codeDisposition }].
export function removalsOf(root, change) {
  return sweepInputs(root, change).removedOrRenamed.map((r) => ({
    op: r.op,
    requirement: r.requirement ?? r.from,
    ...(r.from ? { from: r.from } : {}),
    spec: r.spec,
    codeDisposition: r.codeDisposition
  }))
}

function hasMarkdown(dir) {
  if (!existsSync(dir)) return false
  return readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasMarkdown(join(dir, e.name)) : e.name.endsWith('.md')))
}

// The case c4 covers, from the change's files: null when neither a design nor a delta exists,
// where either reading stands.
export function c4Case(root, change) {
  const dir = changeDir(root, change)
  const design = existsSync(join(dir, 'design.md'))
  const deltas = hasMarkdown(join(dir, 'specs'))
  if (design && deltas) return 'both'
  if (design) return 'no-deltas'
  if (deltas) return 'no-design'
  return null
}

// What the c4 prompt names and its reply is checked against.
export function c4Inputs(root, change) {
  return { case: c4Case(root, change), proseEdits: proseEditsIn(root, change), removals: removalsOf(root, change) }
}

export const candidatesFile = (root, change) => join(verifyDir(root, change), C8_CANDIDATES)

// The candidate lines verify.mjs prompts listed: [{ file, line, text }].
export function c8Inputs(root, change) {
  const file = candidatesFile(root, change)
  const text = readOr(file)
  if (text === null) throw new DispatchError(`no ${file}: run verify.mjs prompts (or skill-candidates) first`)
  return { candidates: JSON.parse(text).candidates }
}

// ---------------------------------------------------------------- check and compute

// Each listed key answered exactly once: the errors, with `path` the reply's array.
function answered(path, given, listed, describe) {
  const errors = []
  const seen = new Set()
  given.forEach((key, i) => {
    if (key === null) return
    if (!listed.includes(key)) errors.push(`${path}[${i}]: ${describe(key)} is not one the script listed`)
    else if (seen.has(key)) errors.push(`${path}[${i}]: ${describe(key)} is answered twice`)
    seen.add(key)
  })
  for (const key of listed) if (!seen.has(key)) errors.push(`${path}: ${describe(key)} is not answered`)
  return errors
}

const c4 = {
  check(reply, ctx) {
    const errors = []
    if (ctx.case !== null && reply.case !== ctx.case) errors.push(`$.case: the change's files give "${ctx.case}", not "${reply.case}"`)
    reply.findings.forEach((f, i) => {
      if (f.kind === 'doc-drift' && f.where.length < 2) errors.push(`$.findings[${i}].where: a doc-drift names both sides, a file and a line on each`)
    })
    const full = (sha) => attempt(() => gitIn(ctx.root)('rev-parse', '--verify', '--quiet', `${sha}^{commit}`))
    const edits = reply.proseEdits.map((p, i) => {
      const sha = full(p.commit)
      if (!sha) errors.push(`$.proseEdits[${i}].commit: ${p.commit} is no commit`)
      return sha ? `${p.capability} ${sha}` : null
    })
    const listedEdits = ctx.proseEdits.map((p) => `${p.capability} ${p.commit}`)
    errors.push(...answered('$.proseEdits', edits, listedEdits, (k) => { const [cap, sha] = k.split(' '); return `the edit of ${cap} in ${short(sha)}` }))
    const removals = reply.removalAccounting.map((r) => `${r.op} ${r.requirement}`)
    errors.push(...answered('$.removalAccounting', removals, ctx.removals.map((r) => `${r.op} ${r.requirement}`), (k) => k))
    return errors
  },
  compute(reply, ctx) {
    const fail = []
    const warn = []
    const where = (f) => f.where.map((w) => (Number.isInteger(w.line) ? `${w.file}:${w.line}` : w.file)).join(', ')
    for (const f of reply.findings) {
      if (FAIL_KINDS.includes(f.kind)) fail.push(`${f.kind} at ${where(f)}`)
      else if (WARN_KINDS.includes(f.kind)) warn.push(`${f.kind} at ${where(f)}`)
    }
    const position = new Map(ctx.proseEdits.map((p) => [`${p.capability} ${p.commit}`, p.position]))
    const proseEdits = reply.proseEdits.map((p) => {
      const commit = gitIn(ctx.root)('rev-parse', `${p.commit}^{commit}`)
      return { capability: p.capability, commit, position: position.get(`${p.capability} ${commit}`), reason: p.reason }
    })
    for (const p of proseEdits) {
      if (p.position === 'below') fail.push(`an edit of ${p.capability} at or below ## Requirements in ${short(p.commit)}`)
      else if (p.reason === null) warn.push(`an edit of ${p.capability} in ${short(p.commit)} with no stated reason`)
    }
    const spec = new Map(ctx.removals.map((r) => [`${r.op} ${r.requirement}`, r]))
    for (const r of reply.removalAccounting) {
      const name = `${r.op} ${r.requirement}`
      if (r.disposition === null || spec.get(name)?.codeDisposition === null) fail.push(`${name} has no Code Disposition`)
      if (!r.holds) fail.push(`the code contradicts the disposition of ${name}`)
      if (r.oldPathReachable) fail.push(`the old path of ${name} is still reachable`)
    }
    for (const e of reply.exercised) if (e.exercisedBy === null) warn.push(`nothing exercised ${e.mechanism}: ${e.path}`)
    const verdict = fail.length ? 'fail' : warn.length ? 'warn' : 'pass'
    return { check: 'c4', verdict, summary: summaryOf(fail, warn, reply.summary), fail, warn, proseEdits }
  }
}

function summaryOf(fail, warn, text) {
  const parts = []
  if (fail.length) parts.push(`fails: ${fail.join('; ')}`)
  if (warn.length) parts.push(`warns: ${warn.join('; ')}`)
  return parts.length ? `${parts.join('. ')}. ${text}` : text
}

const c8 = {
  check(reply, ctx) {
    const errors = []
    const keys = reply.candidates.map((c) => `${c.file}:${c.line}`)
    errors.push(...answered('$.candidates', keys, ctx.candidates.map((c) => `${c.file}:${c.line}`), (k) => `the candidate ${k}`))
    const patches = []
    reply.candidates.forEach((c, i) => {
      const path = `$.candidates[${i}].patch`
      if (c.class !== 'CONFIRMED') {
        if (c.patch !== undefined) errors.push(`${path}: only a CONFIRMED item carries a patch`)
        return
      }
      const patch = c.patch.endsWith('\n') ? c.patch : `${c.patch}\n`
      let paths
      try {
        paths = patchPaths(ctx.root, patch)
      } catch (error) {
        return errors.push(`${path}: git apply cannot read it: ${String(error.stderr || error.message).trim()}`)
      }
      const outside = paths.filter((p) => !p.startsWith(SKILLS_DIR))
      if (outside.length) return errors.push(`${path}: it touches paths outside ${SKILLS_DIR}: ${outside.join(', ')}`)
      if (!paths.includes(c.file)) errors.push(`${path}: it does not edit ${c.file}, the candidate's skill file`)
      const failed = applyCheck(ctx.root, patch)
      if (failed) errors.push(`${path}: git apply --check refuses it in ${ctx.root}: ${failed}`)
      patches.push(patch)
    })
    if (errors.length === 0 && patches.length > 1) {
      const failed = applyCheck(ctx.root, patches.join(''))
      if (failed) errors.push(`$.candidates: the CONFIRMED patches do not apply together (git apply --check: ${failed}); give the edits of one file as one patch`)
    }
    return errors
  },
  compute(reply) {
    const of = (cls) => reply.candidates.filter((c) => c.class === cls).map((c) => ({ file: c.file, line: c.line }))
    const confirmed = of('CONFIRMED')
    const plausible = of('PLAUSIBLE')
    const fail = confirmed.map((c) => `CONFIRMED ${c.file}:${c.line}`)
    const warn = plausible.map((c) => `PLAUSIBLE ${c.file}:${c.line}`)
    const verdict = fail.length ? 'fail' : warn.length ? 'warn' : 'pass'
    return { check: 'c8', verdict, summary: summaryOf(fail, warn, reply.summary), fail, warn, confirmed, plausible }
  }
}

const CHECKERS = { c4, c8 }

// What the checker of `check` reads besides the reply.
export function verifyContext(root, change, check) {
  return { root, change, ...(check === 'c4' ? c4Inputs(root, change) : c8Inputs(root, change)) }
}

// One reply's text checked as `verify <check>`: { valid, errors, result, fenced, reply }.
// `context` is the verifyContext, or a function giving it, called once the schema accepts the reply.
export function checkVerifyReply(check, text, context) {
  if (!Object.hasOwn(CHECKERS, check)) throw new DispatchError(`verify ${check} has no reply checker; known: ${Object.keys(CHECKERS).join(', ')}`)
  const parsed = parseReply(text)
  const refuse = (errors) => ({ valid: false, errors, result: null, fenced: parsed.fenced, reply: parsed.reply })
  if (parsed.errors.length) return refuse(parsed.errors)
  const errors = validateJson(readSchema(schemaPath(check)), parsed.reply)
  if (errors.length) return refuse(errors)
  const ctx = typeof context === 'function' ? context() : context
  const checked = CHECKERS[check].check(parsed.reply, ctx)
  if (checked.length) return refuse(checked)
  return { valid: true, errors: [], result: CHECKERS[check].compute(parsed.reply, ctx), fenced: parsed.fenced, reply: parsed.reply }
}

// ---------------------------------------------------------------- record

// The time the current verify session started (run.json `started`, its `at` for a run.json written
// before the field), or a refusal when no run is recorded.
export function sessionStart(root, change) {
  const text = readOr(join(verifyDir(root, change), 'run.json'))
  if (text === null) throw new DispatchError(`no ${join(verifyDir(root, change), 'run.json')}: run verify.mjs run first`)
  const run = JSON.parse(text)
  return run.started ?? run.at ?? null
}

const rel = (root, path) => relative(root, path).split('\\').join('/')

// `dispatch.mjs reply` for `verify c4` and `verify c8`: checks the reply, records its event, and on
// a valid one writes the section `<verify>/<id>.json` { id, title, verdict, summary, output, reply,
// result } (output and reply both the reply file, relative to <root>) and, for c8, `<verify>/c8.diff`
// (removed when nothing is CONFIRMED). Returns recordReply's result with `result` and `section`.
export function recordVerifyReply(rootArg, change, { name, file, resume = true, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  const parts = parseName(name)
  if (parts?.role !== 'verify' || !Object.hasOwn(VERIFY_CHECKS, parts.check)) throw new DispatchError(`"${name}" is not a verify dispatch name`)
  const { check } = parts
  const since = sessionStart(root, change)
  const path = resolve(root, file)
  const stopped = standing(readLog(attemptsFile(root, change)), name, { since }).next === 'stop'
  if (stopped) return recordReply(root, change, { name, file: path, since, now })
  const text = readOr(path)
  const checked = text === null ? { valid: false, errors: [`no reply file ${path}: a reply that is prose and no file is a refusal`], result: null } : checkVerifyReply(check, text, () => verifyContext(root, change, check))
  const result = checked.valid ? checked.result : undefined
  const dir = verifyDir(root, change)
  const diff = join(dir, C8_DIFF)
  const patches = checked.valid && check === 'c8' ? checked.reply.candidates.filter((c) => c.class === 'CONFIRMED').map((c) => (c.patch.endsWith('\n') ? c.patch : `${c.patch}\n`)) : []
  if (checked.valid && check === 'c8') result.diff = patches.length ? rel(root, diff) : null
  const recorded = recordReply(root, change, { name, file: path, errors: checked.errors, result, resume, since, now })
  if (!checked.valid) return recorded
  mkdirSync(dir, { recursive: true })
  if (check === 'c8') {
    if (patches.length) writeFileSync(diff, patches.join(''))
    else rmSync(diff, { force: true })
  }
  const section = { id: check, title: TITLES[check], verdict: result.verdict, summary: result.summary, output: rel(root, path), reply: rel(root, path), result }
  const sectionFile = join(dir, `${check}.json`)
  writeFileSync(sectionFile, `${JSON.stringify(section, null, 2)}\n`)
  return { ...recorded, result, section: rel(root, sectionFile) }
}
