// /adf:archive's deterministic steps, each a function that records its own state, so archive
// resumes from the step that failed and a re-run of a finished step changes nothing.
//
// The steps, in order: check, placements, merge, move, commit-specs, ingest, commit-memory, mr,
// merge-local, remove. A step runs only when every step before it is settled (`done`,
// `degraded` or `skipped`); a `done` or `skipped` step is reported as it is, never run again; a
// `failed` step, and a `degraded` one, runs again. The state is kept per change in the main
// checkout's `.superpowers/sdd/<change>/archive/state.json`: the change directory moves at
// `move`, and the worktree, with its own `.superpowers/`, is removed at `remove`; the main
// checkout's copy outlives both. The final report is built last, from the states alone.
//
// What each step reads and writes:
//   check         the review record through review-state's checkRecord: PASS only (one
//                 verdict route: a developer ruling with a reason makes the computed verdict
//                 PASS), the record committed, the reviewed commit read and an ancestor of HEAD,
//                 no commit after it touching anything but the record (`git log <sha>..HEAD --
//                 . ':(exclude)<record>'`), the refusal naming the change root and the
//                 repository root; artifacts not done and unchecked tasks are `warnings`.
//   placements    every debt record with no `resolve`, every recorded or accepted review finding
//                 with no `resolve --finding`, and every `deviation` cited by no `debt` (its
//                 `what` or `reason` names the deviation id, as in "forced deviation-1") and no
//                 `ruling` (its `finding` is the deviation id). Anything listed refuses. On a
//                 pass the debt tree's uncommitted files are recorded: they are the placement's.
//   merge         lib/specs.mjs writeMerge, after the preview: a conflict writes its texts for the
//                 `spec-merge <capability>` dispatch and fails the step; a new capability's
//                 placeholder Purpose refuses until `--purpose <capability>=<file>` gives it.
//   move          lib/changes.mjs archiveChange: the ledger copied once, the directory moved.
//   commit-specs  `docs(specs): archive <name>`: the old and the new change directory and the
//                 main spec files of the change's capabilities, only those paths.
//   ingest        the ingest reply (lib/ingest.mjs checkIngestFile), the log written through the
//                 knowledge role's `log`; with no knowledge provider the step is `skipped`.
//   commit-memory `docs(memory): ingest what <name> taught`: only the paths the ingest and the
//                 placement wrote.
//   mr            the forge role's `finalize`; `none` is `skipped`, `degraded` keeps the role's
//                 fallback file and the step is `degraded`.
//   merge-local   with no forge only, after the developer's yes: `git merge --no-ff <branch>` in
//                 the main checkout when it has the base checked out and is clean; nothing pushed,
//                 the branch kept.
//   remove        lib/workspace.mjs remove, from the main checkout.
//
// A commit step refuses, naming them, the uncommitted files of the change tree, the main specs,
// the knowledge base and the debt tree that it did not write and that no later step will commit:
// the origin staged whole trees and committed other people's work with its own.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { archiveChange, CHANGES_DIR, changeStatus, globToRegExp, META_FILE, parseTasks } from './changes.mjs'
import { readBranches } from './branches.mjs'
import { commitPaths } from './commit.mjs'
import { dispatchName } from './dispatch.mjs'
import { checkIngestFile, findChangeDir, workingChanges } from './ingest.mjs'
import { mainCheckout } from './installed.mjs'
import { readRecords, unresolvedDebt } from './ledger.mjs'
import { readDebtRoot } from './registry.mjs'
import { checkRecord } from './review-state.mjs'
import { callRole, CORE, forgeInput, forgeReport, knowledgeReport } from './roles.mjs'
import { checkResolutions, mergePreview, writeMerge } from './specs.mjs'
import { writeConflictTexts } from './spec-merge.mjs'
import { loadSchema } from './schema.mjs'
import { remove as removeWorktree } from './workspace.mjs'

export const STEPS = ['check', 'placements', 'merge', 'move', 'commit-specs', 'ingest', 'commit-memory', 'mr', 'merge-local', 'remove']
export const STEP_STATES = ['pending', 'done', 'degraded', 'failed', 'skipped']
const SETTLED = new Set(['done', 'degraded', 'skipped'])
const FINAL = new Set(['done', 'skipped'])

export class Refusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}

const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

// ---------------------------------------------------------------- state

