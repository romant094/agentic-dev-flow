// /adf:land: the hand-off of a change's tracker issues after its merge (D3, D4). Archive
// finalizes the merge request and never merges it; once it is merged, land writes one comment
// per taken or partial tracker issue and hands each to the tester through the tracker's
// `handoff`, held for the developer's yes. Land never merges and never pushes.
//
// The change's taken or partial debt takes part too: one target per distinct Tracker key of its
// debt items (lib/scope.mjs debtGroups), the issue that mirrors their group, unless the key is
// a tracker item of the scope, which hands it off once. Its state is decided after the merge,
// from the debt tree of the checkout holding the merged change, where archive moved the taken
// entries to their block's resolved.md: `taken` when no open entry holds the key any more, else
// `partial`, which comments and keeps the issue's status. A resolved row is never an entry.
//
// The steps, in this order; each runs once every step before it is done or skipped:
//   check          the change's scope (lib/scope.mjs findScope: the committed copy, archived
//                  too), then the tracker's `check`. No scope, a tracker skipped for the change,
//                  no taken or partial tracker issue and no tracked debt group, or no tracker
//                  plugin: the whole land is skipped, and each later step says so.
//   wait           the forge's `state` of the merge request archive finalized: `merged` is done,
//                  with mergedAt and mergeCommit; `open` or `draft` is `waiting`, for the
//                  command to run again later (no polling here); `closed` stops land. With no
//                  forge, or a forge that does not provide `state`, "merged" is decided from git
//                  ancestry (D19): the branch tip is an ancestor of the local base, else of
//                  origin/<base>; nothing is fetched.
//   comment-input  per issue, the input of one read-only `land-comment <KEY>` agent and its
//                  prompt: the issue, the change's artifacts, the scope check, the merge; for a
//                  debt group the resolved and the remaining entries, and its state, recorded.
//   comment        per issue, the agent's fields checked (lib/tracker.mjs checkFields) and
//                  recorded; done once every issue has them.
//   handoff        the tracker's `handoff`, held (lib/tracker.mjs heldWrite): without yes the
//                  plan and its preview, with it the plan applied. Items { key, state, fields },
//                  each text field a list of one-line texts (lib/tracker.mjs handoffFields);
//                  mr { url } from the forge's state (from archive's mr step with a forge that
//                  does not provide state), null with no forge.
//
// State: <main>/.superpowers/sdd/<change>/land/land.json, in the main checkout, so it outlives
// the worktree:
//   { version: 1, change, steps: { <step>: { state, at?, detail? } } }
//   check          done | skipped | degraded | failed; detail { scopeFile, tracker, items, report }
//   wait           done | waiting | closed | degraded | failed; detail { via: forge | ancestry,
//                  forge, branch, base, url, number?, status, ref?, mergedAt, mergeCommit, report }
//   comment-input  done; detail { changeDir, dispatches, debtTargets: [{ source: debt, key,
//                  state, kind, title, resolved, remaining }] }
//   comment        pending | done; detail { keys: { <KEY>: { state, fields, reply, at } }, missing }
//   handoff        held | done | failed | refused | skipped; detail { plan, preview, applied,
//                  skipped, failed, report, mr }
// A step done or skipped is returned as recorded, with `already`; the comment of a key already
// recorded with the same fields is too. A comment with other fields replaces them until the
// hand-off is applied, and a held hand-off plan is dropped, since it carries the old fields.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readArchiveState } from './archive.mjs'
import { META_FILE, readChangeMeta } from './changes.mjs'
import { LAND_ROLES, landCommentName, sddDir } from './dispatch.mjs'
import { listTree } from './debt.mjs'
import { findChangeDir } from './ingest.mjs'
import { mainCheckout } from './installed.mjs'
import { parseReply, readSchema, validateJson } from './json-schema.mjs'
import { readDebtRoot, readRegistry } from './registry.mjs'
import { callRole, CORE, forgeReport, trackerReport } from './roles.mjs'
import { debtGroups, findScope, renderSkeleton, trackerDir, trackerTargets } from './scope.mjs'
import { checkFields, FIELD_LIMITS, HANDOFF_FIELDS, handoffFields, heldWrite, trackerCall } from './tracker.mjs'
import { worktreePath } from './workspace.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LAND_SCHEMA = join(PLUGIN_ROOT, 'schema', LAND_ROLES['land-comment'].schema)
const PROMPT = join(PLUGIN_ROOT, 'schema', 'prompts', 'land-comment.md')
export const LAND_STEPS = ['check', 'wait', 'comment-input', 'comment', 'handoff']
const FINAL = new Set(['done', 'skipped'])
const CHANGE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export class Refusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}
const refuse = (message, extra) => {
  throw new Refusal(message, extra)
}

