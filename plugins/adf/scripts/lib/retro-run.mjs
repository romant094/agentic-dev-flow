// /adf:retro's deterministic steps, each recording its own state, so a retrospective resumes
// from the step that failed and a re-run of a finished step changes nothing.
//
// The steps, in order: start, window, reply, render, record, publish, file. A step runs once
// every step before it is settled (`done`, `degraded` or `skipped`); `file` needs only the steps
// before `publish`, since the committed sidecar is what it files from. A `done` or `skipped` step
// is reported as it is, never run again; a `failed` or `degraded` one runs again. A step waiting
// for the developer's yes holds: `pending`, nothing recorded.
//
// The state is kept per retrospective in the main checkout's `.superpowers/retro/<date>/`
// (state.json and the sidecar), as archive keeps its state in the main checkout; the input,
// the replies and the attempts log of the `retro <date>` dispatch are in the retrospective
// worktree's `.superpowers/retro/<date>/` (lib/dispatch.mjs retroDir), where the agent works.
//
//   start    the integration ref fetched (lib/window.mjs fetchRef); branch `chore/retro/<date>`
//            and its worktree `.claude/worktrees/retro-<date>` made from the integration branch
//            as propose makes a change's (lib/workspace.mjs create); the main checkout is never
//            written. The mode and its scope are kept: a second start with others is refused.
//   window   buildSidecar over the ref, fetched again, with the knowledge provider's `paths`
//            excluded from the diff figures; the agent's input (lib/retro.mjs input) and its
//            prompt written; the dispatch recorded and its plan returned for the orchestrator
//   reply    lib/retro.mjs recordRetroReply: a refused reply is retried once, the second stops
//            the retrospective; a valid one's computed result is kept in the state
//   render   `.adf/retro/<date>-<mode>.json` (the sidecar and the computed reply) and `.md`
//            (lib/retro-render.mjs) in the retro worktree
//   record   lib/commit.mjs commitPaths, only those two files: `docs(retro): <mode>
//            retrospective <date>`
//   publish  the forge role's `open`, `draft: false`, `ci: false`, into the integration branch;
//            never merged with a forge. With none: held until the developer's yes, then a local
//            merge in the main checkout (lib/local-merge.mjs, archive's merge-local rule)
//   file     the upstream role's `file` with `{ report, findings }` after the developer's yes;
//            with no provider `skipped`, and the findings stay in the sidecar
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readBranches, requireBranches } from './branches.mjs'
import { commitPaths } from './commit.mjs'
import { DispatchError, planDispatch, renderPrompt, retroDir, retroInputFile } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { localMerge } from './local-merge.mjs'
import { PLUGIN_ROOT } from './metrics.mjs'
import { input, recordRetroDispatch, recordRetroReply } from './retro.mjs'
import { renderRetro, retroDocument } from './retro-render.mjs'
import { callRole, CORE, forgeInput, forgeReport, knowledgePaths, upstreamReport } from './roles.mjs'
import { claudeHome } from './superpowers.mjs'
import { buildSidecar, fetchRef, MODES, RETRO_DIR, sinceLastRetro } from './window.mjs'
import { create, gitIn, worktreePath, worktrees } from './workspace.mjs'

export const STEPS = ['start', 'window', 'reply', 'render', 'record', 'publish', 'file']
const SETTLED = new Set(['done', 'degraded', 'skipped'])
const FINAL = new Set(['done', 'skipped'])
const NEEDS = Object.fromEntries(STEPS.map((s, i) => [s, STEPS.slice(0, s === 'file' ? STEPS.indexOf('publish') : i)]))
const DAY = /^\d{4}-\d{2}-\d{2}$/
const PROMPTS_DIR = join(PLUGIN_ROOT, 'schema', 'prompts')

export class Refusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}

const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

// ---------------------------------------------------------------- names and paths

