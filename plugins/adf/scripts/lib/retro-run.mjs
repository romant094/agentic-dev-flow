// /adf:retro's deterministic steps, each recording its own state, so a retrospective resumes
// from the step that failed and a re-run of a finished step changes nothing.
//
// A retrospective is named by its id: `<date>-window`, `<date>-period`, or `<date>-<change>` for
// one change, so several retrospectives may share a date. The id names its branch, worktree,
// state, files and dispatch.
//
// The steps, in order: start, window, reply, file, render, record, publish, remove. A step runs
// once every step before it is settled (`done`, `degraded` or `skipped`). A `done` or `skipped`
// step is reported as it is, never run again; a `failed` or `degraded` one runs again, `file`
// only while `render` has not run, since its links and the debt's Filed column go into the
// report and the commit. A step waiting for the developer's yes holds: `pending`, nothing
// recorded.
//
// The state is kept per retrospective in the main checkout's `.superpowers/retro/<id>/`
// (state.json and the sidecar), as archive keeps its state in the main checkout; the input,
// the replies and the attempts log of the `retro <id>` dispatch are in the retrospective
// worktree's `.superpowers/retro/<id>/` (lib/dispatch.mjs retroDir), where the agent works.
//
//   start    the integration ref fetched (lib/window.mjs fetchRef); branch `chore/retro/<id>`
//            and its worktree `.claude/worktrees/retro-<id>` made from the integration branch
//            as propose makes a change's (lib/workspace.mjs create); the main checkout is never
//            written. The mode and its scope are kept: a second start with others is refused.
//   window   buildSidecar over the ref, fetched again, with the knowledge provider's `paths`
//            excluded from the diff figures and the ADF debt not yet filed; the agent's input (lib/retro.mjs input) and its
//            prompt written; the dispatch recorded and its plan returned for the orchestrator
//   reply    lib/retro.mjs recordRetroReply: a refused reply is retried once, the second stops
//            the retrospective; on `retry` the next attempt's dispatch is recorded here, so the
//            metrics count every dispatch; a valid one's computed result is kept in the state
//   file     the upstream role's `check` with `{ repository }`, then, after the developer's yes,
//            its `file` with `{ repository, host, retro, findings, debt }`: the computed findings
//            and the window's unfiled ADF debt records, each list filtered by the developer. No
//            provider: `skipped`, the findings stay in the sidecar and the debt unfiled; a
//            degraded check: `degraded` with its hint, a refused one: `failed`, nothing sent.
//            After a `done` file, each debt record filed is marked filed in the retro worktree's
//            debt tree (lib/debt.mjs markFiled), so its Filed column lands in the retro commit
//   render   `.adf/retro/<id>.json` (the sidecar, the computed reply and the issue links) and
//            `.md` (lib/retro-render.mjs) in the retro worktree
//   record   lib/commit.mjs commitPaths, only those two files and the debt tree files `file`
//            changed: `docs(retro): <mode> retrospective <date>`, with ` of <change>` for one
//            change
//   publish  the forge role's `open`, `draft: false`, `ci: false`, into the integration branch;
//            never merged with a forge. With none: held until the developer's yes, then a local
//            merge in the main checkout (lib/local-merge.mjs, archive's merge-local rule); the
//            developer's no ends it `skipped`, the branch kept and the commands kept
//   remove   the retro worktree removed from the main checkout as archive removes a change's
//            (lib/workspace.mjs remove): a dirty tree refused, never forced, the branch kept
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readBranches, requireBranches } from './branches.mjs'
import { commitPaths } from './commit.mjs'
import { BLOCK_INDEX, markFiled } from './debt.mjs'
import { DispatchError, planDispatch, renderPrompt, replyFile, RETRO_ID, retroDir, retroInputFile } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { localMerge } from './local-merge.mjs'
import { PLUGIN_ROOT } from './metrics.mjs'
import { input, recordRetroDispatch, recordRetroReply } from './retro.mjs'
import { renderRetro, retroDocument } from './retro-render.mjs'
import { readDebtRoot } from './registry.mjs'
import { callRole, CORE, coreRepository, forgeInput, forgeReport, hostSlug, knowledgePaths, upstreamReport } from './roles.mjs'
import { claudeHome } from './superpowers.mjs'
import { buildSidecar, fetchRef, MODES, RETRO_DIR, sinceLastRetro } from './window.mjs'
import { create, gitIn, remove as removeWorktree, worktreePath, worktrees } from './workspace.mjs'

