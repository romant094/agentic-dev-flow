// The `tracker` role of the ADF contract (1.7) on Jira, over the plugin's own engine: the
// profile, the path solver, the plan and its two-phase apply.
//
//   check    the env, the config, the token (GET /rest/api/2/myself) and the profile
//   gather   the named issues and a text search in the allowlisted projects, either or both;
//            their parent, sub-tasks and linked issues; one JSON file per issue under
//            input.stateDir
//   start    a held plan: each issue to the start status, assigned to the developer; an item
//            with corrections also gets the templated correction comment (decision D7)
//   handoff  a held plan: the templated comment; for taken and not-reproduced items also the
//            hand-off status and the tester (JIRA_QA) as assignee; a partial item goes back to
//            statuses.initial by a route that avoids the hand-off status, or, with no initial
//            status configured or no such route, keeps its status (the plan's `unmoved` says
//            why); it always gets its comment
//
// start and handoff without `apply` build the plan in input.stateDir and send nothing
// (`held`); with `apply: <plan id>` they run that plan. Each write of an issue is its own row
// (`step`: transition, assignee, comment), each with its own status check, so a rerun with the
// same id applies only the rows not done yet; a comment row also skips a comment already
// posted. An issue moved by hand meanwhile is skipped, not failed.
//
// Every result is one object with `state`: done, degraded (nothing sent; `tool` and `hint`)
// or refused (`error`). No result carries a secret: the env is described by name, layer and
// length. Jira is reached only through the injected `fetch`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { JiraClient, JiraError } from './client.mjs'
import { checkFields, checkMr, loadCorrectionTemplate, loadTemplate, renderComment, renderCorrection } from './comment.mjs'
import { mainCheckout, normalizeConfig } from './config.mjs'
import { EnvError, resolveEnv } from './env.mjs'
import { applyPlan } from './apply.mjs'
import { solvePath } from './paths.mjs'
import { assertAllowlist, assertConfiguredAllowlist, loadPlan, projectOf, writePlan } from './plan.mjs'
import { assertResolvable, placeholderValues, placeholdersIn, resolvePlaceholders } from './placeholders.mjs'
import { MAX_AGE_DAYS, isStale, profilePaths, readDiscovered } from './profile.mjs'
import { commentRow, readAllComments } from './readers.mjs'

export const OPERATIONS = ['check', 'gather', 'start', 'handoff']
export const TEXT_SEARCH_LIMIT = 20
const NOTHING_SENT = 'nothing was sent'
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/
const PLAN_ID = /^(start|handoff)-\d{8}T\d{6}Z(?:-\d+)?$/
const ISSUE_FIELDS = ['summary', 'description', 'status', 'issuetype', 'parent', 'subtasks', 'issuelinks', 'assignee', 'resolution', 'labels', 'created', 'updated']

const done = (result) => ({ code: 0, result: { state: 'done', ...result } })
const degraded = (tool, hint, extra = {}) => ({ code: 0, result: { state: 'degraded', tool, hint, ...extra } })
const refused = (error) => ({ code: 1, result: { state: 'refused', error } })

class Refusal extends Error {}

// deps: { fetch, home, processEnv, now: () => Date, git (root → git common dir or null), pluginRoot }
export async function runOperation(operation, payload, deps) {
  if (!OPERATIONS.includes(operation)) return refused(`unknown operation "${operation}"; the operations are ${OPERATIONS.join(', ')}; ${NOTHING_SENT}.`)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return refused(`the payload is not an object; ${NOTHING_SENT}.`)
  const { root, config: rawConfig = {}, input = {} } = payload
  if (typeof root !== 'string' || !isAbsolute(root)) return refused(`root is not an absolute path; ${NOTHING_SENT}.`)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return refused(`input is not an object; ${NOTHING_SENT}.`)
  const { config, errors } = normalizeConfig(rawConfig)
  if (errors.length > 0) return refused(`the registry config of adf-jira is invalid: ${errors.join('; ')}; ${NOTHING_SENT}.`)

  try {
    const ctx = { ...deps, root, config, input, projectDir: mainCheckout(root, deps.git) }
    if (operation === 'check') return await check(ctx)
    const ready = prepare(ctx, { profile: true })
    if (ready.code !== undefined) return ready
    Object.assign(ctx, ready)
    if (operation === 'gather') return await gather(ctx)
    if (operation === 'start') return await start(ctx)
    return await handoff(ctx)
  } catch (error) {
    if (error instanceof Refusal) return refused(error.message)
    return refused(`${error.message}; nothing more was sent.`)
  }
}