export const archiveDir = (main, change) => join(main, '.superpowers', 'sdd', change, 'archive')
export const statePath = (main, change) => join(archiveDir(main, change), 'state.json')
// Where the orchestrator writes the merge request body: ignored by git, and kept past the
// worktree's removal.
export const bodyPath = (main, change) => join(archiveDir(main, change), 'merge-request.md')

export function readArchiveState(main, change) {
  const path = statePath(main, change)
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return { change, steps: Object.fromEntries(STEPS.map((s) => [s, saved.steps?.[s] ?? { state: 'pending' }])) }
}

function saveStep(main, change, step, record) {
  const state = readArchiveState(main, change)
  state.steps[step] = record
  const path = statePath(main, change)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return state
}

export const nextStep = (state) => STEPS.find((s) => !SETTLED.has(state.steps[s].state)) ?? null
// Whether archive of this change has started: any step settled.
export const archiveStarted = (state) => STEPS.some((s) => SETTLED.has(state.steps[s].state))

// ---------------------------------------------------------------- context

function gitReader(root) {
  return (what, ...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trimEnd()
    } catch (error) {
      return refuse(`git failed to ${what} (${String(error.stderr || error.message).trim()}); check that ${root} is a git working tree and run again`)
    }
  }
}

// Exit status of a git call whose answer is its status (`merge-base --is-ancestor`): 0 yes, 1 no;
// anything else is a failed read and refuses.
function gitAsk(root, what, ...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (run.status === 0 || run.status === 1) return run.status === 0
  return refuse(`git failed to ${what} (${String(run.stderr || run.error?.message || `exit ${run.status}`).trim()}); run again`)
}

// deps: { now() -> Date, home, knowledge() -> context result, knowledgeLog(input) -> log result,
// forge(operation, input) -> role result, fault(step) }. `fault` lets a test fail a step.
export function archiveContext(rootArg, change, deps = {}) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(change ?? '')) refuse(`change name "${change}" is not kebab-case; pass the resolved change name`)
  const given = resolve(rootArg)
  if (!existsSync(given)) refuse(`${given} does not exist; pass the change worktree as --root`)
  const root = realpathSync(given)
  const core = { ...CORE, ...(deps.home ? { home: deps.home } : {}) }
  let context = null
  const ctx = {
    root,
    change,
    main: realpathSync(mainCheckout(root)),
    git: gitReader(root),
    now: deps.now ?? (() => new Date()),
    fault: deps.fault ?? null,
    knowledge: () => (context ??= (deps.knowledge ?? (() => callRole(root, 'knowledge', 'context', {}, core)))()),
    knowledgeLog: deps.knowledgeLog ?? ((input) => callRole(root, 'knowledge', 'log', input, core)),
    forge: deps.forge ?? ((operation, input) => callRole(root, 'forge', operation, input, core))
  }
  return ctx
}

// ---------------------------------------------------------------- running a step

// Runs one step under the state rules. `fn(state)` returns { state, detail, refusal?, out? } or
// { hold: true, out } (nothing recorded), or throws; a throw records `failed` with its message.
// Returns { ok, change, step, state, detail, next, already?, refusal?, ...out }.
export function runStep(ctx, step, fn) {
  if (!STEPS.includes(step)) throw new Error(`no archive step "${step}"`)
  const before = readArchiveState(ctx.main, ctx.change)
  const current = before.steps[step]
  if (FINAL.has(current.state)) {
    return { ok: true, change: ctx.change, step, state: current.state, already: true, detail: current.detail ?? null, next: nextStep(before) }
  }
  const waiting = STEPS.slice(0, STEPS.indexOf(step)).filter((s) => !SETTLED.has(before.steps[s].state))
  if (waiting.length > 0) refuse(`${step} waits for ${waiting.join(', ')}; run archive.mjs next --change ${ctx.change} and that step first`)
  let result
  try {
    ctx.fault?.(step)
    result = fn(before)
  } catch (error) {
    result = { state: 'failed', refusal: error.message, detail: { error: error.message, ...(error.extra ?? {}) } }
  }
  if (result.hold) return { ok: true, change: ctx.change, step, state: current.state, detail: current.detail ?? null, next: nextStep(before), ...result.out }
  const record = { state: result.state, at: ctx.now().toISOString(), detail: result.detail ?? null }
  const after = saveStep(ctx.main, ctx.change, step, record)
  return {
    ok: result.state !== 'failed',
    change: ctx.change,
    step,
    state: result.state,
    detail: record.detail,
    next: nextStep(after),
    ...(result.refusal ? { refusal: result.refusal } : {}),
    ...(result.out ?? {})
  }
}