export const retroBranch = (date) => `chore/retro/${date}`
export const worktreeName = (date) => `retro-${date}`
export const retroTitle = (mode, date) => `docs(retro): ${mode} retrospective ${date}`
export const retroFiles = (date, mode) => [`${RETRO_DIR}/${date}-${mode}.json`, `${RETRO_DIR}/${date}-${mode}.md`]
export const statePath = (main, date) => join(retroDir(main, date), 'state.json')
export const sidecarPath = (main, date) => join(retroDir(main, date), 'sidecar.json')
export const promptPath = (worktree, date) => join(retroDir(worktree, date), 'prompt.md')

// ---------------------------------------------------------------- state

export function readState(main, date) {
  const path = statePath(main, date)
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return { date, mode: saved.mode ?? null, scope: saved.scope ?? null, steps: Object.fromEntries(STEPS.map((s) => [s, saved.steps?.[s] ?? { state: 'pending' }])) }
}

function writeState(main, date, state) {
  const path = statePath(main, date)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return state
}

export const nextStep = (state) => STEPS.find((s) => !SETTLED.has(state.steps[s].state)) ?? null

// The newest retrospective started in the main checkout, or null.
export function latestDate(main) {
  const dir = join(main, '.superpowers', 'retro')
  if (!existsSync(dir)) return null
  return readdirSync(dir).filter((d) => DAY.test(d) && existsSync(statePath(main, d))).sort().at(-1) ?? null
}

// ---------------------------------------------------------------- context

const today = (now) => now().toISOString().slice(0, 10)

// deps: { now() -> Date, home, fault(step), knowledgePaths(root) -> { state, paths },
// forge(operation, input) -> role result, upstream(operation, input) -> role result }. `date`
// defaults, for `start`, to today; for the other steps, to the newest retrospective started.
export function retroContext(rootArg, { date, start = false, deps = {} } = {}) {
  const given = resolve(rootArg)
  if (!existsSync(given)) refuse(`${given} does not exist; pass the host checkout or the retro worktree as --root`)
  const main = realpathSync(mainCheckout(realpathSync(given)))
  const now = deps.now ?? (() => new Date())
  const resolved = date ?? (start ? today(now) : latestDate(main))
  if (!resolved) refuse(`no retrospective is started in ${main}; run retro.mjs start first`)
  if (!start && !existsSync(statePath(main, resolved))) refuse(`no retrospective of ${resolved} is started in ${main}; run retro.mjs start --date ${resolved} first`)
  const home = deps.home ?? claudeHome()
  const core = { ...CORE, home }
  return {
    main,
    date: resolved,
    now,
    home,
    fault: deps.fault ?? null,
    knowledgePaths: deps.knowledgePaths ?? ((root) => knowledgePaths(root, core)),
    forge: deps.forge ? (op, inp) => deps.forge(op, inp) : (op, inp, root) => callRole(root, 'forge', op, inp, core),
    upstream: deps.upstream ? (op, inp) => deps.upstream(op, inp) : (op, inp, root) => callRole(root, 'upstream', op, inp, core)
  }
}

// ---------------------------------------------------------------- running a step

// Runs one step under the state rules. `fn(state)` returns { state, detail, refusal?, out? } or
// { hold: true, out } (nothing recorded), or throws; a throw records `failed` with its message.
export function runStep(ctx, step, fn) {
  const before = readState(ctx.main, ctx.date)
  const current = before.steps[step]
  const base = { date: ctx.date, mode: before.mode, step }
  if (FINAL.has(current.state)) return { ok: true, ...base, state: current.state, already: true, detail: current.detail ?? null, next: nextStep(before) }
  const waiting = NEEDS[step].filter((s) => !SETTLED.has(before.steps[s].state))
  if (waiting.length > 0) refuse(`${step} waits for ${waiting.join(', ')}; run retro.mjs ${waiting[0]} --date ${ctx.date} first`)
  let result
  try {
    ctx.fault?.(step)
    result = fn(before)
  } catch (error) {
    result = { state: 'failed', refusal: error.message, detail: { error: error.message, ...(error.extra ?? {}) } }
  }
  if (result.hold) return { ok: true, ...base, state: 'pending', pending: true, detail: null, next: nextStep(before), ...result.out }
  const record = { state: result.state, at: ctx.now().toISOString(), detail: result.detail ?? null }
  const after = readState(ctx.main, ctx.date)
  after.steps[step] = record
  writeState(ctx.main, ctx.date, after)
  return { ok: result.state !== 'failed', ...base, state: result.state, detail: record.detail, next: nextStep(after), ...(result.refusal ? { refusal: result.refusal } : {}), ...(result.out ?? {}) }
}