// ---------------------------------------------------------------- check

function prepare(ctx, { profile }) {
  const { projectDir, config, home, processEnv, pluginRoot } = ctx
  let resolved
  try {
    resolved = resolveEnv({ projectDir, homeDir: home, processEnv, envFile: config.envFile, config })
  } catch (error) {
    if (!(error instanceof EnvError)) throw error
    if (error.missing.includes('JIRA_PAT')) {
      return degraded(
        'missing',
        `copy ${join(pluginRoot, 'env.example')} to ${config.envFile ?? '.claude/.env'} in ${projectDir}, set JIRA_PAT to a Jira personal access token, and rerun`
      )
    }
    return degraded(
      'unconfigured',
      `set baseUrl and allowlist in the adf-jira entry of .claude/adf-extensions.json, for example /adf:add adf-jira@agentic-dev-flow --config '{"baseUrl":"https://jira.example.com","allowlist":["PROJ"]}'`
    )
  }
  const client = new JiraClient(resolved.env, ctx.fetch)
  if (!profile) return { ...resolved, client }
  const facts = readDiscovered(projectDir, config.profileDir)
  if (facts === null) {
    return degraded('unconfigured', `no project profile at ${profilePaths(projectDir, config.profileDir).discovered}; run /adf-jira:setup`)
  }
  if (isStale(facts, ctx.now(), MAX_AGE_DAYS)) {
    return degraded('unconfigured', `the project profile was discovered at ${facts.discoveredAt}, more than ${MAX_AGE_DAYS} days ago; run /adf-jira:setup to refresh it`)
  }
  return { ...resolved, client, facts }
}

async function myself(client) {
  return client.get('/rest/api/2/myself')
}

const UNSET_INITIAL = 'config.statuses.initial is unset: a partial issue keeps its status at hand-off and sync-debt cannot plan an edit; run /adf-jira:setup'

async function check(ctx) {
  const env = prepare(ctx, { profile: false })
  if (env.code !== undefined) return env
  const sources = env.sources.map(({ key, layer, length }) => ({ key, layer, length }))
  let me
  try {
    me = await myself(env.client)
  } catch (error) {
    if (error instanceof JiraError && (error.status === 401 || error.status === 403)) {
      return degraded('unauthenticated', `Jira refused the token in JIRA_PAT (${error.status}): create a new personal access token in Jira (avatar, Profile, Personal Access Tokens), set JIRA_PAT, and rerun`, { sources })
    }
    throw error
  }
  const profile = prepare(ctx, { profile: true })
  if (profile.code !== undefined) return { code: 0, result: { ...profile.result, sources } }
  // Without an initial status a partial issue keeps its status at hand-off; nothing else says so.
  const notes = ctx.config.statuses.initial ? [] : [UNSET_INITIAL]
  return done({ tool: 'ready', account: me?.name ?? me?.key ?? null, sources, profile: { discoveredAt: profile.facts.discoveredAt }, ...(notes.length ? { notes } : {}) })
}

// ---------------------------------------------------------------- gather

const keyNumber = (key) => Number(key.split('-').at(-1))

function kindOf(issuetype) {
  const name = String(issuetype?.name ?? '').toLowerCase()
  if (name.includes('bug')) return 'bug'
  if (issuetype?.subtask) return 'sub-task'
  if (name === 'epic') return 'epic'
  if (name === 'story') return 'story'
  return 'task'
}