const posix = (path) => path.split(sep).join('/')
const fileKey = (key) => key.replace(/[^A-Za-z0-9._-]/g, '_')

// ---------------------------------------------------------------- state

export const landDir = (main, change) => join(sddDir(main, change), 'land')
export const landFile = (main, change) => join(landDir(main, change), 'land.json')

export function readLand(main, change) {
  const file = landFile(main, change)
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { version: 1, change, steps: Object.fromEntries(LAND_STEPS.map((s) => [s, saved.steps?.[s] ?? { state: 'pending' }])) }
}

function writeLand(main, change, land) {
  const file = landFile(main, change)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(land, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return land
}

const nextOf = (land) => LAND_STEPS.find((s) => !FINAL.has(land.steps[s].state)) ?? null

// deps: { now() -> Date, home }. The roles are the registry's: the tests enable fixture plugins.
export function landContext(rootArg, change, { now = () => new Date(), home } = {}) {
  if (!CHANGE.test(change ?? '')) refuse(`"${change ?? ''}" is not a kebab-case change name`)
  if (!existsSync(rootArg)) refuse(`${rootArg} does not exist; pass a checkout of the host as --root`)
  const main = realpathSync(mainCheckout(realpathSync(rootArg)))
  return { main, change, now, core: { ...CORE, ...(home ? { home } : {}) } }
}

const result = (ctx, step, record, extra = {}) => ({
  ok: !['failed', 'closed', 'refused'].includes(record.state),
  change: ctx.change,
  step,
  state: record.state,
  detail: record.detail ?? null,
  ...extra
})

// Runs a step under the state rules: a done or skipped step is returned as recorded; a land
// skipped at check skips every later step with check's line; a step runs only after every step
// before it is done or skipped. `fn(land)` returns { state, detail, out? }, recorded with the time.
function runStep(ctx, step, fn) {
  const land = readLand(ctx.main, ctx.change)
  const current = land.steps[step]
  if (FINAL.has(current.state)) return result(ctx, step, current, { already: true, next: nextOf(land) })
  if (step !== 'check' && land.steps.check.state === 'skipped') {
    land.steps[step] = { state: 'skipped', at: ctx.now().toISOString(), detail: { report: land.steps.check.detail?.report ?? 'Land: skipped.' } }
    writeLand(ctx.main, ctx.change, land)
    return result(ctx, step, land.steps[step], { next: nextOf(land) })
  }
  const waiting = LAND_STEPS.slice(0, LAND_STEPS.indexOf(step)).filter((s) => !FINAL.has(land.steps[s].state))
  if (waiting.length) refuse(`${step} waits for ${waiting.join(', ')}; run land.mjs report --change ${ctx.change} for the next step`)
  const got = fn(land)
  land.steps[step] = { state: got.state, at: ctx.now().toISOString(), detail: got.detail ?? null }
  writeLand(ctx.main, ctx.change, land)
  return result(ctx, step, land.steps[step], { next: nextOf(land), ...(got.out ?? {}) })
}

// ---------------------------------------------------------------- shared reads

function requireScope(ctx) {
  const found = findScope(ctx.main, ctx.change)
  if (!found) refuse(`${ctx.change} has no scope; land check skips it`)
  return found
}

function gitText(root, ...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The change's directory, active or archived, and the checkout holding it: the main checkout,
// else the change's worktree while it exists. Null when neither holds it, as before the merge is
// pulled.
function changeAt(ctx) {
  for (const root of [ctx.main, worktreePath(ctx.main, ctx.change)]) {
    try {
      return { root, dir: findChangeDir(root, ctx.change) }
    } catch {}
  }
  return null
}

const changeDirOf = (ctx) => changeAt(ctx)?.dir ?? null

// The issues land hands off: the scope's tracker targets, then the debt groups comment-input
// recorded with their state.
function landTargets(ctx, land) {
  return [...trackerTargets(requireScope(ctx).scope), ...(land.steps['comment-input'].detail?.debtTargets ?? [])]
}

const debtEntry = (e) => ({ id: e.id, title: e.title, class: e.class, anchors: e.anchors ?? [] })

// Each debt group's target after the merge, from the debt tree of `root`, the checkout holding
// the merged change: the open entries still holding the key remain (`scope` says how the change
// took one, null when it did not); the scope's entries no longer open are resolved.
function debtTargets(scope, root) {
  const groups = debtGroups(scope)
  if (groups.length === 0) return []
  const path = readDebtRoot(root)
  if (!path) refuse(`the registry of ${root} names no debt.root; land cannot tell which entries of ${groups.map((g) => g.key).join(', ')} remain`)
  const tree = listTree(join(root, path), { kind: 'debt' }).entries
  return groups.map(({ key, entries }) => {
    const remaining = tree.filter((e) => e.tracker === key)
    const left = new Set(remaining.map((e) => e.id))
    return {
      source: 'debt',
      key,
      state: remaining.length ? 'partial' : 'taken',
      kind: 'debt',
      title: entries.map((i) => i.title).join('; '),
      resolved: entries.filter((i) => !left.has(i.key)).map((i) => debtEntry({ ...i, id: i.key })),
      remaining: remaining.map((e) => ({ ...debtEntry(e), scope: entries.find((i) => i.key === e.id)?.state ?? null }))
    }
  })
}

// The branch and the base of the merge: what archive recorded (its mr, merge-local and remove
// steps), else the worktree's branch while it exists, and the base from the change's metadata.
function mergeRefs(ctx) {
  const steps = readArchiveState(ctx.main, ctx.change).steps
  const recorded = (key) => ['mr', 'merge-local', 'remove'].map((s) => steps[s].detail?.[key]).find((v) => typeof v === 'string' && v !== '') ?? null
  const wt = worktreePath(ctx.main, ctx.change)
  const branch = recorded('branch') ?? (existsSync(wt) ? gitText(wt, 'branch', '--show-current') || null : null)
  const dir = changeDirOf(ctx)
  let base = (dir && readChangeMeta(ctx.main, dir)?.base) || null
  base ??= recorded('base')
  if (!branch) refuse(`land reads the change's branch from archive's state or its worktree, and found neither; run /adf:archive ${ctx.change} first`)
  if (!base) refuse(`land reads the change's base from its ${META_FILE} or archive's state, and found neither`)
  return { branch, base, url: steps.mr.detail?.url ?? null }
}

// ---------------------------------------------------------------- check

export function checkStep(ctx) {
  return runStep(ctx, 'check', () => {
    const found = findScope(ctx.main, ctx.change)
    const skipped = (report) => ({ state: 'skipped', detail: { report }, out: { report } })
    if (!found) return skipped(`Land: ${ctx.change} has no scope; there is no tracker issue to hand off.`)
    const { file, scope } = found
    if (scope.tracker?.state === 'skipped') return skipped(`Land: the tracker was skipped for this change (${scope.tracker.reason}); nothing is handed off.`)
    const targets = trackerTargets(scope)
    const groups = debtGroups(scope)
    if (targets.length === 0 && groups.length === 0) return skipped('Land: no tracker issue is taken or partial, and no debt the change took is tracked; nothing is handed off.')
    const check = trackerCall(ctx.main, 'check', {}, ctx.core)
    const report = trackerReport('check', check)
    if (check.state === 'none') return skipped(report)
    if (check.state === 'refused') return { state: 'failed', detail: { report, error: check.error ?? report }, out: { report, refusal: report } }
    if (check.state === 'degraded') return { state: 'degraded', detail: { report, tool: check.tool ?? null, hint: check.hint ?? null }, out: { report, hint: check.hint ?? null } }
    const items = [
      ...targets.map(({ key, state, title }) => ({ key, state, title })),
      ...groups.map(({ key, entries }) => ({ key, state: null, title: entries.map((i) => i.title).join('; '), source: 'debt', entries: entries.map((i) => i.key) }))
    ]
    return { state: 'done', detail: { scopeFile: posix(relative(ctx.main, file)), tracker: { plugin: check.plugin ?? null, account: check.account ?? null }, items, report }, out: { report } }
  })
}

// ---------------------------------------------------------------- wait

function forgeCall(ctx, operation, input) {
  if (!readRegistry(ctx.main)) return { state: 'none', point: 'forge' }
  return callRole(ctx.main, 'forge', operation, input, ctx.core)
}

function isAncestor(main, a, b) {
  const run = spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: main, encoding: 'utf8' })
  if (run.status !== 0 && run.status !== 1) refuse(`git failed to compare ${a} with ${b} (${String(run.stderr || `exit ${run.status}`).trim()}); run again`)
  return run.status === 0
}