export const STEPS = ['start', 'window', 'reply', 'file', 'render', 'record', 'publish', 'remove']
const SETTLED = new Set(['done', 'degraded', 'skipped'])
const FINAL = new Set(['done', 'skipped'])
const NEEDS = Object.fromEntries(STEPS.map((s, i) => [s, STEPS.slice(0, i)]))
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

// The id of a retrospective: its date and its mode, or, for one change, the change's name.
export const retroId = (date, { mode, change }) => `${date}-${mode === 'change' ? change : mode}`
export const retroBranch = (id) => `chore/retro/${id}`
export const worktreeName = (id) => `retro-${id}`
export const retroTitle = ({ mode, date, scope }) => `docs(retro): ${mode} retrospective ${date}${mode === 'change' ? ` of ${scope.change}` : ''}`
export const retroFiles = (id) => [`${RETRO_DIR}/${id}.json`, `${RETRO_DIR}/${id}.md`]
export const statePath = (main, id) => join(retroDir(main, id), 'state.json')
export const sidecarPath = (main, id) => join(retroDir(main, id), 'sidecar.json')
export const promptPath = (worktree, id) => join(retroDir(worktree, id), 'prompt.md')

// ---------------------------------------------------------------- state

export function readState(main, id) {
  const path = statePath(main, id)
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return {
    id,
    date: saved.date ?? null,
    mode: saved.mode ?? null,
    scope: saved.scope ?? null,
    startedAt: saved.startedAt ?? null,
    steps: Object.fromEntries(STEPS.map((s) => [s, saved.steps?.[s] ?? { state: 'pending' }]))
  }
}

