// /adf:archive's deterministic steps, each a function that records its own state, so archive
// resumes from the step that failed and a re-run of a finished step changes nothing.
//
// The steps, in order: check, placements, merge, move, commit-specs, ingest, commit-memory,
// metrics, commit-metrics, mr, merge-local, remove. A step runs only when every step before it is settled (`done`,
// `degraded` or `skipped`); a `done` or `skipped` step is reported as it is, never run again; a
// `failed` step, and a `degraded` one, runs again. The state is kept per change in the main
// checkout's `.superpowers/sdd/<change>/archive/state.json`: the change directory moves at
// `move`, and the worktree, with its own `.superpowers/`, is removed at `remove`; the main
// checkout's copy outlives both. The final report is built last, from the states and git, with
// no LLM: after the steps, the changes archived since the last window retro (lib/window.mjs,
// after one fetch of the integration ref), the corpus lint when due, the removal candidates and
// the hurt signals of this change's record.
//
// What each step reads and writes:
//   check         the review record through review-state's checkRecord: PASS only (one
//                 verdict route: a developer ruling with a reason makes the computed verdict
//                 PASS), the record committed, the reviewed commit read and an ancestor of HEAD,
//                 no commit after it touching anything but the record (`git log <sha>..HEAD --
//                 . ':(exclude)<record>'`), the refusal naming the change root and the
//                 repository root; then lib/specs.mjs checkSpecsBase: a missing or stale entry in
//                 specs-base.json refuses, since the merge must not use a base the delta was not
//                 written against, and a change with no specs-base.json at all (made before the
//                 snapshot) is a warning naming the fallback to the merge base. Artifacts not done
//                 and unchecked tasks are `warnings`; the capabilities verify.md lists as
//                 hand-edited are kept for the report, which says the corpus lint is due.
//   placements    every debt record with no `resolve`, every recorded or accepted review finding
//                 with no `resolve --finding`, and every `deviation` cited by no `debt` (its
//                 `what` or `reason` names the deviation id, as in "forced deviation-1") and no
//                 `ruling` (its `finding` is the deviation id). Anything listed refuses. On a
//                 pass the entries of the debt items the change's scope.json takes in full
//                 (state `taken`) are moved to their block's resolved.md (lib/debt.mjs
//                 resolveEntry), resolved by the directory `move` will archive the change to
//                 (lib/changes.mjs archiveTarget) on the date recorded here, which `move` then
//                 uses; an entry already resolved counts as resolved, one in neither file is
//                 reported as gone, and the debt tree's uncommitted files are recorded: they are
//                 the placement's.
//   merge         lib/specs.mjs writeMerge, after the preview: a conflict writes its texts for the
//                 `spec-merge <capability>` dispatch and fails the step; a new capability's
//                 placeholder Purpose refuses until `--purpose <capability>=<file>` gives it.
//   move          lib/changes.mjs archiveChange: the ledger copied once, the directory moved, on
//                 the date placements resolved the debt with when it resolved any.
//   commit-specs  `docs(specs): archive <name>`: the old and the new change directory and the
//                 main spec files of the change's capabilities, only those paths.
//   ingest        the ingest reply (lib/ingest.mjs checkIngestFile), the log written through the
//                 knowledge role's `log`, with a bullet naming the debt ids placements resolved
//                 (an entry of its own when nothing was learned); with no knowledge provider the
//                 step is `skipped` and its report says the resolved ids were not logged.
//   commit-memory `docs(memory): ingest what <name> taught`: only the paths the ingest and the
//                 placement wrote.
//   metrics       lib/metrics.mjs buildRecord after the ingest is committed, so the ingest is
//                 measured: metrics.json and a copy of attempts.jsonl in the archived directory,
//                 and the price table updated (lib/prices.mjs) from the registry's
//                 metrics.pricesUrl; a failed price fetch is the detail's `stale` or `none`, never
//                 the step's failure. No transcripts is `degraded`, the record written and the gap
//                 named; a record that fails its schema is `failed`, nothing written. A re-run
//                 writes the same files; once commit-metrics is done it changes nothing, since a
//                 new record would measure its own commit.
//   commit-metrics `chore(metrics): record <name>`: only the paths metrics wrote.
//   mr            the forge role's `finalize`; `none` is `skipped`, `degraded` keeps the role's
//                 fallback file and the step is `degraded`. With a forge and no `--body` the step
//                 holds, `pending`, and returns what it needs: mr-input, then the body file.
//                 With the run's `ci: false` (archive.mjs --no-ci, kept in the state) the
//                 forge pushes with no CI run. A body that does not name, as a whole word,
//                 every key the change's scope.json takes (its taken and partial tracker keys
//                 and debt ids) fails the step, nothing sent; no scope.json is no check.
//   merge-local   with no forge only, after the developer's yes: `git merge --no-ff <branch>` in
//                 the main checkout when it has the base checked out and is clean; nothing pushed,
//                 the branch kept.
//   remove        lib/workspace.mjs remove, from the main checkout.
//
// A commit step refuses, naming them, the uncommitted files of the change tree, the main specs,
// the knowledge base and the debt tree that it did not write and that no later step will commit:
// the origin staged whole trees and committed other people's work with its own.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { archiveChange, archiveDate, archiveTarget, CHANGES_DIR, changeStatus, globToRegExp, META_FILE, parseTasks, readChangeMeta } from './changes.mjs'
import { attemptsFile, recordReply } from './attempts.mjs'
import { readBranches } from './branches.mjs'
import { commitPaths } from './commit.mjs'
import { dispatchName } from './dispatch.mjs'
import { listTree, resolveEntry } from './debt.mjs'
import { checkIngestFile, findChangeDir, workingChanges } from './ingest.mjs'
import { mainCheckout } from './installed.mjs'
import { readRecords, unresolvedDebt } from './ledger.mjs'
import { localMerge } from './local-merge.mjs'
import { asV2, buildRecord, candidates, RECORD_FILE, RecordError } from './metrics.mjs'
import { QUIET_RUN } from './metrics-records.mjs'
import { addEntry, pricesUrl } from './prices.mjs'
import { readDebtRoot } from './registry.mjs'
import { checkRecord, ROUND_CAP } from './review-state.mjs'
import { callRole, CORE, forgeInput, forgeReport, knowledgeReport } from './roles.mjs'
import { debtGroups, findScope, namesKey, SCOPE_FILE, scopeKeys, trackerTargets } from './scope.mjs'
import { checkResolutions, checkSpecsBase, mergePreview, writeMerge } from './specs.mjs'
import { writeConflictTexts } from './spec-merge.mjs'
import { loadSchema } from './schema.mjs'
import { defaultProjectsDir } from './transcripts.mjs'
import { fetchRef, LINT_DUE, sinceLastRetro } from './window.mjs'
import { remove as removeWorktree } from './workspace.mjs'