// ---------------------------------------------------------------- shared reads

const recordPath = (change) => `${CHANGES_DIR}/${change}/review.md`

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
  } catch (error) {
    return refuse(`cannot read ${join(dir, META_FILE)} (${error.message}); the change records its base there`)
  }
}

function baseOf(ctx) {
  const base = readMeta(findChangeDir(ctx.root, ctx.change)).base
  if (typeof base !== 'string' || !base.trim()) refuse(`the change's ${META_FILE} records no base branch`)
  return base
}

function branchOf(ctx) {
  const branch = ctx.git('read the current branch', 'branch', '--show-current')
  if (!branch) refuse('HEAD is detached; check out the change branch in the worktree')
  return branch
}

const matcher = (globs) => {
  const res = globs.map((g) => globToRegExp(g))
  return (file) => res.some((re) => re.test(file))
}

// The knowledge base's globs from the role's context: { paths, log }; none without a provider.
function knowledgeGlobs(ctx) {
  const context = ctx.knowledge()
  if (context.state !== 'done') return { paths: [], log: [] }
  const list = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g !== '') : [])
  return { paths: list(context.paths), log: list(context.log) }
}

// Whether a repository-relative file is in a tree whose uncommitted files archive answers for:
// the change tree, the main specs, the knowledge base and the debt tree.
function inScope(ctx) {
  const debt = readDebtRoot(ctx.root)
  const { paths, log } = knowledgeGlobs(ctx)
  const knowledge = matcher([...paths, ...log])
  return (file) =>
    file.startsWith(`${CHANGES_DIR}/`) || file.startsWith('openspec/specs/') || knowledge(file) || (debt !== null && (file === debt || file.startsWith(`${debt.replace(/\/$/, '')}/`)))
}

function commitOwn(ctx, { mine, later = new Set(), message }) {
  const dirty = workingChanges(ctx.root)
  const scope = inScope(ctx)
  const foreign = dirty.filter((f) => !mine(f) && !later.has(f) && scope(f))
  if (foreign.length > 0) {
    refuse(`uncommitted files archive did not write: ${foreign.join(', ')}; the developer commits, moves or discards them, then run this step again`, { foreign })
  }
  const paths = dirty.filter(mine)
  if (paths.length === 0) return { state: 'done', detail: { commit: null, files: [] } }
  const made = commitPaths(ctx.root, { only: paths, message })
  return { state: 'done', detail: { commit: made.commit, files: made.files } }
}

const settledDetail = (state, step) => state.steps[step].detail ?? {}

// ---------------------------------------------------------------- check

