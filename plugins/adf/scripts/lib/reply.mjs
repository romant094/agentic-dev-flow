// The replies of the apply roles: a role table `{ schema, check, compute }`. A subagent replies
// with one JSON object under its role's schema in schema/, and the reply states no verdict.
// `check` refuses what the schema cannot see (git, the test-run records, the open findings, the
// sweep's inputs); `compute` gives every verdict from the accepted reply. The dispatch name gives
// the role (lib/dispatch.mjs parseName), and the reply's `role` must be that role.
//
//   role                          schema                   check -> compute
//   impl, fix                     impl.schema.json         commits, test runs, scope -> status
//   review, final-review,         task-review.schema.json  category agrees with kind -> ids,
//     merge-review                                         spec and quality verdicts, result
//   re-review                     re-review.schema.json    the open set answered -> open set
//   sweep                         sweep.schema.json        dispositions -> CLEAN | FINDINGS
//   investigate                   investigate.schema.json  the schema only; nothing computed
//   retro                         retro.schema.json        keys, waiting items, candidate,
//                                                          plugins -> keys resolved, ordered
//
// The schema files are lib/dispatch.mjs APPLY_SCHEMAS (RETRO_ROLES for retro), which also names
// each in the role's prompt. retro serves no change: lib/retro.mjs checks and records it.
//
// The context (`replyContext`) is read once the schema accepts the reply:
//   { root, change, name, parts, planText?, worktree?, scope?, history?, rulings?, sweep?, input? }
// root is the change worktree; worktree the dispatch's own (a group worktree for a task of a
// parallel group); scope the plan tasks whose **Files:** bound the dispatch; history the computed
// results of the subject's accepted reviews in attempts.jsonl; rulings the ledger's last ruling
// of each id on the subject (lib/loop.mjs); sweep lib/sweep.mjs sweepInputs; input a retro's
// input.json (lib/retro.mjs input), whose change is undefined.
//
// The computed results:
//
//   impl, fix
//     { status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT,
//       next: review (impl) | re-review (fix) | read-concerns | provide-context | blocked,
//       commits: [{ sha, subject, files }]   oldest first, read from git,
//       range: { base, head } | null          the review package: the first commit's parent
//                                             to the last commit,
//       tests: { result: pass | fail | null, counts, runs: [{ file, command, exit, counts,
//                failing, timedOut? }] }     the last run by its stamp gives result and counts,
//       concerns: [{ text, file?, source: agent | script }], outOfScope: [file], blocker? }
//     Each commit must lie in the change's commits of the dispatch worktree (the merge-base of
//     the metadata's base with HEAD, to HEAD). A done reply needs a last run that passed (exit 0,
//     not timed out, no failed count) and ran a test (a total of 0 is refused). A last run with
//     no count line, and a file outside the scope's **Files:** (the task's; a group's tasks for
//     `fix <G>`; every task for the final `fix`), are script concerns: DONE_WITH_CONCERNS.
//
//   review, final-review, merge-review
//     { subject, findings: [{ id, ...finding, planMandated }], spec: pass | fail,
//       quality: approved | needs-fixes, open, toRule, deferred: [id], unverifiable,
//       result: rule | fix | clean }
//     Ids are F<k>, after the highest id of the subject (T<n>, a group letter, or `final`), so
//     they stay distinct across rounds. spec fails on any spec finding (category missing, extra,
//     misunderstood); quality needs fixes on a critical or important finding. A plan-mandated
//     finding goes to toRule, a minor quality finding to deferred, every other finding to open,
//     the fix loop's input. result: rule while toRule or unverifiable is not empty (a ruling
//     can add to the fix), else fix while open is not, else clean.
//
//   re-review
//     { subject, previous, addressed: [id], findings, open, toRule, deferred, outOfScope, result }
//     previous must answer exactly the subject's open set (lib/loop.mjs loopState: the last
//     accepted review's or re-review's, with the ledger's rulings on the subject applied); open is
//     its not-addressed ids and the new open findings; result as for a review.
//
//   sweep
//     { verdict: CLEAN | FINDINGS, findings, dropped, dispositions? }
//     Dispositions are required exactly when sweepInputs reports a second question (never for a
//     re-sweep, `sweep r<k>`), one for each REMOVED or RENAMED requirement it lists; no `introduced` or `existing` carries text after
//     its line (lib/sweep.mjs locationErrors); the findings a DUP marker accepts are dropped.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attemptsFile } from './attempts.mjs'
import { globToRegExp } from './changes.mjs'
import { APPLY_SCHEMAS, parseGraph, parseName, planDispatch, RETRO_ROLES, retroInputFile, sddDir } from './dispatch.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { readRecords } from './ledger.mjs'
import { consolidationState, loopState, REVIEW_ROLES, subjectHistory, subjectOf, subjectRulings, subjectSince, SWEEP_SUBJECT } from './loop.mjs'
import { parsePlan, rangeCommits, taskMatchers } from './plan.mjs'
import { readRegistry } from './registry.mjs'
import { check as checkRetro, compute as computeRetro } from './retro.mjs'
import { readTestRecord, recordName, TESTS_DIR } from './suite.mjs'
import { dupFilter, locationErrors, sweepInputs } from './sweep.mjs'
import { relativeFindings } from './dup.mjs'
import { gitIn } from './workspace.mjs'

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema')
export const SPEC_CATEGORIES = ['missing', 'extra', 'misunderstood']
export { REVIEW_ROLES, subjectHistory, subjectOf }