export const STEPS = ['check', 'placements', 'merge', 'move', 'commit-specs', 'ingest', 'commit-memory', 'metrics', 'commit-metrics', 'mr', 'merge-local', 'remove']
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

// `ci: false` is the run's --no-ci, kept so that a resumed run pushes with no CI run too.
export function readArchiveState(main, change) {
  const path = statePath(main, change)
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return { change, ...(saved.ci === false ? { ci: false } : {}), steps: Object.fromEntries(STEPS.map((s) => [s, saved.steps?.[s] ?? { state: 'pending' }])) }
}

function writeState(main, change, state) {
  const path = statePath(main, change)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return state
}

function saveStep(main, change, step, record) {
  const state = readArchiveState(main, change)
  state.steps[step] = record
  return writeState(main, change, state)
}

// Records the run's --no-ci: the forge calls of the `mr` step get `ci: false`.
export function setNoCi(main, change) {
  const state = readArchiveState(main, change)
  if (state.ci === false) return state
  return writeState(main, change, { change, ci: false, steps: state.steps })
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
// forge(operation, input) -> role result, projectsDir, fetchPrices(url, now) -> fetchEntry result,
// fetchRef(root, { now }) -> lib/window.mjs fetchRef result, fault(step) }. `fault` lets a test
// fail a step; `projectsDir` is the transcript directory; `fetchRef` runs once, in the report.
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
    forge: deps.forge ?? ((operation, input) => callRole(root, 'forge', operation, input, core)),
    home: deps.home,
    projectsDir: deps.projectsDir ?? defaultProjectsDir(),
    fetchPrices: deps.fetchPrices ?? fetchPricesSync,
    fetchRef: deps.fetchRef ?? fetchRef
  }
  return ctx
}