export function checkStep(ctx) {
  return runStep(ctx, 'check', () => {
    const { root, change, git } = ctx
    const record = recordPath(change)
    const top = git('read the repository root', 'rev-parse', '--show-toplevel')
    const roots = { change: root, repository: existsSync(top) ? realpathSync(top) : top }
    if (!existsSync(join(root, record))) refuse(`${record} is missing; run /adf:review ${change}`, { roots })
    const parsed = checkRecord(readFileSync(join(root, record), 'utf8'))
    if (!parsed.ok) refuse(`${record} cannot be read: ${parsed.errors.join('; ')}; run /adf:review ${change} again`, { roots })
    if (parsed.change && parsed.change !== change) refuse(`${record} is the record of ${parsed.change}, not ${change}`, { roots })
    if (parsed.verdict !== 'PASS') {
      refuse(`${record} says ${parsed.verdict}; archive proceeds on PASS only: settle each outstanding finding with /adf:review ${change}, where the developer's ruling with a reason accepts a blocking finding`, { verdict: parsed.verdict, roots })
    }
    if (git('read the status of the review record', 'status', '--porcelain', '--', record) !== '') refuse(`${record} has uncommitted changes; review.mjs assemble --commit commits it`, { roots })
    if (!git('read the history of the review record', 'log', '-1', '--format=%H', '--', record)) refuse(`${record} is not committed; review.mjs assemble --commit commits it`, { roots })
    const sha = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${parsed.commit}^{commit}`], { cwd: root, encoding: 'utf8' })
    if (sha.status !== 0) refuse(`the reviewed commit ${parsed.commit} is not in this repository (change root ${roots.change}, repository root ${roots.repository}); run /adf:review ${change} again`, { roots })
    const commit = sha.stdout.trim()
    if (!gitAsk(root, 'compare the reviewed commit with HEAD', 'merge-base', '--is-ancestor', commit, 'HEAD')) {
      refuse(`the reviewed commit ${commit.slice(0, 7)} is not an ancestor of HEAD (change root ${roots.change}, repository root ${roots.repository}); run /adf:review ${change} again`, { roots })
    }
    const after = git('list the commits after the reviewed one', 'log', '--format=%h', `${commit}..HEAD`, '--', '.', `:(exclude)${record}`)
    if (after) {
      const differ = roots.change !== roots.repository ? '; the two roots differ, so pass the worktree top level as --root' : ''
      refuse(
        `commit(s) ${after.split('\n').join(', ')} after the reviewed commit ${commit.slice(0, 7)} change files other than ${record}: the code changed since it was reviewed; run /adf:review ${change} again (change root ${roots.change}, repository root ${roots.repository}${differ})`,
        { roots, stale: after.split('\n') }
      )
    }
    const warnings = []
    const dir = join(root, CHANGES_DIR, change)
    const skipped = new Set(readMeta(dir).skipped ?? [])
    for (const a of changeStatus(root, change, loadSchema()).artifacts) {
      if (a.status !== 'done' && !skipped.has(a.id)) warnings.push(`artifact ${a.id} is ${a.status}`)
    }
    const tasksFile = join(dir, 'tasks.md')
    if (existsSync(tasksFile)) {
      const open = parseTasks(readFileSync(tasksFile, 'utf8')).filter((t) => !t.done)
      if (open.length > 0) warnings.push(`${open.length} task(s) unchecked in tasks.md: ${open.map((t) => t.description).join('; ')}`)
    }
    warnings.push(...parsed.warnings.map((w) => `review record: ${w}`))
    return { state: 'done', detail: { verdict: parsed.verdict, commit, rounds: parsed.rounds, counts: parsed.counts, roots, warnings } }
  })
}

// ---------------------------------------------------------------- placements

const cites = (text, id) => new RegExp(`(^|[^\\w-])${id.replace(/[-]/g, '\\-')}(?![\\w-])`).test(String(text ?? ''))

// Pure: what the ledger and the review record leave unplaced.
//   records: the ledger; findings: [{ id, kind }] from the record's dispositions.
export function unplaced(records, findings, change) {
  const out = []
  const where = '--as tech-debt|flow-debt|follow-up|accepted --where "<where it went>"'
  for (const d of unresolvedDebt(records)) {
    out.push({ kind: 'debt', id: d.id, what: d.what, reason: d.reason, command: `ledger.mjs resolve --change ${change} --debt ${d.id} ${where}` })
  }
  const resolved = new Set(records.filter((r) => r.kind === 'resolve' && r.finding).map((r) => r.finding))
  for (const f of findings.filter((f) => ['recorded', 'accepted'].includes(f.kind) && !resolved.has(f.id))) {
    out.push({ kind: 'finding', id: f.id, disposition: f.kind, command: `ledger.mjs resolve --change ${change} --finding ${f.id} ${where}` })
  }
  const debts = records.filter((r) => r.kind === 'debt')
  const rulings = records.filter((r) => r.kind === 'ruling')
  for (const dev of records.filter((r) => r.kind === 'deviation')) {
    if (debts.some((d) => cites(d.what, dev.id) || cites(d.reason, dev.id)) || rulings.some((r) => r.finding === dev.id)) continue
    out.push({
      kind: 'deviation',
      id: dev.id,
      rule: dev.rule,
      reason: dev.reason,
      command: `forced by the flow: ledger.mjs debt --change ${change} --what "<the flow defect>" --reason "forced ${dev.id}"; a judgement about this change: ledger.mjs ruling --change ${change} --finding ${dev.id} --decision "<why it stands>"`
    })
  }
  return out
}

export function placementsStep(ctx) {
  return runStep(ctx, 'placements', () => {
    const { root, change } = ctx
    const record = join(findChangeDir(root, change), 'review.md')
    const findings = existsSync(record) ? checkRecord(readFileSync(record, 'utf8')).dispositions.map((d) => ({ id: d.id, kind: d.kind })) : []
    const list = unplaced(readRecords(root, change), findings, change)
    if (list.length > 0) {
      return {
        state: 'failed',
        refusal: `${list.length} item(s) are not placed: ${list.map((i) => i.id).join(', ')}; place each, with the developer, and run placements again`,
        detail: { unplaced: list }
      }
    }
    const debt = readDebtRoot(root)
    const prefix = debt === null ? null : `${debt.replace(/\/$/, '')}/`
    const debtFiles = prefix === null ? [] : workingChanges(root).filter((f) => f.startsWith(prefix))
    return { state: 'done', detail: { unplaced: [], debtFiles } }
  })
}

// ---------------------------------------------------------------- merge

// resolutionFiles: paths of JSON arrays, joined into one; purposeFiles: { capability: path }.
export function mergeStep(ctx, { resolutionFiles = [], purposeFiles = {} } = {}) {
  return runStep(ctx, 'merge', () => {
    const { root, change } = ctx
    const resolutions = resolutionFiles.flatMap((file) => {
      let value
      try {
        value = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        return refuse(`--resolutions ${file}: ${error.message}`)
      }
      if (!Array.isArray(value)) refuse(`--resolutions ${file} is not a JSON array of { capability, requirement, text, reason }`)
      return value
    })
    checkResolutions(resolutions)
    const purposes = {}
    for (const [capability, file] of Object.entries(purposeFiles)) {
      let text
      try {
        text = readFileSync(file, 'utf8').trim()
      } catch (error) {
        return refuse(`--purpose ${capability}=${file}: ${error.message}`)
      }
      if (!text) refuse(`--purpose ${capability}=${file} is empty`)
      purposes[capability] = text
    }
    const preview = mergePreview(root, change, { resolutions, purposes })
    const notNew = Object.keys(purposes).filter((c) => !preview.newCapabilities.includes(c))
    if (notNew.length > 0) refuse(`--purpose names ${notNew.join(', ')}, which is not a new capability of ${change}; a Purpose is written for a new capability only`)
    if (!preview.ok) {
      const byCapability = new Map()
      for (const c of preview.conflicts) byCapability.set(c.capability, [...(byCapability.get(c.capability) ?? []), c])
      const dispatches = [...byCapability].map(([capability, conflicts]) => ({
        capability,
        name: dispatchName({ role: 'spec-merge', capability }),
        conflicts: writeConflictTexts(root, change, capability, conflicts)
      }))
      const what = [
        ...(dispatches.length ? [`conflicts in ${dispatches.map((d) => d.capability).join(', ')}: dispatch spec-merge for each, check its reply with specs.mjs resolution, and run merge again with --resolutions`] : []),
        ...preview.errors.map((e) => `${e.capability}: ${e.error}`)
      ]
      return { state: 'failed', refusal: `the merge wrote nothing; ${what.join('; ')}`, detail: { conflicts: dispatches, errors: preview.errors, totals: preview.totals } }
    }
    if (preview.placeholderPurpose.length > 0) {
      refuse(`the new capability ${preview.placeholderPurpose.join(', ')} needs its Purpose: write it from proposal.md and pass --purpose <capability>=<file>; nothing was written`, { placeholderPurpose: preview.placeholderPurpose })
    }
    const out = writeMerge(root, change, { resolutions, purposes })
    if (!out.ok) refuse(`the merge wrote nothing: ${out.errors.map((e) => `${e.capability}: ${e.error}`).join('; ')}`)
    return {
      state: 'done',
      detail: {
        written: out.written,
        totals: out.totals,
        noChanges: out.noChanges,
        merged: out.merged,
        newCapabilities: out.newCapabilities,
        purposes: Object.keys(purposes),
        resolved: out.capabilities.flatMap((c) => c.conflicts.filter((x) => x.resolved).map((x) => `${c.capability}: ${x.requirement}`)),
        warnings: out.warnings
      }
    }
  })
}

// ---------------------------------------------------------------- move and the commits

export function moveStep(ctx) {
  return runStep(ctx, 'move', () => {
    const out = archiveChange(ctx.root, ctx.change, { now: ctx.now() })
    return { state: 'done', detail: { from: out.from, target: out.target, ledger: out.ledger } }
  })
}

const specCapabilities = (dir) => {
  const specs = join(dir, 'specs')
  return existsSync(specs) ? readdirSync(specs).filter((c) => existsSync(join(specs, c, 'spec.md'))).sort() : []
}

export function commitSpecsStep(ctx) {
  return runStep(ctx, 'commit-specs', (state) => {
    const { root, change } = ctx
    const { target } = settledDetail(state, 'move')
    if (!target) refuse('the move recorded no target; run archive.mjs move again')
    const specFiles = new Set([...(settledDetail(state, 'merge').written ?? []), ...specCapabilities(join(root, target)).map((c) => `openspec/specs/${c}/spec.md`)])
    const mine = (f) => f.startsWith(`${CHANGES_DIR}/${change}/`) || f.startsWith(`${target}/`) || specFiles.has(f)
    return commitOwn(ctx, { mine, later: new Set(settledDetail(state, 'placements').debtFiles ?? []), message: `docs(specs): archive ${change}` })
  })
}

export function ingestStep(ctx, { reply = null } = {}) {
  return runStep(ctx, 'ingest', (state) => {
    const { root, change } = ctx
    const context = ctx.knowledge()
    if (context.state === 'none') return { state: 'skipped', detail: { report: knowledgeReport('log', context) } }
    if (context.state !== 'done') refuse(knowledgeReport('context', context))
    if (!reply) refuse(`ingest needs --reply: run ingest.mjs stale --change ${change}, dispatch \`ingest\` at level architecture with its input, and pass the reply file`)
    const checked = checkIngestFile(root, change, reply, { exclude: settledDetail(state, 'placements').debtFiles ?? [] })
    if (!checked.valid) {
      return {
        state: 'failed',
        refusal: `the ingest reply is refused: ${checked.errors.join('; ')}; send it back once (dispatch.mjs attempt), and a second refusal stops archive`,
        detail: { errors: checked.errors }
      }
    }
    if (checked.log === null) return { state: 'done', detail: { nothingLearned: true, paths: [], report: 'Knowledge: nothing learned that the code and the history do not carry; no page and no log entry.' } }
    const result = ctx.knowledgeLog(checked.log)
    if (result.state !== 'done') refuse(knowledgeReport('log', result))
    const isLog = matcher(checked.input.knowledge.log ?? [])
    const paths = [
      ...checked.reply.pages.map((p) => p.path),
      ...checked.reply.stale.filter((s) => s.outcome === 'removed').map((s) => s.path),
      ...workingChanges(root).filter(isLog)
    ]
    return { state: 'done', detail: { nothingLearned: false, paths: [...new Set(paths)].sort(), report: knowledgeReport('log', result) } }
  })
}