const worktreeOf = (state) => state.steps.start.detail.worktree
const real = (path) => (existsSync(path) ? realpathSync(path) : path)

// ---------------------------------------------------------------- start

// scope: { mode, change?, from?, to? }, checked by the CLI.
export function startStep(ctx, scope) {
  if (!MODES.includes(scope.mode)) refuse(`mode must be one of ${MODES.join(', ')}`)
  const kept = { mode: scope.mode, ...(scope.change ? { change: scope.change } : {}), ...(scope.from ? { from: scope.from, to: scope.to } : {}) }
  const saved = readState(ctx.main, ctx.date)
  if (saved.mode !== null && JSON.stringify({ mode: saved.mode, ...saved.scope }) !== JSON.stringify(kept)) {
    refuse(`the retrospective of ${ctx.date} started as ${JSON.stringify({ mode: saved.mode, ...saved.scope })}, not ${JSON.stringify(kept)}; one retrospective per date`)
  }
  if (saved.mode === null) {
    const { mode, ...rest } = kept
    writeState(ctx.main, ctx.date, { ...saved, mode, scope: rest })
  }
  return runStep(ctx, 'start', () => {
    const fetch = fetchRef(ctx.main)
    const { integration } = requireBranches(ctx.main)
    const branch = retroBranch(ctx.date)
    const path = worktreePath(ctx.main, worktreeName(ctx.date))
    const existing = worktrees(gitIn(ctx.main)).find((w) => real(w.path) === real(path))
    if (existing && existing.branch !== branch) refuse(`${path} holds ${existing.branch ?? 'a detached HEAD'}, not ${branch}; remove it by hand, then run start again`)
    // A worktree a failed run made is the retrospective's: it is adopted, not made twice.
    const made = existing ? { root: real(path), branch, base: integration, baseRef: null, adopted: true } : create(ctx.main, { change: worktreeName(ctx.date), branch, base: 'integration' })
    return { state: 'done', detail: { fetch, worktree: real(made.root), branch, base: made.base, baseRef: made.baseRef, ...(made.adopted ? { adopted: true } : {}) } }
  })
}

// ---------------------------------------------------------------- window

function skeletons() {
  return Object.fromEntries(
    readdirSync(PROMPTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => [f.slice(0, -3), readFileSync(join(PROMPTS_DIR, f), 'utf8')])
  )
}