export class ReplyError extends Error {}

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const readOr = (path) => attempt(() => readFileSync(path, 'utf8'))
const real = (path) => attempt(() => realpathSync(path)) ?? resolve(path)

// ---------------------------------------------------------------- reviews

const kindOf = (category) => (SPEC_CATEGORIES.includes(category) ? 'spec' : 'quality')

const findingErrors = (findings, path) =>
  findings.flatMap((f, i) => (kindOf(f.category) === f.kind ? [] : [`${path}[${i}].kind: category ${f.category} is a ${kindOf(f.category)} finding, not ${f.kind}`]))

const highestId = (history) => Math.max(0, ...history.flatMap((r) => r.findings ?? []).map((f) => Number(/^F(\d+)$/.exec(f.id ?? '')?.[1] ?? 0)))

// Numbers the findings after the subject's highest id and sorts them into the loop's routes.
function routeFindings(findings, history) {
  const first = highestId(history) + 1
  const numbered = findings.map((f, i) => ({ id: `F${first + i}`, ...f, planMandated: f.planMandated === true }))
  const toRule = numbered.filter((f) => f.planMandated)
  const deferred = numbered.filter((f) => !f.planMandated && f.severity === 'minor' && f.kind === 'quality')
  const open = numbered.filter((f) => !toRule.includes(f) && !deferred.includes(f))
  const ids = (list) => list.map((f) => f.id)
  return { findings: numbered, open: ids(open), toRule: ids(toRule), deferred: ids(deferred) }
}

const resultOf = ({ open, toRule, unverifiable = [] }) => (toRule.length || unverifiable.length ? 'rule' : open.length ? 'fix' : 'clean')

const review = {
  schema: APPLY_SCHEMAS.review,
  check: (reply) => findingErrors(reply.findings, '$.findings'),
  compute(reply, ctx) {
    const routed = routeFindings(reply.findings, ctx.history)
    return {
      subject: subjectOf(ctx.parts),
      findings: routed.findings,
      spec: reply.findings.some((f) => f.kind === 'spec') ? 'fail' : 'pass',
      quality: reply.findings.some((f) => f.severity === 'critical' || f.severity === 'important') ? 'needs-fixes' : 'approved',
      open: routed.open,
      toRule: routed.toRule,
      deferred: routed.deferred,
      unverifiable: reply.unverifiable,
      result: resultOf({ ...routed, unverifiable: reply.unverifiable })
    }
  }
}

const reReview = {
  schema: APPLY_SCHEMAS['re-review'],
  check(reply, ctx) {
    const errors = findingErrors(reply.findings, '$.findings')
    const subject = subjectOf(ctx.parts)
    // A consolidation's re-review answers the open sweep findings and its own loop's.
    const open = ctx.consolidation ? ctx.consolidation.open : ctx.history.length ? loopState(ctx.history, ctx.rulings).open : undefined
    if (open === undefined) return [...errors, `$.previous: no accepted review of ${subject} is recorded, so there is no open set to answer`]
    const seen = new Set()
    reply.previous.forEach(({ id }, i) => {
      if (seen.has(id)) errors.push(`$.previous[${i}].id: ${id} is answered twice`)
      else if (!open.includes(id)) errors.push(`$.previous[${i}].id: ${id} is not an open finding of ${subject}`)
      seen.add(id)
    })
    for (const id of open) if (!seen.has(id)) errors.push(`$.previous: the open finding ${id} of ${subject} is not answered`)
    return errors
  },
  compute(reply, ctx) {
    const routed = routeFindings(reply.findings, ctx.history)
    const status = (s) => reply.previous.filter((p) => p.status === s).map((p) => p.id)
    // A sweep finding (S<n>) stays the re-sweep's to clear: it is reported, never looped.
    const swept = (id) => id.startsWith('S')
    const open = [...status('not-addressed').filter((id) => !swept(id)), ...routed.open]
    return {
      subject: subjectOf(ctx.parts),
      previous: reply.previous,
      addressed: status('addressed'),
      ...(ctx.consolidation ? { notConsolidated: status('not-addressed').filter(swept) } : {}),
      findings: routed.findings,
      open,
      toRule: routed.toRule,
      deferred: routed.deferred,
      outOfScope: reply.outOfScope,
      result: resultOf({ open, toRule: routed.toRule })
    }
  }
}