export function commitMemoryStep(ctx) {
  return runStep(ctx, 'commit-memory', (state) => {
    const own = new Set([...(settledDetail(state, 'ingest').paths ?? []), ...(settledDetail(state, 'placements').debtFiles ?? [])])
    return commitOwn(ctx, { mine: (f) => own.has(f), message: `docs(memory): ingest what ${ctx.change} taught` })
  })
}

// ---------------------------------------------------------------- the merge request

const section = (text, title) => {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && /^##?\s/.test(l))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim() || null
}

const STEP_LINE = /^\s*[-*]\s+\*\*(GIVEN|WHEN|THEN|AND)\*\*:?\s*(.*)$/

// Pure: every scenario of a delta spec's ADDED and MODIFIED requirements with its GIVEN, WHEN
// and THEN lines; an AND line joins the kind before it.
export function deltaScenarios(text, capability) {
  const out = []
  let operation = null
  let requirement = null
  let scenario = null
  let last = null
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const op = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/.exec(line)
    if (op) {
      operation = op[1]
      requirement = scenario = null
      continue
    }
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line)
    if (req) {
      requirement = req[1]
      scenario = null
      continue
    }
    const sc = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line)
    if (sc && ['ADDED', 'MODIFIED'].includes(operation)) {
      scenario = { capability, requirement, scenario: sc[1], given: [], when: [], then: [] }
      out.push(scenario)
      last = null
      continue
    }
    const step = scenario && STEP_LINE.exec(line)
    if (step) {
      const kind = step[1] === 'AND' ? last : step[1].toLowerCase()
      if (kind) {
        scenario[kind].push(step[2].trim())
        last = kind
      }
    }
  }
  return out
}