// lib/prices.mjs fetchEntry is asynchronous and the steps are not: it runs in a child process.
const PRICES_MODULE = new URL('./prices.mjs', import.meta.url).href
const FETCH_PRICES = `const { fetchEntry } = await import(process.argv[1])
const got = await fetchEntry({ url: process.argv[2], now: () => new Date(process.argv[3]) })
process.stdout.write(JSON.stringify(got))`

function fetchPricesSync(url, now) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', FETCH_PRICES, PRICES_MODULE, url, now().toISOString()], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26 })
  try {
    return JSON.parse(run.stdout)
  } catch {
    return { ok: false, reason: `could not fetch ${url}: ${String(run.error?.message || run.stderr || `exit ${run.status}`).trim()}` }
  }
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

function readMeta(root, dir) {
  return readChangeMeta(root, dir) ?? refuse(`cannot read ${join(dir, META_FILE)}; the change records its base there`)
}

function baseOf(ctx) {
  const base = readMeta(ctx.root, findChangeDir(ctx.root, ctx.change)).base
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

// Pure: the entries of verify.md's `**Hand-edited capability prose:**` field, inline or as the
// bullets under it; none for `none`, for the c4 fallback `not stated ...`, or with no field.
export function handEditedProse(verifyText) {
  const lines = String(verifyText ?? '').replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((l) => l.startsWith('**Hand-edited capability prose:**'))
  if (at < 0) return []
  const inline = lines[at].slice('**Hand-edited capability prose:**'.length).trim()
  const entries = []
  if (inline) entries.push(inline)
  else {
    for (const line of lines.slice(at + 1)) {
      if (!line.trim() && entries.length === 0) continue
      const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
      if (!item) break
      entries.push(item[1])
    }
  }
  return entries.filter((e) => !/^(none|not stated\b)/i.test(e))
}

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
    const base = checkSpecsBase(root, change)
    const warnings = []
    if (base.warning) {
      warnings.push(base.warning)
    } else if (!base.ok) {
      refuse(`${base.refusal}; the merge must not use a base the delta was not written against`, { roots, specsBase: { missing: base.missing, stale: base.stale } })
    }
    const dir = join(root, CHANGES_DIR, change)
    const skipped = new Set(readMeta(root, dir).skipped ?? [])
    for (const a of changeStatus(root, change, loadSchema()).artifacts) {
      if (a.status !== 'done' && !skipped.has(a.id)) warnings.push(`artifact ${a.id} is ${a.status}`)
    }
    const tasksFile = join(dir, 'tasks.md')
    if (existsSync(tasksFile)) {
      const open = parseTasks(readFileSync(tasksFile, 'utf8')).filter((t) => !t.done)
      if (open.length > 0) warnings.push(`${open.length} task(s) unchecked in tasks.md: ${open.map((t) => t.description).join('; ')}`)
    }
    warnings.push(...parsed.warnings.map((w) => `review record: ${w}`))
    const verifyFile = join(dir, 'verify.md')
    const handEdited = existsSync(verifyFile) ? handEditedProse(readFileSync(verifyFile, 'utf8')) : []
    return { state: 'done', detail: { verdict: parsed.verdict, commit, rounds: parsed.rounds, counts: parsed.counts, roots, warnings, handEdited } }
  })
}

// ---------------------------------------------------------------- placements

const cites = (text, id) => new RegExp(`(^|[^\\w-])${id.replace(/[-]/g, '\\-')}(?![\\w-])`).test(String(text ?? ''))

// Pure: what the ledger and the review record leave unplaced.
//   records: the ledger; findings: [{ id, kind }] from the record's dispositions.
export function unplaced(records, findings, change) {
  const out = []
  const where = '--as tech-debt|adf-debt|follow-up|accepted --where "<where it went>"'
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
    const taken = resolveTakenDebt(ctx, debt)
    const prefix = debt === null ? null : `${debt.replace(/\/$/, '')}/`
    const debtFiles = prefix === null ? [] : workingChanges(root).filter((f) => f.startsWith(prefix))
    return { state: 'done', detail: { unplaced: [], debtFiles, ...taken } }
  })
}