export function windowStep(ctx) {
  return runStep(ctx, 'window', (state) => {
    const wt = worktreeOf(state)
    const knowledge = ctx.knowledgePaths(wt)
    const exclude = knowledge.state === 'done' ? knowledge.paths : []
    const fetch = fetchRef(wt)
    const asOf = new Date(Math.min(Date.parse(`${ctx.date}T23:59:59.999Z`), ctx.now().getTime())).toISOString()
    const sidecar = buildSidecar(wt, { mode: state.mode, ...state.scope, ref: fetch.ref, date: ctx.date, asOf, exclude, fetchedAt: fetch.fetchedAt })
    const sidecarFile = sidecarPath(ctx.main, ctx.date)
    mkdirSync(dirname(sidecarFile), { recursive: true })
    writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`)
    const inputFile = retroInputFile(wt, ctx.date)
    mkdirSync(dirname(inputFile), { recursive: true })
    writeFileSync(inputFile, `${JSON.stringify(input(sidecar, { root: wt, home: ctx.home }), null, 2)}\n`)
    const plan = planDispatch({ role: 'retro', date: ctx.date }, { root: wt, main: ctx.main, planText: null, exists: existsSync })
    const fields = [
      ['Dispatch name', plan.name],
      ['Worktree', wt],
      ['Input file', plan.inputFile],
      ['Reply file', plan.replyFile]
    ]
    const promptFile = promptPath(wt, ctx.date)
    writeFileSync(promptFile, `${renderPrompt({ plan, skeletons: skeletons(), fields, tokens: { '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT, '<root>': wt, '<worktree>': wt } })}\n`)
    const attempt = recordRetroDispatch(wt, ctx.date, { now: ctx.now().toISOString() })
    return {
      state: 'done',
      detail: {
        fetch,
        knowledge: { state: knowledge.state, excluded: exclude, ...(knowledge.error ? { error: knowledge.error } : {}) },
        sidecar: sidecarFile,
        inputFile,
        changes: sidecar.changes.map((c) => c.change),
        coverage: sidecar.coverage,
        dispatch: { ...plan, promptFile, attempt: attempt.attempt }
      }
    }
  })
}

// ---------------------------------------------------------------- reply

export function replyStep(ctx, { file, resume = true }) {
  return runStep(ctx, 'reply', (state) => {
    const wt = worktreeOf(state)
    let out
    try {
      out = recordRetroReply(wt, ctx.date, { file, resume, now: ctx.now().toISOString() })
    } catch (error) {
      if (!(error instanceof DispatchError)) throw error
      return { state: 'failed', refusal: error.message, detail: { next: 'stop', error: error.message } }
    }
    if (!out.valid) {
      const what = out.next === 'stop' ? 'the retrospective stops: a second invalid reply' : 'retry once, the agent resumed'
      return { state: 'failed', refusal: `the retro reply was refused (${what}): ${out.errors.join('; ')}`, detail: { next: out.next, mode: out.mode, invalid: out.invalid, errors: out.errors, replyFile: out.replyFile, error: out.errors.join('; ') } }
    }
    return { state: 'done', detail: { next: 'proceed', replyFile: out.replyFile, result: out.result } }
  })
}

// ---------------------------------------------------------------- render and record

export function renderStep(ctx) {
  return runStep(ctx, 'render', (state) => {
    const wt = worktreeOf(state)
    const sidecar = JSON.parse(readFileSync(sidecarPath(ctx.main, ctx.date), 'utf8'))
    const computed = state.steps.reply.detail.result
    const [json, md] = retroFiles(ctx.date, state.mode)
    mkdirSync(join(wt, RETRO_DIR), { recursive: true })
    writeFileSync(join(wt, json), `${JSON.stringify(retroDocument(sidecar, computed), null, 2)}\n`)
    writeFileSync(join(wt, md), renderRetro(sidecar, computed))
    return { state: 'done', detail: { files: [json, md] } }
  })
}

export function recordStep(ctx) {
  return runStep(ctx, 'record', (state) => {
    const wt = worktreeOf(state)
    const files = state.steps.render.detail.files
    const message = retroTitle(state.mode, ctx.date)
    const git = gitIn(wt)
    // A run that committed and failed before its state was saved: the commit is the step's.
    if (git('status', '--porcelain', '--', ...files) === '') {
      const [commit, subject] = git('log', '-1', '--format=%H%x09%s', '--', ...files).split('\t')
      if (commit && subject === message) return { state: 'done', detail: { commit, files, adopted: true } }
    }
    const made = commitPaths(wt, { only: files, message })
    return { state: 'done', detail: { commit: made.commit, branch: made.branch, files: made.files } }
  })
}

// ---------------------------------------------------------------- publish

export function publishStep(ctx, { yes = false } = {}) {
  return runStep(ctx, 'publish', (state) => {
    const wt = worktreeOf(state)
    const { branch, base } = state.steps.start.detail
    const title = retroTitle(state.mode, ctx.date)
    const forgeIn = forgeInput('open', { change: worktreeName(ctx.date), branch, base, protected: readBranches(wt)?.protected ?? null }, { input: { ci: false }, title, draft: false })
    const result = ctx.forge('open', forgeIn, wt)
    const report = forgeReport('open', result, { draft: false })
    if (result.state === 'none') {
      const merged = localMerge(ctx.main, { branch, base, yes })
      if (merged.hold) {
        return { hold: true, out: { forge: 'none', report, branch, base, commands: merged.commands, waiting: `the developer's yes: retro.mjs publish --date ${ctx.date} --yes merges ${branch} into ${base} in the main checkout` } }
      }
      const { hold: _h, ...detail } = merged
      return { state: 'done', detail: { forge: 'none', ...detail } }
    }
    const forge = result.plugin ?? null
    if (result.state === 'refused') return { state: 'failed', refusal: report, detail: { forge, report, error: result.error ?? report } }
    if (result.state === 'degraded') return { state: 'degraded', detail: { forge, report, hint: result.hint ?? null, fallback: result.fallback ?? [] } }
    return { state: 'done', detail: { forge, report, url: result.url ?? null, number: result.number ?? null, reused: Boolean(result.reused), ci: false, draft: false } }
  })
}

// ---------------------------------------------------------------- file

// findings: the ids to file, default every finding of the reply.
export function fileStep(ctx, { yes = false, findings } = {}) {
  return runStep(ctx, 'file', (state) => {
    const wt = worktreeOf(state)
    const all = state.steps.reply.detail.result.findings.map((f) => f.id)
    const ids = findings ?? all
    const unknown = ids.filter((id) => !all.includes(id))
    if (unknown.length > 0) refuse(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a finding of this retrospective; its findings: ${all.join(', ') || 'none'}`)
    const report = state.steps.render.detail.files[0]
    if (ids.length === 0) return { state: 'skipped', detail: { report, findings: [], text: 'Upstream: nothing to file; the retrospective has no finding.' } }
    const probe = ctx.upstream('check', {}, wt)
    if (probe.state === 'none') return { state: 'skipped', detail: { upstream: 'none', report, findings: ids, text: upstreamReport('file', probe) } }
    const fileIn = { report, findings: ids }
    if (!yes) return { hold: true, out: { upstream: probe.plugin ?? null, would: fileIn, waiting: `the developer's yes: retro.mjs file --date ${ctx.date} --yes${findings ? ` --findings ${ids.join(',')}` : ''}` } }
    const result = ctx.upstream('file', fileIn, wt)
    const text = upstreamReport('file', result)
    const upstream = result.state === 'none' ? 'none' : (result.plugin ?? null)
    if (result.state === 'none') return { state: 'skipped', detail: { upstream, report, findings: ids, text } }
    if (result.state === 'refused') return { state: 'failed', refusal: text, detail: { upstream, report, findings: ids, text, error: result.error ?? text } }
    if (result.state === 'degraded') return { state: 'degraded', detail: { upstream, report, findings: ids, text, hint: result.hint ?? null } }
    return { state: 'done', detail: { upstream, report, findings: ids, issues: result.issues ?? [], text } }
  })
}

// ---------------------------------------------------------------- read-only

// The changes archived on the integration ref since the last window retrospective, after a fetch.
export function since(rootArg) {
  const root = realpathSync(resolve(rootArg))
  const fetch = fetchRef(root)
  return { ok: true, fetch, ...sinceLastRetro(root, { ref: fetch.ref, fetchedAt: fetch.fetchedAt }) }
}

export function stateOf(ctx) {
  const state = readState(ctx.main, ctx.date)
  return { ok: true, ...state, next: nextStep(state) }
}