// What the orchestrator writes the merge request body from: the tasks done, the proposal's Why,
// each scenario's steps, and the run evidence verify.md records. Read-only.
export function mrInput(ctx) {
  const dir = findChangeDir(ctx.root, ctx.change)
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null)
  const tasks = parseTasks(read('tasks.md') ?? '')
  const verify = read('verify.md') ?? ''
  return {
    ok: true,
    change: ctx.change,
    changeDir: dir,
    tasks: { done: tasks.filter((t) => t.done).map((t) => t.description), open: tasks.filter((t) => !t.done).map((t) => t.description) },
    why: section(read('proposal.md') ?? '', 'Why'),
    scenarios: specCapabilities(dir).flatMap((c) => deltaScenarios(readFileSync(join(dir, 'specs', c, 'spec.md'), 'utf8'), c)),
    evidence: {
      verdict: [...verify.matchAll(/^Verdict: (.+?)\s*$/gm)].at(-1)?.[1] ?? null,
      sections: ['Apply test record', 'Checks run with the developer', 'Exercised and not exercised'].map((title) => ({ title, text: section(verify, title) }))
    },
    bodyFile: bodyPath(ctx.main, ctx.change)
  }
}

export function mrStep(ctx, { body = null, title, summary } = {}) {
  return runStep(ctx, 'mr', () => {
    if (!body) {
      const probe = ctx.forge('check', {})
      if (probe.state === 'none') return { state: 'skipped', detail: { forge: 'none', report: forgeReport('finalize', probe) } }
      refuse(`mr needs --body: write the merge request body from archive.mjs mr-input to ${bodyPath(ctx.main, ctx.change)} and pass it`)
    }
    let text
    try {
      text = readFileSync(body, 'utf8')
    } catch (error) {
      return refuse(`--body ${body}: ${error.message}`)
    }
    const input = forgeInput(
      'finalize',
      { change: ctx.change, branch: branchOf(ctx), base: baseOf(ctx), protected: readBranches(ctx.root)?.protected ?? null },
      { input: { body: text }, title, summary }
    )
    const result = ctx.forge('finalize', input)
    const report = forgeReport('finalize', result)
    const forge = result.state === 'none' ? 'none' : result.plugin ?? null
    if (result.state === 'none') return { state: 'skipped', detail: { forge, report } }
    if (result.state === 'refused') return { state: 'failed', refusal: report, detail: { forge, report, error: result.error ?? null } }
    if (result.state === 'degraded') {
      return { state: 'degraded', detail: { forge, report, hint: result.hint ?? null, fallback: result.fallback ?? [], inputFile: result.inputFile ?? null, body } }
    }
    return { state: 'done', detail: { forge, report, url: result.url ?? null } }
  })
}