// The change's scope.json, or null when it has none.
function changeScope(ctx) {
  const file = join(findChangeDir(ctx.root, ctx.change), SCOPE_FILE)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// The debt entries the change resolved: the scope's debt items taken in full, moved to their
// block's resolved.md, resolved by the change's archived directory. A partial item stays. An
// entry already resolved counts as resolved, so a re-run after some moves settles; an entry in
// neither file, or a tree the registry does not name, is reported as gone and is no failure.
function resolveTakenDebt(ctx, debt) {
  const ids = (changeScope(ctx)?.items ?? []).filter((i) => i.source === 'debt' && i.state === 'taken').map((i) => i.key)
  if (ids.length === 0) return {}
  const tree = debt === null ? null : join(ctx.root, debt)
  const listed = tree === null ? { entries: [], resolved: [] } : listTree(tree, { kind: 'debt' })
  const open = new Set(listed.entries.map((e) => e.id))
  const known = new Set([...open, ...listed.resolved.map((e) => e.id)])
  const resolvedOn = archiveDate(ctx.now())
  const resolvedBy = archiveTarget(ctx.change, { date: resolvedOn })
  for (const id of ids.filter((i) => open.has(i))) resolveEntry(tree, { id, by: resolvedBy, date: resolvedOn })
  return { resolvedDebt: ids.filter((i) => known.has(i)), goneDebt: ids.filter((i) => !known.has(i)), resolvedBy, resolvedOn }
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
  return runStep(ctx, 'move', (state) => {
    // The date placements named the archived directory with, so the Resolved by cells it wrote
    // name the directory the change lands in.
    const { resolvedOn } = settledDetail(state, 'placements')
    const out = archiveChange(ctx.root, ctx.change, { now: ctx.now(), ...(resolvedOn ? { date: resolvedOn } : {}) })
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

// The checked reply is an event of the dispatch `ingest` in the change's shared log
// (lib/attempts.mjs): the first refused reply goes back to the agent once (resumed with the
// errors, or afresh with them as its question when `resume` is false), the second stops archive,
// and nothing the stopped dispatch replies afterwards is recorded or written.
export function ingestStep(ctx, { reply = null, resume = true } = {}) {
  return runStep(ctx, 'ingest', (state) => {
    const { root, change } = ctx
    const context = ctx.knowledge()
    // Taken debt gone from the tree at placements is logged too: it is still this change's.
    const placed = settledDetail(state, 'placements')
    // removedDebt: a placements step recorded by 0.14.1-0.14.2, which removed the entries.
    const resolved = [...(placed.resolvedDebt ?? placed.removedDebt ?? []), ...(placed.goneDebt ?? [])]
    if (context.state === 'none') {
      const unlogged = resolved.length ? ` The resolved debt ${resolved.join(', ')} is not logged.` : ''
      return { state: 'skipped', detail: { report: `${knowledgeReport('log', context)}${unlogged}`, ...(resolved.length ? { resolvedDebt: resolved, debtLogged: false } : {}) } }
    }
    if (context.state !== 'done') refuse(knowledgeReport('context', context))
    if (!reply) refuse(`ingest needs --reply: run ingest.mjs stale --change ${change}, dispatch \`ingest\` at level architecture with its input, and pass the reply file`)
    const checked = checkIngestFile(root, change, reply, { exclude: settledDetail(state, 'placements').debtFiles ?? [] })
    const recorded = recordReply(root, change, { name: 'ingest', file: resolve(reply), errors: checked.errors, resume })
    if (!checked.valid) {
      const how = recorded.next === 'stop'
        ? 'a second refused reply of `ingest` stops archive; the developer decides what follows'
        : recorded.mode === 'resume' ? 'resume the `ingest` agent once with the errors' : 'dispatch `ingest` once more with the errors as its question'
      return {
        state: 'failed',
        refusal: `the ingest reply is refused: ${checked.errors.join('; ')}; ${how}`,
        detail: { errors: checked.errors, next: recorded.next, mode: recorded.mode, invalid: recorded.invalid }
      }
    }
    if (checked.log === null && resolved.length === 0) return { state: 'done', detail: { nothingLearned: true, paths: [], report: 'Knowledge: nothing learned that the code and the history do not carry; no page and no log entry.' } }
    const debtBullet = `Resolved debt, moved to its block's resolved.md in the debt tree: ${resolved.join(', ')}.`
    const log = checked.log === null
      ? { type: 'ingest', title: `Resolved debt of ${change}`, bullets: [debtBullet] }
      : { ...checked.log, bullets: [...checked.log.bullets, ...(resolved.length ? [debtBullet] : [])] }
    const result = ctx.knowledgeLog(log)
    if (result.state !== 'done') refuse(knowledgeReport('log', result))
    const isLog = matcher(checked.input.knowledge.log ?? [])
    const paths = [
      ...checked.reply.pages.map((p) => p.path),
      ...checked.reply.stale.filter((s) => s.outcome === 'removed').map((s) => s.path),
      ...workingChanges(root).filter(isLog)
    ]
    return {
      state: 'done',
      detail: { nothingLearned: checked.log === null, paths: [...new Set(paths)].sort(), report: knowledgeReport('log', result), ...(resolved.length ? { resolvedDebt: resolved, debtLogged: true } : {}) }
    }
  })
}

export function commitMemoryStep(ctx) {
  return runStep(ctx, 'commit-memory', (state) => {
    const own = new Set([...(settledDetail(state, 'ingest').paths ?? []), ...(settledDetail(state, 'placements').debtFiles ?? [])])
    return commitOwn(ctx, { mine: (f) => own.has(f), message: `docs(memory): ingest what ${ctx.change} taught` })
  })
}

// ---------------------------------------------------------------- the metrics record

const posix = (path) => path.split(sep).join('/')

export function metricsStep(ctx) {
  return runStep(ctx, 'metrics', (state) => {
    const { root, change } = ctx
    const { target } = settledDetail(state, 'move')
    if (!target) refuse('the move recorded no target; run archive.mjs move again')
    const committed = state.steps['commit-metrics']
    if (committed.state === 'done') {
      return { hold: true, out: { already: true, note: `the record is committed${committed.detail?.commit ? ` at ${committed.detail.commit.slice(0, 7)}` : ''}; a new record would measure its own commit, so nothing was written` } }
    }
    let record
    try {
      record = buildRecord({ root, change, now: ctx.now(), projectsDir: ctx.projectsDir, home: ctx.home })
    } catch (error) {
      if (!(error instanceof RecordError)) throw error
      return { state: 'failed', refusal: `${error.message}; nothing was written`, detail: { error: error.message, errors: error.errors } }
    }
    const file = `${target}/${RECORD_FILE}`
    writeFileSync(join(root, file), `${JSON.stringify(record, null, 2)}\n`)
    let attempts = null
    if (existsSync(attemptsFile(root, change))) {
      attempts = `${target}/attempts.jsonl`
      copyFileSync(attemptsFile(root, change), join(root, attempts))
    }
    const url = pricesUrl(root)
    const prices = { url, ...addEntry(root, ctx.fetchPrices(url, ctx.now)) }
    if (prices.path) prices.path = posix(prices.path)
    // A price entry an earlier run wrote is still this step's to commit.
    const earlier = (state.steps.metrics.detail?.files ?? []).filter((f) => f.startsWith('.adf/prices/') && existsSync(join(root, f)))
    const files = [...new Set([file, ...(attempts ? [attempts] : []), ...(prices.path ? [prices.path] : []), ...earlier])]
    const transcripts = record.sources.coverage.transcripts
    const detail = { file, attempts, files, prices, warnings: record.sources.warnings }
    if (transcripts === 'record') return { state: 'done', detail }
    return { state: 'degraded', detail: { ...detail, gap: `${transcripts.none}; the token, context and dispatch groups are null` } }
  })
}

export function commitMetricsStep(ctx) {
  return runStep(ctx, 'commit-metrics', (state) => {
    const own = new Set(settledDetail(state, 'metrics').files ?? [])
    return commitOwn(ctx, { mine: (f) => own.has(f), message: `chore(metrics): record ${ctx.change}` })
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
  return runStep(ctx, 'mr', (state) => {
    const ci = state.ci === false ? { ci: false } : {}
    if (!body) {
      const probe = ctx.forge('check', {})
      if (probe.state === 'none') return { state: 'skipped', detail: { forge: 'none', report: forgeReport('finalize', probe) } }
      const bodyFile = bodyPath(ctx.main, ctx.change)
      return {
        hold: true,
        out: {
          forge: probe.plugin ?? null,
          bodyFile,
          waiting: `the merge request body: run archive.mjs mr-input --change ${ctx.change}, write the body from it to ${bodyFile}, then archive.mjs mr --change ${ctx.change} --body ${bodyFile} --summary "<scope>: <description>"`
        }
      }
    }
    let text
    try {
      text = readFileSync(body, 'utf8')
    } catch (error) {
      return refuse(`--body ${body}: ${error.message}`)
    }
    const unnamed = unnamedKeys(ctx, text)
    if (unnamed.length) refuse(`the merge request body names no ${unnamed.join(', ')}; name every key of the change's scope.json (its taken and partial tracker keys and debt ids) in ${body}, then run mr again`, { unnamed })
    const input = forgeInput(
      'finalize',
      { change: ctx.change, branch: branchOf(ctx), base: baseOf(ctx), protected: readBranches(ctx.root)?.protected ?? null },
      { input: { body: text, ...ci }, title, summary }
    )
    const result = ctx.forge('finalize', input)
    const report = forgeReport('finalize', result)
    const forge = result.state === 'none' ? 'none' : result.plugin ?? null
    if (result.state === 'none') return { state: 'skipped', detail: { forge, report } }
    if (result.state === 'refused') return { state: 'failed', refusal: report, detail: { forge, report, error: result.error ?? null, ...ci } }
    if (result.state === 'degraded') {
      return { state: 'degraded', detail: { forge, report, hint: result.hint ?? null, fallback: result.fallback ?? [], inputFile: result.inputFile ?? null, body, ...ci } }
    }
    return { state: 'done', detail: { forge, report, url: result.url ?? null, branch: input.branch, base: input.base, ...ci } }
  })
}

// The keys of the change's scope.json that a merge request body does not name as a whole word.
// No scope.json, or one that takes nothing, has none.
function unnamedKeys(ctx, text) {
  return scopeKeys(changeScope(ctx)).filter((key) => !namesKey(text, key))
}

// ---------------------------------------------------------------- the local merge

// With no forge: merges the change branch into its base in the main checkout, on `yes` only,
// through lib/local-merge.mjs. Without `yes` and without `no` it prints the commands and records
// nothing; `no` records the developer's choice to merge it themselves.
export function mergeLocalStep(ctx, { yes = false, no = false } = {}) {
  return runStep(ctx, 'merge-local', (state) => {
    if (settledDetail(state, 'mr').forge !== 'none') {
      return { state: 'skipped', detail: { report: 'Local merge: none; a forge provider integrates the change through its merge request.' } }
    }
    const branch = branchOf(ctx)
    const base = baseOf(ctx)
    const merged = localMerge(ctx.main, { branch, base, yes: yes && !no })
    const { hold, commands, ...detail } = merged
    if (detail.already) return { state: 'done', detail }
    if (no) return { state: 'skipped', detail: { declined: true, branch, base, commands, report: `Local merge: declined; the developer merges ${branch} into ${base}.` } }
    if (hold) return { hold: true, out: { branch, base, commands, waiting: `the developer's yes: archive.mjs merge-local --change ${ctx.change} --yes, or --no to merge it by hand` } }
    return { state: 'done', detail }
  })
}

// ---------------------------------------------------------------- remove and the report

export function removeStep(ctx) {
  return runStep(ctx, 'remove', () => {
    const out = removeWorktree(ctx.main, { change: ctx.change }, { core: { ...CORE, ...(ctx.home ? { home: ctx.home } : {}) } })
    return { state: 'done', detail: out }
  })
}

const summary = {
  check: (d) => `review ${d.verdict} at ${String(d.commit).slice(0, 7)}${d.warnings?.length ? `; warnings: ${d.warnings.join('; ')}` : ''}`,
  placements: (d) =>
    `every debt, recorded finding and deviation placed${d.resolvedDebt?.length ? `; resolved debt moved to resolved.md: ${d.resolvedDebt.join(', ')}, resolved by ${d.resolvedBy}` : ''}${d.goneDebt?.length ? `; taken debt gone from the tree: ${d.goneDebt.join(', ')}` : ''}${d.debtFiles?.length ? `; debt files ${d.debtFiles.join(', ')}` : ''}`,
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
  metrics: (d) =>
    `${d.file}${d.attempts ? ` and ${d.attempts}` : '; no attempts.jsonl to copy'}; prices ${d.prices.state}${d.prices.path ? ` (${d.prices.path})` : ''}${d.prices.reason ? `: ${d.prices.reason}` : ''}${d.gap ? `; ${d.gap}` : ''}`,
  'commit-metrics': (d) => (d.commit ? `commit ${d.commit.slice(0, 7)}` : 'nothing to commit'),
  mr: (d) => d.report,
  'merge-local': (d) => d.report,
  remove: (d) => (d.state === 'removed' ? `worktree ${d.path} removed; branch ${d.branch} kept` : d.state === 'in-place' ? 'made in place; no worktree to remove' : 'no worktree left')
}

// The final report, built from the states. `complete` only when every step is done or
// skipped, or is metrics degraded: its record is written and committed with the gap named, and a
// re-run does not bring the transcripts back. A pending, failed or other degraded step is named.
const finished = (state, step) => FINAL.has(state.steps[step].state) || (step === 'metrics' && state.steps[step].state === 'degraded')

// How long ago an ISO time was, for the fetch age.
export function ago(iso, now) {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(minutes)) return 'at an unknown time'
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

// The integration ref fetched once (lib/window.mjs fetchRef), then the changes archived on it
// since the last window retro. Neither a failed fetch nor a failed read fails the report.
function sinceRetro(ctx) {
  let fetched
  try {
    fetched = ctx.fetchRef(ctx.root, { now: ctx.now })
  } catch (error) {
    fetched = { ref: null, fetched: false, fetchedAt: null, reason: `the fetch failed: ${error.message}` }
  }
  const now = ctx.now()
  const age = fetched.fetched
    ? `fetched ${ago(fetched.fetchedAt, now)}`
    : `not fetched: ${fetched.reason}${fetched.fetchedAt ? `; last fetched ${ago(fetched.fetchedAt, now)}` : ''}`
  try {
    const since = sinceLastRetro(ctx.root, { ...(fetched.ref ? { ref: fetched.ref } : {}), ...(fetched.fetchedAt ? { fetchedAt: fetched.fetchedAt } : {}) })
    const anchor = since.previous ? `Since the last window retro (${since.previous.date})` : 'Since the first archive (no window retro yet)'
    const what = since.count === 0 ? 'no change archived' : `${since.count} change${since.count === 1 ? '' : 's'} archived (${since.changes.join(', ')})`
    return { fetch: fetched, since, line: `${anchor}: ${what} on ${since.ref} (${age}).` }
  } catch (error) {
    return { fetch: fetched, since: null, line: `Changes since the last window retro: not read (${error.message}); ${fetched.ref ?? 'the integration ref'} ${age}.` }
  }
}

// The layers and checks quiet for QUIET_RUN changes, read from the archived records under the
// report's root; information only.
function removalLine(ctx) {
  let got
  try {
    got = candidates(ctx.root)
  } catch (error) {
    return { candidates: null, line: `Removal candidates: not read (${error.message}).` }
  }
  const parts = [...(got.layers.length ? [`layers ${got.layers.join(', ')}`] : []), ...(got.checks.length ? [`checks ${got.checks.join(', ')}`] : [])]
  return { candidates: { layers: got.layers, checks: got.checks }, line: parts.length ? `Removal candidates, quiet for ${QUIET_RUN} changes (information only): ${parts.join('; ')}.` : null }
}

// Pure: what in a change's record says the flow hurt: a stopped dispatch, the review round cap
// reached, a context compaction.
export function hurtSignals(input) {
  const record = asV2(input) ?? {}
  const out = []
  const stops = Object.entries(record.replies ?? {}).filter(([, r]) => r?.stops > 0)
  if (stops.length) out.push(`a stopped dispatch (${stops.map(([role, r]) => `${role} ${r.stops}`).join(', ')})`)
  if (record.review?.stopped) out.push('the review stage stopped on a second invalid reply')
  if (record.review?.rounds >= ROUND_CAP) out.push(`the review reached its round cap (${record.review.rounds} rounds, cap ${ROUND_CAP})`)
  if (record.context?.compactions > 0) out.push(`${record.context.compactions} context compaction${record.context.compactions === 1 ? '' : 's'}`)
  return out
}

// This change's record: from the commit-metrics commit when there is one (the worktree may be
// gone), else from the report's root. Null while the metrics step is pending.
function recordSignals(ctx, state) {
  const metrics = state.steps.metrics
  if (metrics.state === 'pending') return { signals: null, lines: [] }
  if (metrics.state === 'failed') return { signals: null, lines: [`No metrics record: the metrics step failed (${metrics.detail?.error ?? 'no reason recorded'}); the hurt signals were not read.`] }
  const file = metrics.detail?.file
  const commit = state.steps['commit-metrics'].detail?.commit
  let text = null
  if (file && commit) {
    const shown = spawnSync('git', ['show', `${commit}:${file}`], { cwd: ctx.root, encoding: 'utf8', maxBuffer: 1 << 26 })
    if (shown.status === 0) text = shown.stdout
  }
  if (text === null && file && existsSync(join(ctx.root, file))) text = readFileSync(join(ctx.root, file), 'utf8')
  let record = null
  try {
    record = text === null ? null : JSON.parse(text)
  } catch {}
  if (!record) return { signals: null, lines: [`No metrics record: ${file ?? 'the metrics step named no file'} could not be read; the hurt signals were not read.`] }
  const signals = hurtSignals(record)
  if (!signals.length) return { signals, lines: [] }
  return { signals, lines: [`Hurt signals in the record: ${signals.join('; ')}.`, `Suggested: /adf:retro --change ${ctx.change}.`] }
}

export function report(ctx) {
  const state = readArchiveState(ctx.main, ctx.change)
  const complete = STEPS.every((s) => finished(state, s))
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
  const open = STEPS.filter((s) => !finished(state, s))
  const handEdited = state.steps.check.detail?.handEdited ?? []
  const window = sinceRetro(ctx)
  const due = [
    ...(handEdited.length ? [`verify.md lists hand-edited capability prose (${handEdited.join('; ')})`] : []),
    ...(window.since?.lintDue ? [`${window.since.count} changes archived ${window.since.previous ? 'since the last window retro' : 'and no window retro yet'} (${LINT_DUE} or more)`] : [])
  ]
  const removal = removalLine(ctx)
  const hurt = recordSignals(ctx, state)
  const notes = [
    window.line,
    ...(due.length ? [`Corpus lint due: ${due.join('; ')}; run the spec corpus lint over openspec/specs/, which reports and never gates.`] : []),
    ...(removal.line ? [removal.line] : []),
    ...hurt.lines
  ]
  const mr = state.steps.mr
  const scoped = findScope(ctx.main, ctx.change)?.scope
  const land = trackerTargets(scoped).length || debtGroups(scoped).length ? `/adf:land ${ctx.change}` : null
  const heading = complete ? `## Archive complete: ${ctx.change}` : `## Archive not complete: ${ctx.change}`
  const tail = complete
    ? land
      ? ['', `Next: ${land}, once the change is merged: it hands each tracker issue of the scope to its tester.`]
      : []
    : [
        '',
        `Not finished: ${open.map((s) => `${s} (${state.steps[s].state})`).join(', ')}.`,
        ...(mr.state === 'degraded' ? ['The merge request is not ready: run the fallback the mr step recorded, then archive.mjs mr again.'] : []),
        ...(nextStep(state) ? [`Next: archive.mjs ${nextStep(state)} --change ${ctx.change}.`] : [])
      ]
  return {
    ok: true,
    change: ctx.change,
    complete,
    next: nextStep(state),
    land,
    steps: state.steps,
    handEdited,
    window: { fetch: window.fetch, since: window.since },
    lintDue: due.length > 0,
    candidates: removal.candidates,
    signals: hurt.signals,
    report: [heading, '', ...lines, '', ...notes, ...tail].join('\n')
  }
}