// "Merged" with no forge state (D19): the branch tip is an ancestor of the local base, else of
// origin/<base> as last fetched. The merge commit is the first merge on the path from the tip to
// the base, else the tip itself (a fast-forward).
export function mergedByAncestry(main, { branch, base }) {
  const tip = gitText(main, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`)
  if (!tip) refuse(`the branch ${branch} is not in ${main}; with no forge state land decides "merged" from git ancestry, and needs the branch`)
  const refs = [base, `origin/${base}`].filter((ref) => gitText(main, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`))
  if (refs.length === 0) refuse(`neither ${base} nor origin/${base} is in ${main}; land cannot tell whether ${branch} is merged`)
  for (const ref of refs) {
    if (!isAncestor(main, tip, ref)) continue
    const mergeCommit = gitText(main, 'rev-list', '--ancestry-path', '--merges', '--reverse', `${tip}..${ref}`)?.split('\n').find(Boolean) ?? tip
    return { merged: true, ref, tip, mergeCommit, mergedAt: gitText(main, 'show', '-s', '--format=%cI', mergeCommit) }
  }
  return { merged: false, refs, tip }
}

export function waitStep(ctx) {
  return runStep(ctx, 'wait', () => {
    const { branch, base, url } = mergeRefs(ctx)
    const got = forgeCall(ctx, 'state', { change: ctx.change, branch, base, ...(url ? { url } : {}) })
    const forgeLine = forgeReport('state', got)
    if (got.state === 'none') {
      const by = mergedByAncestry(ctx.main, { branch, base })
      const forge = got.reason === 'not-provided' ? got.plugin ?? null : 'none'
      // A forge that predates `state` still opened the merge request archive recorded.
      const mrUrl = forge === 'none' ? null : url
      if (!by.merged) {
        const report = `${forgeLine}\nNot merged: ${branch} is in none of ${by.refs.join(', ')}, decided from git ancestry.`
        return { state: 'waiting', detail: { via: 'ancestry', forge, branch, base, url: mrUrl, status: null, report }, out: { report, waiting: `the merge of ${branch} into ${base}: once it is merged, run land.mjs wait --change ${ctx.change} again` } }
      }
      const report = `${forgeLine}\nMerged: ${branch} is in ${by.ref} (commit ${by.mergeCommit.slice(0, 7)}), decided from git ancestry.`
      return { state: 'done', detail: { via: 'ancestry', forge, branch, base, url: mrUrl, status: 'merged', ref: by.ref, mergedAt: by.mergedAt, mergeCommit: by.mergeCommit, report }, out: { report } }
    }
    const forge = got.plugin ?? null
    if (got.state === 'refused') return { state: 'failed', detail: { forge, branch, base, report: forgeLine, error: got.error ?? forgeLine }, out: { report: forgeLine, refusal: forgeLine } }
    if (got.state === 'degraded') return { state: 'degraded', detail: { forge, branch, base, report: forgeLine, hint: got.hint ?? null }, out: { report: forgeLine, hint: got.hint ?? null } }
    const detail = { via: 'forge', forge, branch, base, url: got.url ?? url, number: got.number ?? null, status: got.status ?? null, mergedAt: got.mergedAt ?? null, mergeCommit: got.mergeCommit ?? null, report: forgeLine }
    if (got.status === 'merged') return { state: 'done', detail, out: { report: forgeLine } }
    if (['open', 'draft'].includes(got.status)) {
      return { state: 'waiting', detail, out: { report: forgeLine, waiting: `the merge request is ${got.status}: once it is merged, run land.mjs wait --change ${ctx.change} again` } }
    }
    if (got.status === 'closed') {
      const refusal = `the merge request${detail.url ? ` ${detail.url}` : ''} was closed without a merge; land stops and hands nothing off`
      return { state: 'closed', detail, out: { report: forgeLine, refusal } }
    }
    const refusal = `${forge ?? 'the forge'} returned the status ${JSON.stringify(got.status ?? null)}, not open, draft, merged or closed`
    return { state: 'failed', detail: { ...detail, error: refusal }, out: { report: forgeLine, refusal } }
  })
}