// ---------------------------------------------------------------- the local merge

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`)

// With no forge: merges the change branch into its base in the main checkout, on `yes` only.
// Without `yes` and without `no` it prints the commands and records nothing; `no` records the
// developer's choice to merge it themselves.
export function mergeLocalStep(ctx, { yes = false, no = false } = {}) {
  return runStep(ctx, 'merge-local', (state) => {
    if (settledDetail(state, 'mr').forge !== 'none') {
      return { state: 'skipped', detail: { report: 'Local merge: none; a forge provider integrates the change through its merge request.' } }
    }
    const branch = branchOf(ctx)
    const base = baseOf(ctx)
    const main = ctx.main
    const commands = [`git -C ${quote(main)} checkout ${quote(base)}`, `git -C ${quote(main)} merge --no-ff ${quote(branch)}`]
    if (gitAsk(main, 'compare the change branch with its base', 'merge-base', '--is-ancestor', branch, base)) {
      return { state: 'done', detail: { already: true, branch, base, report: `Local merge: ${branch} is already merged into ${base}.` } }
    }
    if (no) return { state: 'skipped', detail: { declined: true, branch, base, commands, report: `Local merge: declined; the developer merges ${branch} into ${base}.` } }
    if (!yes) return { hold: true, out: { branch, base, commands, waiting: `the developer's yes: archive.mjs merge-local --change ${ctx.change} --yes, or --no to merge it by hand` } }
    const mainGit = gitReader(main)
    const current = mainGit('read the main checkout branch', 'branch', '--show-current')
    if (current !== base) refuse(`the main checkout ${main} has ${current || 'a detached HEAD'} checked out, not ${base}; nothing was merged. Run: ${commands.join(' && ')}`, { commands })
    const dirty = mainGit('read the main checkout status', 'status', '--porcelain', '--untracked-files=no')
    if (dirty) refuse(`the main checkout ${main} has uncommitted changes; nothing was merged. Once it is clean, run: ${commands[1]}`, { commands, dirty: dirty.split('\n') })
    const merged = spawnSync('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: main, encoding: 'utf8' })
    if (merged.status !== 0) {
      spawnSync('git', ['merge', '--abort'], { cwd: main, encoding: 'utf8' })
      refuse(`git merge --no-ff ${branch} failed in ${main} and was aborted (${String(merged.stderr || merged.stdout).trim()}); merge it by hand: ${commands[1]}`, { commands })
    }
    const commit = mainGit('read the merge commit', 'rev-parse', 'HEAD')
    return { state: 'done', detail: { merged: true, mergeCommit: commit, branch, base, report: `Local merge: ${branch} merged into ${base} at ${commit.slice(0, 7)}; nothing was pushed, and the branch is kept.` } }
  })
}