// ---------------------------------------------------------------- impl and fix

// A covering run passed: it finished with exit 0 and its runner counted no failure.
const passed = (run) => run.exit === 0 && !run.timedOut && !(run.counts && run.counts.fail > 0)

function readCommits(reply, ctx, git, errors) {
  if (reply.commits.length === 0) return []
  const range = rangeCommits(ctx.worktree, ctx.change, { git })
  const order = range.commits.map((c) => c.sha)
  const filesOf = new Map(range.commits.map((c) => [c.sha, c.files]))
  const shas = []
  reply.commits.forEach((sha, i) => {
    const full = attempt(() => git('rev-parse', '--verify', '--quiet', `${sha}^{commit}`))
    if (!full) errors.push(`$.commits[${i}]: ${sha} is no commit in ${ctx.worktree}`)
    else if (!filesOf.has(full)) errors.push(`$.commits[${i}]: ${sha} lies outside ${range.base}..HEAD, the change's commits in ${ctx.worktree}`)
    else if (shas.includes(full)) errors.push(`$.commits[${i}]: ${sha} is named twice`)
    else shas.push(full)
  })
  shas.sort((a, b) => order.indexOf(b) - order.indexOf(a))
  const subjects = new Map()
  if (shas.length) {
    for (const line of git('show', '-s', '--format=%H%x1f%s', ...shas).split('\n')) {
      const [sha, subject] = line.split('\x1f')
      subjects.set(sha, subject ?? '')
    }
  }
  return shas.map((sha) => ({ sha, subject: subjects.get(sha) ?? '', files: filesOf.get(sha) }))
}