function writeState(main, id, state) {
  const path = statePath(main, id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return state
}

export const nextStep = (state) => STEPS.find((s) => !SETTLED.has(state.steps[s].state)) ?? null

// The id of the newest retrospective started in the main checkout, by its start time, or null.
export function latestId(main) {
  const dir = join(main, '.superpowers', 'retro')
  if (!existsSync(dir)) return null
  const started = readdirSync(dir)
    .filter((id) => RETRO_ID.test(id) && existsSync(statePath(main, id)))
    .map((id) => ({ id, at: readState(main, id).startedAt ?? '' }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  return started.at(-1)?.id ?? null
}

// ---------------------------------------------------------------- context

const today = (now) => now().toISOString().slice(0, 10)

// deps: { now() -> Date, home, fault(step), knowledgePaths(root) -> { state, paths },
// forge(operation, input) -> role result, upstream(operation, input) -> role result,
// repository: the `owner/name` filed in, default the core manifest's }. For
// `start`, the id is made from `date` (default today) and the `scope`'s mode; for the other
// steps, `id` names a started retrospective, default the newest started.
export function retroContext(rootArg, { id, date, scope, start = false, deps = {} } = {}) {
  const given = resolve(rootArg)
  if (!existsSync(given)) refuse(`${given} does not exist; pass the host checkout, or the retro worktree while it exists, as --root`)
  const main = realpathSync(mainCheckout(realpathSync(given)))
  const now = deps.now ?? (() => new Date())
  let resolved
  let day
  if (start) {
    day = date ?? today(now)
    resolved = retroId(day, scope)
  } else {
    resolved = id ?? latestId(main)
    if (!resolved) refuse(`no retrospective is started in ${main}; run retro.mjs start first`)
    if (!existsSync(statePath(main, resolved))) refuse(`no retrospective ${resolved} is started in ${main}; run retro.mjs start first`)
    day = readState(main, resolved).date
  }
  const home = deps.home ?? claudeHome()
  const core = { ...CORE, home }
  return {
    main,
    id: resolved,
    date: day,
    now,
    home,
    fault: deps.fault ?? null,
    repository: deps.repository ? () => deps.repository : () => coreRepository(),
    knowledgePaths: deps.knowledgePaths ?? ((root) => knowledgePaths(root, core)),
    forge: deps.forge ? (op, inp) => deps.forge(op, inp) : (op, inp, root) => callRole(root, 'forge', op, inp, core),
    upstream: deps.upstream ? (op, inp) => deps.upstream(op, inp) : (op, inp, root) => callRole(root, 'upstream', op, inp, core)
  }
}

// ---------------------------------------------------------------- running a step

// Runs one step under the state rules. `fn(state)` returns { state, detail, refusal?, out? } or
// { hold: true, out } (nothing recorded), or throws; a throw records `failed` with its message.
export function runStep(ctx, step, fn) {
  const before = readState(ctx.main, ctx.id)
  const current = before.steps[step]
  const base = { id: ctx.id, date: ctx.date, mode: before.mode, step }
  if (FINAL.has(current.state)) return { ok: true, ...base, state: current.state, already: true, detail: current.detail ?? null, next: nextStep(before) }
  const waiting = NEEDS[step].filter((s) => !SETTLED.has(before.steps[s].state))
  if (waiting.length > 0) refuse(`${step} waits for ${waiting.join(', ')}; run retro.mjs ${waiting[0]} --id ${ctx.id} first`)
  let result
  try {
    ctx.fault?.(step)
    result = fn(before)
  } catch (error) {
    result = { state: 'failed', refusal: error.message, detail: { error: error.message, ...(error.extra ?? {}) } }
  }
  if (result.hold) return { ok: true, ...base, state: 'pending', pending: true, detail: null, next: nextStep(before), ...result.out }
  const record = { state: result.state, at: ctx.now().toISOString(), detail: result.detail ?? null }
  const after = readState(ctx.main, ctx.id)
  after.steps[step] = record
  writeState(ctx.main, ctx.id, after)
  return { ok: result.state !== 'failed', ...base, state: result.state, detail: record.detail, next: nextStep(after), ...(result.refusal ? { refusal: result.refusal } : {}), ...(result.out ?? {}) }
}

const worktreeOf = (state) => state.steps.start.detail.worktree
const real = (path) => (existsSync(path) ? realpathSync(path) : path)

// ---------------------------------------------------------------- start

// scope: { mode, change?, from?, to? }, checked by the CLI.
export function startStep(ctx, scope) {
  if (!MODES.includes(scope.mode)) refuse(`mode must be one of ${MODES.join(', ')}`)
  const kept = { mode: scope.mode, ...(scope.change ? { change: scope.change } : {}), ...(scope.from ? { from: scope.from, to: scope.to } : {}) }
  if (scope.mode === 'change' && MODES.includes(scope.change)) refuse(`a change named "${scope.change}" would share the id of a ${scope.change} retrospective; rename it, or run a period retrospective`)
  const saved = readState(ctx.main, ctx.id)
  if (saved.mode !== null && JSON.stringify({ mode: saved.mode, ...saved.scope }) !== JSON.stringify(kept)) {
    refuse(`the retrospective ${ctx.id} started as ${JSON.stringify({ mode: saved.mode, ...saved.scope })}, not ${JSON.stringify(kept)}; one retrospective per id`)
  }
  if (saved.mode === null) {
    const { mode, ...rest } = kept
    writeState(ctx.main, ctx.id, { ...saved, date: ctx.date, mode, scope: rest, startedAt: ctx.now().toISOString() })
  }
  return runStep(ctx, 'start', () => {
    const fetch = fetchRef(ctx.main)
    const { integration } = requireBranches(ctx.main)
    const branch = retroBranch(ctx.id)
    const path = worktreePath(ctx.main, worktreeName(ctx.id))
    const existing = worktrees(gitIn(ctx.main)).find((w) => real(w.path) === real(path))
    if (existing && existing.branch !== branch) refuse(`${path} holds ${existing.branch ?? 'a detached HEAD'}, not ${branch}; remove it by hand, then run start again`)
    // A worktree a failed run made is the retrospective's: it is adopted, not made twice.
    const made = existing ? { root: real(path), branch, base: integration, baseRef: null, adopted: true } : create(ctx.main, { change: worktreeName(ctx.id), branch, base: 'integration' })
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
    const sidecarFile = sidecarPath(ctx.main, ctx.id)
    mkdirSync(dirname(sidecarFile), { recursive: true })
    writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`)
    const inputFile = retroInputFile(wt, ctx.id)
    mkdirSync(dirname(inputFile), { recursive: true })
    writeFileSync(inputFile, `${JSON.stringify(input(sidecar, { root: wt, home: ctx.home }), null, 2)}\n`)
    const plan = planDispatch({ role: 'retro', id: ctx.id }, { root: wt, main: ctx.main, planText: null, exists: existsSync })
    const fields = [
      ['Dispatch name', plan.name],
      ['Worktree', wt],
      ['Input file', plan.inputFile],
      ['Reply file', plan.replyFile]
    ]
    const promptFile = promptPath(wt, ctx.id)
    writeFileSync(promptFile, `${renderPrompt({ plan, skeletons: skeletons(), fields, tokens: { '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT, '<root>': wt, '<worktree>': wt } })}\n`)
    const attempt = recordRetroDispatch(wt, ctx.id, { now: ctx.now().toISOString() })
    return {
      state: 'done',
      detail: {
        fetch,
        knowledge: { state: knowledge.state, excluded: exclude, ...(knowledge.error ? { error: knowledge.error } : {}) },
        sidecar: sidecarFile,
        inputFile,
        changes: sidecar.changes.map((c) => c.change),
        coverage: sidecar.coverage,
        adfDebt: sidecar.adfDebt.map(titled),
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
      out = recordRetroReply(wt, ctx.id, { file, resume, now: ctx.now().toISOString() })
    } catch (error) {
      if (!(error instanceof DispatchError)) throw error
      return { state: 'failed', refusal: error.message, detail: { next: 'stop', error: error.message } }
    }
    if (!out.valid) {
      const what = out.next === 'stop' ? 'the retrospective stops: a second invalid reply' : `retry once, the agent ${out.mode === 'resume' ? 'resumed' : 'dispatched afresh'}`
      // The retry is a dispatch of its own: recorded here, so the metrics count it.
      const retry = out.next === 'retry' ? recordRetroDispatch(wt, ctx.id, { now: ctx.now().toISOString() }) : null
      const dispatch = retry ? { name: retry.name, attempt: retry.attempt, mode: out.mode, promptFile: promptPath(wt, ctx.id), replyFile: replyFile(wt, undefined, retry.name, existsSync) } : null
      return {
        state: 'failed',
        refusal: `the retro reply was refused (${what}): ${out.errors.join('; ')}`,
        detail: { next: out.next, mode: out.mode, invalid: out.invalid, errors: out.errors, replyFile: out.replyFile, ...(dispatch ? { dispatch } : {}), error: out.errors.join('; ') }
      }
    }
    return { state: 'done', detail: { next: 'proceed', replyFile: out.replyFile, result: out.result } }
  })
}

// ---------------------------------------------------------------- file

// What `file` sends of a finding and of an ADF debt record (contract/README.md, `upstream`).
const FINDING_FIELDS = ['id', 'title', 'class', 'changes', 'evidence', 'cost', 'caughtWhere', 'plugin', 'version', 'body']
const DEBT_FIELDS = ['id', 'title', 'plugin', 'pluginVersion', 'change', 'class', 'source', 'body']
const only = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]))
const titled = ({ id, title }) => ({ id, title })

// The items of `all` the developer chose: `ids`, or every one when they named none.
function chosen(all, ids, what) {
  if (ids === undefined) return all
  const known = all.map((x) => x.id)
  const unknown = ids.filter((id) => !known.includes(id))
  if (unknown.length > 0) refuse(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${what}; ${what === 'a finding of this retrospective' ? 'its findings' : 'the records'}: ${known.join(', ') || 'none'}`)
  return all.filter((x) => ids.includes(x.id))
}

// findings: the finding ids to file, default every finding of the reply; debt: the ADF debt
// ids, default every record the window found unfiled. An empty list files none of that kind.
export function fileStep(ctx, { yes = false, findings, debt } = {}) {
  const before = readState(ctx.main, ctx.id)
  if (!FINAL.has(before.steps.file.state) && before.steps.render.state === 'done') {
    refuse(`file cannot run again: render has run, so the issue links and the debt's Filed column would miss the report and the retro commit; file by hand, or start a new retrospective`)
  }
  return runStep(ctx, 'file', (state) => {
    const wt = worktreeOf(state)
    const sidecar = JSON.parse(readFileSync(sidecarPath(ctx.main, ctx.id), 'utf8'))
    const pickedFindings = chosen(state.steps.reply.detail.result.findings, findings, 'a finding of this retrospective')
    const pickedDebt = chosen(sidecar.adfDebt ?? [], debt, 'an unfiled ADF debt record of this retrospective')
    const ids = { findings: pickedFindings.map((f) => f.id), debt: pickedDebt.map((d) => d.id) }
    if (pickedFindings.length + pickedDebt.length === 0) return { state: 'skipped', detail: { ...ids, text: 'Upstream: nothing to file; no finding and no ADF debt chosen.' } }
    const repository = ctx.repository()
    const probe = ctx.upstream('check', { repository }, wt)
    const upstream = probe.state === 'none' ? 'none' : (probe.plugin ?? null)
    const checked = { upstream, repository, ...ids }
    if (probe.state === 'none') return { state: 'skipped', detail: { ...checked, text: upstreamReport('file', probe) } }
    if (probe.state === 'refused') {
      const text = upstreamReport('check', probe)
      return { state: 'failed', refusal: text, detail: { ...checked, text, error: probe.error ?? text } }
    }
    if (probe.state === 'degraded') return { state: 'degraded', detail: { ...checked, text: upstreamReport('check', probe), hint: probe.hint ?? null } }
    if (!yes) {
      const flags = `${findings ? ` --findings ${findings.length ? findings.join(',') : 'none'}` : ''}${debt ? ` --debt ${debt.length ? debt.join(',') : 'none'}` : ''}`
      return { hold: true, out: { upstream, repository, would: { findings: pickedFindings.map(titled), debt: pickedDebt.map(titled) }, waiting: `the developer's yes: retro.mjs file --id ${ctx.id} --yes${flags}` } }
    }
    const fileIn = { repository, host: hostSlug(ctx.main), retro: ctx.id, findings: pickedFindings.map((f) => only(f, FINDING_FIELDS)), debt: pickedDebt.map((d) => only(d, DEBT_FIELDS)) }
    const result = ctx.upstream('file', fileIn, wt)
    const text = upstreamReport('file', result)
    const sent = { ...checked, upstream: result.state === 'none' ? 'none' : (result.plugin ?? upstream), host: fileIn.host }
    if (result.state === 'none') return { state: 'skipped', detail: { ...sent, text } }
    if (result.state === 'refused') return { state: 'failed', refusal: text, detail: { ...sent, text, error: result.error ?? text } }
    if (result.state === 'degraded') return { state: 'degraded', detail: { ...sent, text, hint: result.hint ?? null } }
    const issues = result.issues ?? []
    // Each debt record filed is marked in the retro worktree's tree, so the retro commit carries
    // its Filed column; a re-run after a failure marks it with the same URL, which changes nothing.
    const debtFiles = new Set()
    const filedDebt = issues.filter((i) => i.kind === 'debt' && ids.debt.includes(i.item))
    if (filedDebt.length > 0) {
      const root = readDebtRoot(wt)
      if (!root) refuse('the registry names no debt root, so the ADF debt filed cannot be marked filed')
      for (const issue of filedDebt) {
        const { record } = markFiled(join(wt, root), { id: issue.item, url: issue.url })
        debtFiles.add(`${root.replace(/\/$/, '')}/${record.block}/${BLOCK_INDEX}`)
      }
    }
    return { state: 'done', detail: { ...sent, issues, debtFiles: [...debtFiles], text } }
  })
}

// ---------------------------------------------------------------- render and record

// The issues a `done` file returned; none when it was skipped or did not finish.
const filed = (state) => (state.steps.file.state === 'done' ? state.steps.file.detail : null)

export function renderStep(ctx) {
  return runStep(ctx, 'render', (state) => {
    const wt = worktreeOf(state)
    const sidecar = JSON.parse(readFileSync(sidecarPath(ctx.main, ctx.id), 'utf8'))
    const computed = state.steps.reply.detail.result
    const issues = filed(state)?.issues ?? []
    const [json, md] = retroFiles(ctx.id)
    mkdirSync(join(wt, RETRO_DIR), { recursive: true })
    writeFileSync(join(wt, json), `${JSON.stringify(retroDocument(sidecar, computed, issues), null, 2)}\n`)
    writeFileSync(join(wt, md), renderRetro(sidecar, computed, issues))
    return { state: 'done', detail: { files: [json, md] } }
  })
}

export function recordStep(ctx) {
  return runStep(ctx, 'record', (state) => {
    const wt = worktreeOf(state)
    const files = [...state.steps.render.detail.files, ...(filed(state)?.debtFiles ?? [])]
    const message = retroTitle(state)
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

export function publishStep(ctx, { yes = false, no = false } = {}) {
  return runStep(ctx, 'publish', (state) => {
    const wt = worktreeOf(state)
    const { branch, base } = state.steps.start.detail
    const title = retroTitle(state)
    const forgeIn = forgeInput('open', { change: worktreeName(ctx.id), branch, base, protected: readBranches(wt)?.protected ?? null }, { input: { ci: false }, title, draft: false })
    const result = ctx.forge('open', forgeIn, wt)
    const report = forgeReport('open', result, { draft: false })
    if (result.state === 'none') {
      const merged = localMerge(ctx.main, { branch, base, yes: yes && !no })
      if (!merged.already && no) {
        return { state: 'skipped', detail: { forge: 'none', declined: true, branch, base, commands: merged.commands, report: `Local merge: declined; the developer merges ${branch} into ${base}.` } }
      }
      if (merged.hold) {
        return { hold: true, out: { forge: 'none', report, branch, base, commands: merged.commands, waiting: `the developer's yes: retro.mjs publish --id ${ctx.id} --yes merges ${branch} into ${base} in the main checkout, or --no to merge it by hand` } }
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

// ---------------------------------------------------------------- remove

// The retro worktree removed from the main checkout, as archive removes a change's: a tree with
// uncommitted changes refused with its status, never forced, the branch kept. A worktree already
// gone is reported, not failed.
export function removeStep(ctx) {
  return runStep(ctx, 'remove', () => {
    const out = removeWorktree(ctx.main, { change: worktreeName(ctx.id) })
    const report = out.state === 'removed' ? `Worktree ${out.path} removed; branch ${out.branch} kept.` : 'No retro worktree left to remove.'
    return { state: 'done', detail: { ...out, report } }
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
  const state = readState(ctx.main, ctx.id)
  return { ok: true, ...state, next: nextStep(state) }
}