// ---------------------------------------------------------------- remove and the report

export function removeStep(ctx) {
  return runStep(ctx, 'remove', () => {
    const out = removeWorktree(ctx.main, { change: ctx.change })
    return { state: 'done', detail: out }
  })
}

const summary = {
  check: (d) => `review ${d.verdict} at ${String(d.commit).slice(0, 7)}${d.warnings?.length ? `; warnings: ${d.warnings.join('; ')}` : ''}`,
  placements: (d) => `every debt, recorded finding and deviation placed${d.debtFiles?.length ? `; debt files ${d.debtFiles.join(', ')}` : ''}`,
  merge: (d) =>
    d.noChanges
      ? 'no delta specs'
      : d.merged
        ? 'the main specs already held the delta'
        : `added ${d.totals.added}, modified ${d.totals.modified}, removed ${d.totals.removed}, renamed ${d.totals.renamed}${d.newCapabilities?.length ? `; new capabilities ${d.newCapabilities.join(', ')}` : ''}${d.purposes?.length ? `; Purpose written by hand for ${d.purposes.join(', ')}` : ''}${d.resolved?.length ? `; conflicts resolved: ${d.resolved.join('; ')}` : ''}${d.warnings?.length ? `; warnings: ${d.warnings.join('; ')}` : ''}`,
  move: (d) => `moved to ${d.target}; ledger ${d.ledger}`,
  'commit-specs': (d) => (d.commit ? `commit ${d.commit.slice(0, 7)}` : 'nothing to commit'),
  ingest: (d) => d.report ?? `${d.paths?.length ?? 0} path(s)`,
  'commit-memory': (d) => (d.commit ? `commit ${d.commit.slice(0, 7)}` : 'nothing to commit'),
  mr: (d) => d.report,
  'merge-local': (d) => d.report,
  remove: (d) => (d.state === 'removed' ? `worktree ${d.path} removed; branch ${d.branch} kept` : d.state === 'in-place' ? 'made in place; no worktree to remove' : 'no worktree left')
}

// The final report, built from the states alone. `complete` only when every step is done or
// skipped: a pending, failed or degraded step is named.
export function report(ctx) {
  const state = readArchiveState(ctx.main, ctx.change)
  const complete = STEPS.every((s) => FINAL.has(state.steps[s].state))
  const lines = []
  for (const step of STEPS) {
    const { state: s, detail } = state.steps[step]
    let text = ''
    if (s === 'failed') text = detail?.error ?? 'failed'
    else if (s !== 'pending' && detail) {
      try {
        text = summary[step](detail) ?? ''
      } catch {
        text = ''
      }
    }
    lines.push(`- ${step}: ${s}${text ? ` — ${text}` : ''}`)
  }
  const open = STEPS.filter((s) => !FINAL.has(state.steps[s].state))
  const mr = state.steps.mr
  const heading = complete ? `## Archive complete: ${ctx.change}` : `## Archive not complete: ${ctx.change}`
  const tail = complete
    ? []
    : [
        '',
        `Not finished: ${open.map((s) => `${s} (${state.steps[s].state})`).join(', ')}.`,
        ...(mr.state === 'degraded' ? ['The merge request is not ready: run the fallback the mr step recorded, then archive.mjs mr again.'] : []),
        ...(nextStep(state) ? [`Next: archive.mjs ${nextStep(state)} --change ${ctx.change}.`] : [])
      ]
  return { ok: true, change: ctx.change, complete, next: nextStep(state), steps: state.steps, report: [heading, '', ...lines, ...tail].join('\n') }
}