function readRuns(reply, ctx, errors) {
  const testsDir = join(sddDir(ctx.root, ctx.change), TESTS_DIR)
  const stem = `${recordName(ctx.name)}-`
  const runs = []
  ;(reply.testRuns ?? []).forEach((file, i) => {
    const path = resolve(ctx.root, file)
    const rel = relative(testsDir, path)
    if (rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) return errors.push(`$.testRuns[${i}]: ${file} is not a test-run record under ${relative(ctx.root, testsDir)}/`)
    if (!basename(path).startsWith(stem)) return errors.push(`$.testRuns[${i}]: ${file} is the record of another dispatch, not of ${ctx.name}`)
    let record
    try {
      record = readTestRecord(path)
    } catch (error) {
      return errors.push(`$.testRuns[${i}]: ${error.message}`)
    }
    if (real(record.worktree) !== real(ctx.worktree)) return errors.push(`$.testRuns[${i}]: ${file} ran in ${record.worktree}, not in ${ctx.worktree}, this dispatch's worktree`)
    runs.push({ file: relative(ctx.root, path), command: record.command, exit: record.exit, counts: record.counts, failing: record.failing, ...(record.timedOut ? { timedOut: true } : {}) })
  })
  return runs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

// What git and the test-run records say about an impl or fix reply: { errors, commits, runs,
// last, concerns, outOfScope }. Memoised per reply object, since check and compute both read it.
const FACTS = new WeakMap()
function implFacts(reply, ctx) {
  if (FACTS.has(reply)) return FACTS.get(reply)
  const errors = []
  const git = gitIn(ctx.worktree)
  const commits = readCommits(reply, ctx, git, errors)
  const runs = readRuns(reply, ctx, errors)
  const last = runs.at(-1)

  const concerns = reply.concerns.map((c) => ({ ...c, source: 'agent' }))
  if (reply.outcome === 'done' && reply.commits.length === 0) {
    const task = ctx.parts.role === 'impl' ? parsePlan(ctx.planText).tasks.find((t) => t.number === ctx.parts.task) : null
    if (!task?.commitsNothing) {
      errors.push(`$.commits: a done reply names at least one commit${task ? `; Task ${task.number}'s Commit step does not say none` : ''}`)
    }
  }
  if (reply.outcome === 'done' && last) {
    if (!passed(last)) {
      const how = last.timedOut ? 'timed out' : `exit ${last.exit}${last.failing.length ? `, failing ${last.failing.join(', ')}` : ''}`
      errors.push(`$.testRuns: the last covering run ${last.file} failed (${how}); a done reply needs a passing run`)
    } else if (last.counts?.total === 0) errors.push(`$.testRuns: the last covering run ${last.file} ran no test`)
    else if (last.counts === null) concerns.push({ text: `the last covering run ${last.file} printed no count line, so what it ran is unconfirmed`, file: last.file, source: 'script' })
  }

  const covers = taskMatchers(parsePlan(ctx.planText).tasks)
    .filter((t) => ctx.scope.includes(t.number))
    .flatMap((t) => t.covers)
  const prefix = `openspec/changes/${ctx.change}/`
  const allowed = (readRegistry(ctx.root)?.outsidePlan ?? []).map((g) => globToRegExp(g))
  // A consolidation's fix also works in the duplicate's files (lib/loop.mjs consolidationState).
  const own = new Set(ctx.consolidation?.files ?? [])
  const exempt = (file) => file.startsWith(prefix) || own.has(file) || allowed.some((re) => re.test(file)) || covers.some((c) => c(file))
  const outOfScope = [...new Set(commits.flatMap((c) => c.files))].filter((file) => !exempt(file))
  const scopeName = ctx.parts.task !== undefined ? `Task ${ctx.parts.task}` : ctx.parts.group !== undefined ? `group ${ctx.parts.group}'s tasks` : 'any task of the plan'
  for (const file of outOfScope) concerns.push({ text: `changed outside the **Files:** of ${scopeName}`, file, source: 'script' })

  const facts = { errors, commits, runs, last, concerns, outOfScope }
  FACTS.set(reply, facts)
  return facts
}

const STATUS = { blocked: 'BLOCKED', 'needs-context': 'NEEDS_CONTEXT' }
const NEXT = { BLOCKED: 'blocked', NEEDS_CONTEXT: 'provide-context', DONE_WITH_CONCERNS: 'read-concerns' }

const impl = {
  schema: APPLY_SCHEMAS.impl,
  check: (reply, ctx) => implFacts(reply, ctx).errors,
  compute(reply, ctx) {
    const { commits, runs, last, concerns, outOfScope } = implFacts(reply, ctx)
    const status = STATUS[reply.outcome] ?? (concerns.length ? 'DONE_WITH_CONCERNS' : 'DONE')
    const base = commits.length ? attempt(() => gitIn(ctx.worktree)('rev-parse', `${commits[0].sha}^`)) : null
    return {
      status,
      next: NEXT[status] ?? (ctx.parts.role === 'fix' ? 're-review' : 'review'),
      commits,
      range: base ? { base, head: commits.at(-1).sha } : null,
      tests: { result: last ? (passed(last) ? 'pass' : 'fail') : null, counts: last?.counts ?? null, runs },
      concerns,
      outOfScope,
      ...(reply.blocker ? { blocker: reply.blocker } : {})
    }
  }
}

// ---------------------------------------------------------------- sweep

const sweep = {
  schema: APPLY_SCHEMAS.sweep,
  check(reply, ctx) {
    const listed = ctx.sweep.removedOrRenamed.map((r) => r.requirement ?? r.from)
    const given = reply.dispositions ?? []
    const located = locationErrors(reply.findings, ctx.root)
    const none = ctx.sweep.reSweep !== undefined ? 'a re-sweep answers no dispositions question' : 'the change lists no REMOVED or RENAMED requirement'
    if (!ctx.sweep.secondQuestion) return [...located, ...(given.length ? [`$.dispositions: ${none}, so the reply gives no disposition`] : [])]
    if (reply.dispositions === undefined) return [...located, `$.dispositions: required, one for each REMOVED or RENAMED requirement: ${listed.join(', ')}`]
    const errors = [...located]
    const seen = new Set()
    given.forEach(({ requirement }, i) => {
      if (!listed.includes(requirement)) errors.push(`$.dispositions[${i}].requirement: ${requirement} is no REMOVED or RENAMED requirement of the change`)
      else if (seen.has(requirement)) errors.push(`$.dispositions[${i}].requirement: ${requirement} is answered twice`)
      seen.add(requirement)
    })
    for (const requirement of listed) if (!seen.has(requirement)) errors.push(`$.dispositions: ${requirement} has no disposition`)
    return errors
  },
  compute: (reply, ctx) => ({ ...dupFilter(ctx.root, relativeFindings(ctx.root, reply.findings)), ...(reply.dispositions ? { dispositions: reply.dispositions } : {}) })
}

// ---------------------------------------------------------------- the table

export const ROLES = {
  impl,
  fix: impl,
  review,
  'final-review': review,
  'merge-review': review,
  're-review': reReview,
  sweep,
  investigate: { schema: APPLY_SCHEMAS.investigate, check: () => [], compute: () => undefined },
  retro: { schema: RETRO_ROLES.retro.schema, check: (reply, ctx) => checkRetro(reply, ctx.input), compute: (reply, ctx) => computeRetro(reply, ctx.input) }
}

export const schemaOf = (role) => readSchema(join(SCHEMA_DIR, ROLES[role].schema))

// The tasks whose **Files:** bound a dispatch: its task, its group's tasks, or every task.
function scopeOf(planText, parts) {
  if (parts.task !== undefined) return [parts.task]
  if (parts.group !== undefined) return parseGraph(planText).find((g) => g.letter === parts.group)?.tasks ?? []
  return parsePlan(planText).tasks.map((t) => t.number)
}

// What the checker of `name`'s role reads besides the reply. Throws a ReplyError when the name is
// no reply role's or does not fit the change (no plan, a task or group the plan lacks).
export function replyContext(root, change, name, { main = root } = {}) {
  const parts = parseName(name)
  if (!parts || !Object.hasOwn(ROLES, parts.role)) throw new ReplyError(`"${name}" is not the dispatch name of a reply role (${Object.keys(ROLES).join(', ')})`)
  const ctx = { root, change, name, parts }
  try {
    if (parts.role === 'impl' || parts.role === 'fix') {
      const planText = readOr(join(root, 'openspec', 'changes', change, 'plan.md'))
      if (planText === null) throw new Error(`openspec/changes/${change}/plan.md does not exist`)
      const plan = planDispatch({ change, ...parts }, { root, main, planText, exists: existsSync })
      Object.assign(ctx, { planText, worktree: plan.worktree, scope: scopeOf(planText, parts) })
    }
    if ([...REVIEW_ROLES, 're-review'].includes(parts.role)) {
      // The final review's loop counts from the current apply round (lib/loop.mjs subjectSince).
      const records = readRecords(root, change)
      const since = subjectSince(records, subjectOf(parts))
      ctx.history = subjectHistory(readOr(attemptsFile(root, change)) ?? '', subjectOf(parts), since)
      ctx.rulings = subjectRulings(records, subjectOf(parts), since)
    }
    if (parts.subject === SWEEP_SUBJECT) ctx.consolidation = consolidationState(root, change)
    if (parts.role === 'sweep') ctx.sweep = sweepInputs(root, change, { reSweep: parts.round })
    if (parts.role === 'retro') {
      const text = readOr(retroInputFile(root, parts.id))
      if (text === null) throw new Error(`${retroInputFile(root, parts.id)} does not exist: write the retrospective's input first`)
      ctx.input = JSON.parse(text)
    }
  } catch (error) {
    throw new ReplyError(error.message)
  }
  return ctx
}

// One reply's text checked as `role`: { valid, errors, result, fenced }. `context` is the
// replyContext, or a function giving it, called only once the schema accepts the reply. `result`
// is the computed result of a valid reply (undefined for investigate), null for a refused one.
export function checkReply(role, text, context) {
  if (!Object.hasOwn(ROLES, role)) throw new ReplyError(`role ${role} has no reply checker; known: ${Object.keys(ROLES).join(', ')}`)
  const parsed = parseReply(text)
  const refuse = (errors) => ({ valid: false, errors, result: null, fenced: parsed.fenced })
  if (parsed.errors.length) return refuse(parsed.errors)
  const errors = validateJson(schemaOf(role), parsed.reply)
  if (errors.length === 0 && parsed.reply.role !== role) errors.push(`$.role: must be ${role}, the role of this dispatch`)
  if (errors.length) return refuse(errors)
  const ctx = typeof context === 'function' ? context() : context
  const { check, compute } = ROLES[role]
  const checked = check(parsed.reply, ctx)
  if (checked.length) return refuse(checked)
  return { valid: true, errors: [], result: compute(parsed.reply, ctx), fenced: parsed.fenced }
}