// ---------------------------------------------------------------- comment-input

function specDeltas(dir) {
  const specs = join(dir, 'specs')
  if (!existsSync(specs)) return []
  return readdirSync(specs).sort().map((c) => join(specs, c, 'spec.md')).filter((f) => existsSync(f))
}

export function commentInputStep(ctx) {
  return runStep(ctx, 'comment-input', (land) => {
    const { scope } = requireScope(ctx)
    const at = changeAt(ctx)
    if (!at) refuse(`the change ${ctx.change} is in neither the main checkout nor its worktree; pull its base into the main checkout, then run comment-input again`)
    const { dir } = at
    const debt = debtTargets(scope, at.root)
    const artifact = (name) => (existsSync(join(dir, name)) ? join(dir, name) : null)
    const artifacts = { dir, proposal: artifact('proposal.md'), specs: specDeltas(dir), tasks: artifact('tasks.md'), verify: artifact('verify.md') }
    const merge = land.steps.wait.detail ?? {}
    const out = landDir(ctx.main, ctx.change)
    mkdirSync(join(out, 'comment'), { recursive: true })
    mkdirSync(join(out, 'replies'), { recursive: true })
    const abs = (rel) => (isAbsolute(rel) ? rel : join(ctx.main, rel))
    const level = LAND_ROLES['land-comment'].level
    const dispatches = [...trackerTargets(scope), ...debt].map((item) => {
      const name = landCommentName(item.key)
      const inputFile = join(out, 'comment', `${fileKey(item.key)}.json`)
      const promptFile = join(out, 'comment', `${fileKey(item.key)}.prompt.md`)
      const replyFile = join(out, 'replies', `${fileKey(item.key)}.json`)
      const fields = HANDOFF_FIELDS[item.state]
      const input = {
        name,
        change: ctx.change,
        key: item.key,
        state: item.state,
        title: item.title,
        kind: item.kind,
        ...(item.url ? { url: item.url } : {}),
        reason: item.reason ?? null,
        issueFile: item.file ? abs(item.file) : null,
        artifacts,
        check: item.check ?? null,
        ...(item.source === 'debt' ? { debt: { resolved: item.resolved, remaining: item.remaining } } : {}),
        merge: { mergeCommit: merge.mergeCommit ?? null, mergedAt: merge.mergedAt ?? null },
        fields,
        limits: Object.fromEntries(fields.map((f) => [f, FIELD_LIMITS[f]])),
        replyFile,
        schema: LAND_SCHEMA
      }
      writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`)
      writeFileSync(promptFile, renderSkeleton(PROMPT, { name, level, key: item.key, change: ctx.change, state: item.state, fields: fields.join(', '), inputFile, replyFile, schema: LAND_SCHEMA }))
      return { name, key: item.key, state: item.state, agent: `adf:${level}`, worktree: ctx.main, inputFile, promptFile, replyFile }
    })
    return {
      state: 'done',
      detail: { changeDir: dir, dispatches, debtTargets: debt },
      out: { dispatches, waiting: `dispatch each, read-only and in parallel, with its promptFile; then land.mjs comment --change ${ctx.change} --key <KEY> --file <replyFile>` }
    }
  })
}

// ---------------------------------------------------------------- comment

// The rules the schema cannot state, for a reply that passed it.
export function checkCommentReply(reply, item) {
  const errors = []
  if (reply.key !== item.key) errors.push(`key is ${reply.key}, but this dispatch writes ${item.key}`)
  if (reply.state !== item.state) errors.push(`state is ${reply.state}, but ${item.key} is ${item.state} in the scope`)
  errors.push(...checkFields(item.state, reply.fields))
  return errors
}

const sameFields = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function commentStep(ctx, { key, file }) {
  const land = readLand(ctx.main, ctx.change)
  if (land.steps.check.state === 'skipped') return runStep(ctx, 'comment', () => ({}))
  const waiting = ['check', 'wait', 'comment-input'].filter((s) => !FINAL.has(land.steps[s].state))
  if (waiting.length) refuse(`comment waits for ${waiting.join(', ')}; run land.mjs report --change ${ctx.change} for the next step`)
  const targets = landTargets(ctx, land)
  const item = targets.find((t) => t.key === key)
  if (!item) refuse(`${key} is not a taken or partial tracker issue or a tracked debt group of ${ctx.change}; its issues: ${targets.map((t) => t.key).join(', ')}`)
  if (!existsSync(file)) return { ok: false, valid: false, change: ctx.change, step: 'comment', key, errors: [`no reply file at ${file}`], next: 'retry' }
  const parsed = parseReply(readFileSync(file, 'utf8'))
  const errors = [...parsed.errors]
  if (parsed.reply !== null) {
    const schemaErrors = validateJson(readSchema(LAND_SCHEMA), parsed.reply)
    errors.push(...schemaErrors)
    if (schemaErrors.length === 0) errors.push(...checkCommentReply(parsed.reply, item))
  }
  if (errors.length) {
    return { ok: false, valid: false, change: ctx.change, step: 'comment', key, errors, next: 'retry: send the errors to the same agent once; after a second refusal the developer writes the fields' }
  }
  const fields = parsed.reply.fields
  const step = land.steps.comment
  const keys = { ...(step.detail?.keys ?? {}) }
  const missingOf = (k) => targets.map((t) => t.key).filter((t) => !k[t])
  if (keys[key] && sameFields(keys[key].fields, fields)) {
    return { ok: true, valid: true, change: ctx.change, step: 'comment', key, state: step.state, fields, already: true, missing: missingOf(keys), next: nextOf(land) }
  }
  if (land.steps.handoff.state === 'done') refuse(`the hand-off of ${ctx.change} is applied; the fields of ${key} stay as they were sent`)
  keys[key] = { state: item.state, fields, reply: posix(relative(ctx.main, file)), at: ctx.now().toISOString(), ...(parsed.fenced ? { fenced: true } : {}) }
  const missing = missingOf(keys)
  land.steps.comment = { state: missing.length ? 'pending' : 'done', at: ctx.now().toISOString(), detail: { keys, missing } }
  const dropped = land.steps.handoff.state === 'held'
  if (dropped) land.steps.handoff = { state: 'pending', at: ctx.now().toISOString(), detail: { report: `the held plan ${land.steps.handoff.detail?.plan ?? ''} carried other fields of ${key} and was dropped; run land.mjs handoff --change ${ctx.change} for a new one` } }
  writeLand(ctx.main, ctx.change, land)
  return {
    ok: true,
    valid: true,
    change: ctx.change,
    step: 'comment',
    key,
    state: land.steps.comment.state,
    fields,
    missing,
    ...(dropped ? { report: land.steps.handoff.detail.report } : {}),
    next: missing.length ? `the fields of ${missing.join(', ')}: land.mjs comment --change ${ctx.change} --key <KEY> --file <replyFile>` : nextOf(land)
  }
}

// ---------------------------------------------------------------- handoff

export function handoffStep(ctx, { yes = false } = {}) {
  const land = readLand(ctx.main, ctx.change)
  const current = land.steps.handoff
  if (FINAL.has(current.state)) return result(ctx, 'handoff', current, { already: true, next: null })
  if (land.steps.check.state === 'skipped') return runStep(ctx, 'handoff', () => ({}))
  const waiting = ['check', 'wait', 'comment-input'].filter((s) => !FINAL.has(land.steps[s].state))
  if (waiting.length) refuse(`handoff waits for ${waiting.join(', ')}; run land.mjs report --change ${ctx.change} for the next step`)
  const targets = landTargets(ctx, land)
  const keys = land.steps.comment.detail?.keys ?? {}
  const missing = targets.map((t) => t.key).filter((k) => !keys[k])
  if (missing.length) refuse(`every in-scope tracker issue needs its fields before the hand-off; none recorded for ${missing.join(', ')}: run land.mjs comment --change ${ctx.change} --key <KEY> --file <reply>`)
  const items = targets.map((t) => ({ key: t.key, state: t.state, fields: handoffFields(keys[t.key].fields) }))
  const url = land.steps.wait.detail?.url ?? null
  const mr = url ? { url } : null
  const { record, out } = heldWrite({
    root: ctx.main,
    operation: 'handoff',
    input: { items, mr, change: ctx.change },
    stateDir: trackerDir(ctx.main, ctx.change),
    record: { state: current.state, plan: current.detail?.plan ?? null },
    yes,
    core: ctx.core,
    command: `land.mjs handoff --change ${ctx.change}`,
    label: 'handoff',
    refuse
  })
  if (record) {
    const { state, ...detail } = record
    land.steps.handoff = { state, at: ctx.now().toISOString(), detail: { ...detail, mr } }
    writeLand(ctx.main, ctx.change, land)
  }
  const { ok, ...rest } = out
  return { ok, change: ctx.change, step: 'handoff', next: nextOf(readLand(ctx.main, ctx.change)), ...rest, mr }
}

// ---------------------------------------------------------------- report

const COMMAND = {
  check: (c) => `land.mjs check --change ${c}`,
  wait: (c) => `land.mjs wait --change ${c}, once the merge request is merged`,
  'comment-input': (c) => `land.mjs comment-input --change ${c}, then dispatch each land-comment agent`,
  comment: (c) => `land.mjs comment --change ${c} --key <KEY> --file <replyFile>, for each issue still missing its fields`,
  handoff: (c) => `land.mjs handoff --change ${c}, then on the developer's yes with --yes`
}

const LINE = {
  check: (d) => `${d.report ?? ''}${d.items?.length ? `; ${d.items.map((i) => `${i.key} (${i.source === 'debt' ? `debt ${i.entries.join(', ')}` : i.state})`).join(', ')}` : ''}`,
  wait: (d) => String(d.report ?? '').split('\n').join(' '),
  'comment-input': (d) => `${d.dispatches?.length ?? 0} land-comment input(s)${d.debtTargets?.length ? `; debt groups ${d.debtTargets.map((t) => `${t.key} (${t.state})`).join(', ')}` : ''}`,
  comment: (d) => `fields recorded for ${Object.keys(d.keys ?? {}).join(', ') || 'none'}${d.missing?.length ? `; missing ${d.missing.join(', ')}` : ''}`,
  handoff: (d) => String(d.report ?? '').split('\n').join(' ')
}

export function report(ctx) {
  const land = readLand(ctx.main, ctx.change)
  const lines = LAND_STEPS.map((s) => {
    const { state, detail } = land.steps[s]
    const text = detail ? LINE[s](detail) : ''
    return `- ${s}: ${state}${text ? ` — ${text}` : ''}`
  })
  const next = nextOf(land)
  const skipped = land.steps.check.state === 'skipped'
  const stopped = land.steps.wait.state === 'closed'
  const complete = next === null
  const heading = skipped ? `## Land skipped: ${ctx.change}` : complete ? `## Land complete: ${ctx.change}` : `## Land not complete: ${ctx.change}`
  const tail = skipped || complete
    ? []
    : stopped
      ? ['', 'Stopped: the merge request was closed without a merge; nothing was handed off. Run land.mjs wait again only if it is reopened and merged.']
      : ['', `Next: ${land.steps.handoff.state === 'held' ? `the developer's yes: land.mjs handoff --change ${ctx.change} --yes` : COMMAND[next](ctx.change)}.`]
  return {
    ok: true,
    change: ctx.change,
    complete,
    skipped,
    stopped,
    done: LAND_STEPS.filter((s) => FINAL.has(land.steps[s].state)),
    next,
    file: landFile(ctx.main, ctx.change),
    steps: land.steps,
    report: [heading, '', ...lines, ...tail].join('\n')
  }
}