// Jira writes `+0300`; Date.parse wants `+03:00`.
const time = (text) => (typeof text === 'string' ? Date.parse(text.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : Number.NaN)

function linksOf(issue) {
  return (issue.fields.issuelinks ?? [])
    .map((link) => {
      const outward = link.type?.outward ?? link.type?.name ?? 'relates to'
      const inward = link.type?.inward ?? link.type?.name ?? 'relates to'
      if (link.outwardIssue?.key) return { key: link.outwardIssue.key, relation: outward, inverse: inward }
      if (link.inwardIssue?.key) return { key: link.inwardIssue.key, relation: inward, inverse: outward }
      return null
    })
    .filter(Boolean)
}

function plainValue(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(plainValue)
  if (typeof value === 'object') {
    for (const key of ['value', 'name', 'key', 'displayName']) if (typeof value[key] === 'string') return value[key]
    return value
  }
  return value
}

// When the status the issue is excluded by looks older than its latest comment, the status
// may be stale: said once, as a flag, and the exclusion still holds.
function staleFlag(issue, comments) {
  const status = issue.fields.status?.name
  const moves = (issue.changelog?.histories ?? [])
    .filter((h) => (h.items ?? []).some((i) => i.field === 'status' && i.toString === status))
    .map((h) => time(h.created))
    .filter((t) => !Number.isNaN(t))
  const since = moves.length > 0 ? Math.max(...moves) : time(issue.fields.created)
  const latest = comments.map((c) => time(c.updated ?? c.created)).filter((t) => !Number.isNaN(t))
  if (latest.length === 0 || Number.isNaN(since)) return null
  const newest = Math.max(...latest)
  if (newest <= since) return null
  return `status "${status}" may be stale: a comment of ${new Date(newest).toISOString().slice(0, 10)} is newer than the move to it on ${new Date(since).toISOString().slice(0, 10)}`
}

async function readIssue(client, key, extraFields) {
  return client.get(`/rest/api/2/issue/${key}?fields=${[...ISSUE_FIELDS, ...extraFields].join(',')}&expand=changelog`)
}

async function gather(ctx) {
  const { input, config, env, client, facts } = ctx
  const { keys, text, change, stateDir } = input
  if (keys === undefined && text === undefined) throw new Refusal(`gather takes keys, text or both; ${NOTHING_SENT}.`)
  if (keys !== undefined && !(Array.isArray(keys) && keys.length > 0 && keys.every((k) => ISSUE_KEY.test(k)))) throw new Refusal(`keys is not a list of issue keys; ${NOTHING_SENT}.`)
  if (text !== undefined && !(typeof text === 'string' && text.trim() !== '')) throw new Refusal(`text is empty; ${NOTHING_SENT}.`)
  if (typeof change !== 'string' || change === '') throw new Refusal(`change is missing; ${NOTHING_SENT}.`)
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Refusal(`stateDir is not an absolute path; ${NOTHING_SENT}.`)

  const notes = []
  const allowed = (key) => env.allowedProjects.includes(projectOf(key))
  const fieldIds = []
  const fieldNames = {}
  for (const name of config.fields) {
    const id = facts.fieldMap?.[name]
    if (id) {
      fieldIds.push(id)
      fieldNames[id] = name
    } else notes.push(`field "${name}" is not in the profile's field map; not read`)
  }

  // With keys, `named` is the keys alone and the text search only adds issues; without, it is
  // the search's hits.
  const given = keys === undefined ? [] : [...new Set(keys)]
  let found = []
  if (text !== undefined) {
    const projects = env.allowedProjects.map((p) => `"${p}"`).join(', ')
    const jql = `project in (${projects}) AND text ~ "${text.replace(/["\\]/g, '\\$&')}" AND statusCategory != Done ORDER BY key ASC`
    found = (await client.search(jql, ['key'], TEXT_SEARCH_LIMIT)).map((i) => i.key)
    if (found.length === TEXT_SEARCH_LIMIT) notes.push(`the text search stopped at ${TEXT_SEARCH_LIMIT} issues; name keys to narrow it`)
    if (found.length === 0) notes.push('the text search found no open issue')
  }
  const named = keys === undefined ? found : given
  const primary = [...new Set([...given, ...found])]

  const issues = new Map()
  const via = new Map()
  const read = async (key, from) => {
    if (issues.has(key)) return
    if (!allowed(key)) {
      notes.push(from ? `${key} (${from.relation} ${from.key}) is outside the allowlist; not read` : `${key} is outside the allowlist; not read`)
      return
    }
    try {
      issues.set(key, await readIssue(client, key, fieldIds))
      if (from) via.set(key, from)
    } catch (error) {
      if (error instanceof JiraError && error.status === 404) {
        notes.push(`${key} does not exist or this account cannot see it`)
        return
      }
      throw new Error(`reading ${key} failed: ${error.message}`)
    }
  }

  for (const key of primary) await read(key)
  for (const key of primary.filter((k) => issues.has(k))) {
    const f = issues.get(key).fields
    if (f.parent?.key) await read(f.parent.key, { key, relation: 'parent of' })
    for (const sub of f.subtasks ?? []) await read(sub.key, { key, relation: 'sub-task of' })
    for (const link of linksOf(issues.get(key))) await read(link.key, { key, relation: link.inverse })
  }

  mkdirSync(stateDir, { recursive: true })
  const readAt = ctx.now().toISOString()
  const items = []
  for (const [key, issue] of issues) {
    const f = issue.fields
    const comments = (await readAllComments(client, key)).map(commentRow)
    const status = f.status?.name ?? 'unknown'
    const open = f.status?.statusCategory?.key !== 'done'
    const excluded = !open ? `closed (status ${status})` : config.statuses.excluded.includes(status) ? `excluded status ${status}` : null
    const flags = []
    if (excluded) {
      const stale = staleFlag(issue, comments)
      if (stale) flags.push(stale)
    }
    const url = `${env.url}/browse/${key}`
    const links = linksOf(issue).map(({ key: other, relation }) => ({ key: other, relation }))
    const subtasks = (f.subtasks ?? []).map((s) => s.key)
    const fields = {}
    for (const id of fieldIds) fields[fieldNames[id]] = plainValue(f[id])
    const file = join(stateDir, `${key}.json`)
    const record = {
      key,
      url,
      type: f.issuetype?.name ?? null,
      kind: kindOf(f.issuetype),
      title: f.summary ?? '',
      status,
      open,
      parent: f.parent?.key ?? null,
      subtasks,
      links,
      description: f.description ?? null,
      fields,
      comments,
      readAt
    }
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    items.push({
      key,
      url,
      kind: record.kind,
      subtask: Boolean(f.issuetype?.subtask),
      title: record.title,
      status,
      open,
      parent: record.parent,
      subtasks,
      links,
      named: named.includes(key),
      via: via.get(key) ?? null,
      branchToken: key,
      branchRank: null,
      excluded,
      flags,
      file
    })
  }
  rankBranches(items, given)
  return done({ change, items, notes })
}

// The branch key's priority: a named sub-task, then the lowest sub-task, then the lowest bug (a
// sub-bug too), then a named task. Among named items the first in `keys` wins; items named by a
// text search alone (not in `keys`) tie, and the core asks about a tie. An excluded item and an
// epic are not ranked.
export function rankBranches(items, keys = []) {
  const order = (item) => (keys.includes(item.key) ? keys.indexOf(item.key) : -1)
  const tier = (item) => {
    if (item.excluded || item.kind === 'epic') return null
    if (item.kind === 'bug') return [3, keyNumber(item.key)]
    if (item.subtask && item.named) return [1, order(item)]
    if (item.subtask) return [2, keyNumber(item.key)]
    if (item.named) return [4, order(item)]
    return null
  }
  for (const item of items) item.branchRank = null
  const ranked = items.map((item) => ({ item, t: tier(item) })).filter((r) => r.t)
  ranked.sort((a, b) => a.t[0] - b.t[0] || a.t[1] - b.t[1])
  let rank = 0
  let last = null
  for (const r of ranked) {
    const sig = r.t.join(':')
    if (sig !== last) {
      rank += 1
      last = sig
    }
    r.item.branchRank = rank
  }
  return items
}

// ---------------------------------------------------------------- start and handoff

function planId(kind, stateDir, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  let id = `${kind}-${stamp}`
  for (let n = 2; existsSync(join(stateDir, `${id}.json`)); n++) id = `${kind}-${stamp}-${n}`
  return id
}

function checkHeldInput(input, kind) {
  const { items, stateDir, apply } = input
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Refusal(`stateDir is not an absolute path; ${NOTHING_SENT}.`)
  if (apply !== undefined && !(typeof apply === 'string' && PLAN_ID.test(apply) && apply.startsWith(`${kind}-`))) {
    throw new Refusal(`apply is not a ${kind} plan id; ${NOTHING_SENT}.`)
  }
  if (apply === undefined && !(Array.isArray(items) && items.length > 0)) throw new Refusal(`items is empty; ${NOTHING_SENT}.`)
  for (const item of items ?? []) {
    if (!ISSUE_KEY.test(item?.key ?? '')) throw new Refusal(`"${item?.key}" is not an issue key; ${NOTHING_SENT}.`)
  }
}

function assertKeysAllowed(keys, env) {
  const foreign = keys.filter((k) => !env.allowedProjects.includes(projectOf(k)))
  if (foreign.length > 0) throw new Refusal(`${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} outside the allowlist (${env.allowedProjects.join(', ')}); the whole request is refused and ${NOTHING_SENT}.`)
}

// The hops from the issue's status to `target`, or why there are none. A hop whose screen
// requires a field is not taken: the plugin never fills a required field on its own. The route
// never passes through a status in `avoid`.
function route(facts, from, target, avoid = []) {
  const unsampled = (facts.unsampledStatuses ?? []).map((u) => u.status)
  const path = solvePath(facts.workflow, from, target, unsampled, avoid)
  if (path.kind === 'unreachable') return { reason: `no route from "${from}" to "${target}" in the discovered workflow` }
  if (path.kind === 'unknown') return { reason: `the route from "${from}" to "${target}" crosses unsampled status ${path.unsampled.join(', ')}` }
  const demanding = path.transitions.find((t) => t.requiredFields.length > 0)
  if (demanding) return { reason: `the hop "${demanding.name}" requires ${demanding.requiredFields.join(', ')}` }
  return { steps: path.transitions.map((t) => ({ transitionId: t.id, to: t.to })) }
}

async function issueSummary(client, key) {
  return client.get(`/rest/api/2/issue/${key}?fields=summary,status,assignee`)
}

function savePlanIn(stateDir, kind, plan, now) {
  mkdirSync(stateDir, { recursive: true })
  const id = planId(kind, stateDir, now)
  const file = join(stateDir, `${id}.json`)
  writePlan(file, plan)
  return { id, file }
}

// The plan's rows of each issue, in plan order.
function rowsByKey(rows) {
  const byKey = new Map()
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
  return byKey
}

function previewOf(plan, values) {
  const lines = []
  for (const [key, rows] of rowsByKey(plan.rows)) {
    const steps = rows.flatMap((row) => resolvePlaceholders(row, values).steps)
    const from = rows[0].from
    const stops = steps.map((s) => s.to).filter(Boolean)
    const assignee = steps.find((s) => s.fields?.assignee)?.fields.assignee.name
    const parts = []
    if (stops.length > 0) parts.push(`${[from, ...stops].join(' → ')}`)
    else if (from !== undefined) parts.push(`stays ${from}`)
    if (assignee) parts.push(`assignee ${assignee}`)
    const comments = steps.filter((s) => s.comment).map((s) => s.comment.body)
    if (comments.length > 0) parts.push('comment:')
    lines.push(`${key} ${rows[0].summary}: ${parts.join('; ')}`)
    for (const comment of comments) for (const line of comment.split('\n')) lines.push(`    ${line}`)
  }
  for (const { key, reason } of plan.excluded ?? []) lines.push(`${key} skipped: ${reason}`)
  for (const { key, reason } of plan.unmoved ?? []) lines.push(`${key} not moved, comment only: ${reason}`)
  return lines
}

// The developer is JIRA_ASSIGNEE, else the account the token belongs to.
async function loginValues(ctx, plan) {
  const used = placeholdersIn(plan)
  const extra = {}
  if (used.has('<JIRA_ASSIGNEE>') && !ctx.env.assignee) extra.assignee = (await myself(ctx.client))?.name
  const values = placeholderValues(ctx.env, extra)
  try {
    assertResolvable(plan, values)
  } catch (error) {
    throw new Refusal(error.message.replace('nothing was applied', NOTHING_SENT))
  }
  return values
}

async function held(ctx, kind, plan) {
  const values = await loginValues(ctx, plan)
  const { id, file } = savePlanIn(ctx.input.stateDir, kind, plan, ctx.now())
  return done({ held: true, plan: id, file, preview: previewOf(plan, values) })
}

async function applyHeld(ctx, kind) {
  const { input, env, client, facts } = ctx
  const file = join(input.stateDir, `${input.apply}.json`)
  if (!existsSync(file)) throw new Refusal(`no plan ${input.apply} in ${input.stateDir}; ${NOTHING_SENT}.`)
  let plan
  try {
    plan = loadPlan(file)
    if (plan.purpose !== kind) throw new Error(`plan ${input.apply} is not a ${kind} plan`)
    assertAllowlist(plan)
    assertConfiguredAllowlist(plan, env.allowedProjects)
  } catch (error) {
    throw new Refusal(`${error.message}; ${NOTHING_SENT}.`)
  }
  if (new Date(plan.discoveredAt).getTime() < new Date(facts.discoveredAt).getTime()) {
    throw new Refusal(
      `plan ${input.apply} is stale: built against the profile discovered at ${plan.discoveredAt}, and the profile was refreshed at ${facts.discoveredAt}; rebuild the plan; ${NOTHING_SENT}.`
    )
  }
  const values = await loginValues(ctx, plan)
  plan.confirmedAt = plan.confirmedAt ?? ctx.now().toISOString()
  const persist = (p) => writePlan(file, p)
  persist(plan)
  const outcome = await applyPlan({ plan, client, persist, values })
  const applied = []
  const skipped = (plan.excluded ?? []).map(({ key, reason }) => ({ key, reason }))
  const failed = []
  // An issue is applied when every row of it is done, failed when one failed or was not
  // attempted, else skipped; the reason names the row's step.
  const reasonOf = (rows, states) =>
    rows
      .filter((r) => states.includes(r.state))
      .map((r) => `${r.step ? `${r.step}: ` : ''}${r.state === 'pending' ? 'not attempted: the run stopped after 3 consecutive failures; fix the cause and rerun the same plan' : r.error}`)
      .join('; ')
  for (const [key, rows] of rowsByKey(plan.rows)) {
    if (rows.some((r) => r.state === 'failed' || r.state === 'pending')) failed.push({ key, reason: reasonOf(rows, ['failed', 'pending']) })
    else if (rows.some((r) => r.state === 'skipped-drift')) skipped.push({ key, reason: reasonOf(rows, ['skipped-drift']) })
    else applied.push(key)
  }
  return done({ plan: input.apply, applied, skipped, failed, aborted: outcome.abortedAfterConsecutiveFailures })
}

// One issue's rows: the transition from its status, the assignee and the comment, each checked
// against the status it expects when it runs. A row without `from` (a partial hand-off's
// comment with no initial status configured) is not checked.
function issueRows({ key, summary, from, hops, target, assignee, body }) {
  const rows = []
  const row = (step, steps, expected) => rows.push({ key, summary, step, ...(expected === undefined ? {} : { from: expected }), steps, state: 'pending' })
  if (hops.length > 0) row('transition', hops, from)
  const after = hops.length > 0 ? target : from
  if (assignee) row('assignee', [{ fields: { assignee: { name: assignee } } }], after)
  if (body !== undefined) row('comment', [{ comment: { action: 'add', body, once: true } }], after)
  return rows
}

async function start(ctx) {
  const { input, config, env, client, facts, root, pluginRoot } = ctx
  checkHeldInput(input, 'start')
  if (input.apply !== undefined) return applyHeld(ctx, 'start')
  const keys = [...new Set(input.items.map((i) => i.key))]
  assertKeysAllowed(keys, env)
  const target = config.statuses.start
  const login = env.assignee ?? (await myself(client))?.name
  // The core sends each item's verdict, corrections and answers; a corrected verdict, or an
  // item with corrections, gets its correction comment in the plan.
  const corrected = new Map(input.items.filter((i) => i.verdict === 'corrected' || (Array.isArray(i.corrections) && i.corrections.length > 0)).map((i) => [i.key, i]))
  let template = null
  if (corrected.size > 0) {
    try {
      template = loadCorrectionTemplate({ root, pluginRoot, correctionTemplate: config.correctionTemplate })
    } catch (error) {
      throw new Refusal(`${error.message}; ${NOTHING_SENT}.`)
    }
  }
  const rows = []
  const excluded = []
  for (const key of keys) {
    const issue = await issueSummary(client, key)
    const from = issue.fields.status?.name
    const way = route(facts, from, target)
    if (way.reason) {
      excluded.push({ key, reason: way.reason })
      continue
    }
    const item = corrected.get(key)
    const own = issueRows({
      key,
      summary: issue.fields.summary ?? '',
      from,
      hops: way.steps,
      target,
      assignee: issue.fields.assignee?.name !== login ? '<JIRA_ASSIGNEE>' : null,
      body: item ? renderCorrection(template, Array.isArray(item.corrections) ? item.corrections : [], Array.isArray(item.answers) ? item.answers : []) : undefined
    })
    if (own.length === 0) {
      excluded.push({ key, reason: `already ${target} and assigned to the developer` })
      continue
    }
    rows.push(...own)
  }
  const plan = { version: 1, operation: 'transition', purpose: 'start', allowlist: env.allowedProjects, discoveredAt: facts.discoveredAt, rows, excluded }
  return held(ctx, 'start', plan)
}

async function handoff(ctx) {
  const { input, config, env, client, facts, root, pluginRoot } = ctx
  checkHeldInput(input, 'handoff')
  if (input.apply !== undefined) return applyHeld(ctx, 'handoff')
  const errors = [...checkMr(input.mr)]
  for (const item of input.items) errors.push(...checkFields(item.key, item.state, item.fields))
  if (errors.length > 0) throw new Refusal(`${errors.join('; ')}; ${NOTHING_SENT}.`)
  const keys = input.items.map((i) => i.key)
  if (new Set(keys).size !== keys.length) throw new Refusal(`an issue appears twice in items; ${NOTHING_SENT}.`)
  assertKeysAllowed(keys, env)
  const moving = input.items.some((i) => i.state !== 'partial')
  const target = config.statuses.handoff
  const initial = config.statuses.initial
  if (moving && !target) throw new Refusal(`config.statuses.handoff names no hand-off status; ${NOTHING_SENT}.`)
  if (moving && !env.qa) throw new Refusal(`JIRA_QA, the tester's login, is not set in the env file; ${NOTHING_SENT}.`)
  let template
  try {
    template = loadTemplate({ root, pluginRoot, commentTemplate: config.commentTemplate })
  } catch (error) {
    throw new Refusal(`${error.message}; ${NOTHING_SENT}.`)
  }

  const rows = []
  const excluded = []
  // A partial issue with no route back: commented, not moved, and the plan says why.
  const unmoved = []
  for (const item of input.items) {
    const body = renderComment(template, item.state, item.fields, input.mr)
    const issue = await issueSummary(client, item.key)
    const summary = issue.fields.summary ?? ''
    const partial = item.state === 'partial'
    if (partial && !initial) {
      rows.push(...issueRows({ key: item.key, summary, from: undefined, hops: [], target, assignee: null, body }))
      continue
    }
    const from = issue.fields.status?.name
    // A partial issue goes back to the initial status, never through the hand-off status: that
    // would notify the tester.
    const way = partial ? route(facts, from, initial, target ? [target] : []) : route(facts, from, target)
    // What remains is always commented: a partial issue with no route keeps its status.
    if (way.reason && partial) {
      unmoved.push({ key: item.key, reason: way.reason })
      rows.push(...issueRows({ key: item.key, summary, from: undefined, hops: [], target, assignee: null, body }))
      continue
    }
    if (way.reason) {
      excluded.push({ key: item.key, reason: way.reason })
      continue
    }
    rows.push(...issueRows({ key: item.key, summary, from, hops: way.steps, target: partial ? initial : target, assignee: partial ? null : '<JIRA_QA>', body }))
  }
  const operation = rows.some((r) => r.steps.some((s) => s.transitionId)) ? 'transition' : 'comment'
  const plan = { version: 1, operation, purpose: 'handoff', allowlist: env.allowedProjects, discoveredAt: facts.discoveredAt, rows, excluded, ...(unmoved.length > 0 ? { unmoved } : {}) }
  return held(ctx, 'handoff', plan)
}
