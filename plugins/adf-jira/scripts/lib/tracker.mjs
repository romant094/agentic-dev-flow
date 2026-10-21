// The `tracker` role of the ADF contract (1.7) on Jira, over the plugin's own engine: the
// profile, the path solver, the plan and its two-phase apply.
//
//   check    the env, the config, the token (GET /rest/api/2/myself) and the profile
//   gather   the named issues (or a text search in the allowlisted projects), their parent,
//            sub-tasks and linked issues; one JSON file per issue under input.stateDir
//   start    a held plan: each issue to the start status, assigned to the developer
//   handoff  a held plan: the templated comment; for taken and not-reproduced items also the
//            hand-off status and the tester (JIRA_QA) as assignee
//
// start and handoff without `apply` build the plan in input.stateDir and send nothing
// (`held`); with `apply: <plan id>` they run that plan. A rerun with the same id resumes from
// the plan's per-row state; an issue moved by hand meanwhile is skipped, not failed.
//
// Every result is one object with `state`: done, degraded (nothing sent; `tool` and `hint`)
// or refused (`error`). No result carries a secret: the env is described by name, layer and
// length. Jira is reached only through the injected `fetch`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { JiraClient, JiraError } from './client.mjs'
import { checkFields, checkMr, loadTemplate, renderComment } from './comment.mjs'
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
  return done({ tool: 'ready', account: me?.name ?? me?.key ?? null, sources, profile: { discoveredAt: profile.facts.discoveredAt } })
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
  if ((keys === undefined) === (text === undefined)) throw new Refusal(`gather takes keys or text, one of them; ${NOTHING_SENT}.`)
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

  let named
  if (keys !== undefined) {
    named = [...new Set(keys)]
  } else {
    const projects = env.allowedProjects.map((p) => `"${p}"`).join(', ')
    const jql = `project in (${projects}) AND text ~ "${text.replace(/["\\]/g, '\\$&')}" AND statusCategory != Done ORDER BY key ASC`
    named = (await client.search(jql, ['key'], TEXT_SEARCH_LIMIT)).map((i) => i.key)
    if (named.length === TEXT_SEARCH_LIMIT) notes.push(`the text search stopped at ${TEXT_SEARCH_LIMIT} issues; name keys to narrow it`)
    if (named.length === 0) notes.push('the text search found no open issue')
  }

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

  for (const key of named) await read(key)
  for (const key of named.filter((k) => issues.has(k))) {
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
  rankBranches(items)
  return done({ change, items, notes })
}

// The branch key's priority: a named sub-task, then the lowest sub-task, then the lowest bug,
// then a named task. Equal ranks are a tie the core asks about; an excluded item and an epic
// are not ranked.
export function rankBranches(items) {
  const tier = (item) => {
    if (item.excluded || item.kind === 'epic') return null
    if (item.subtask && item.named) return [1, 0]
    if (item.subtask) return [2, keyNumber(item.key)]
    if (item.kind === 'bug') return [3, keyNumber(item.key)]
    if (item.named) return [4, 0]
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
// requires a field is not taken: the plugin never fills a required field on its own.
function route(facts, from, target) {
  const unsampled = (facts.unsampledStatuses ?? []).map((u) => u.status)
  const path = solvePath(facts.workflow, from, target, unsampled)
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

function previewOf(plan, values) {
  const lines = []
  for (const row of plan.rows) {
    const resolved = resolvePlaceholders(row, values)
    const stops = resolved.steps.map((s) => s.to).filter(Boolean)
    const assignee = resolved.steps.find((s) => s.fields?.assignee)?.fields.assignee.name
    const parts = []
    if (stops.length > 0) parts.push(`${[row.from, ...stops].join(' → ')}`)
    else if (row.from !== undefined) parts.push(`stays ${row.from}`)
    if (assignee) parts.push(`assignee ${assignee}`)
    const comment = resolved.steps.find((s) => s.comment)?.comment.body
    if (comment !== undefined) parts.push('comment:')
    lines.push(`${row.key} ${row.summary}: ${parts.join('; ')}`)
    if (comment !== undefined) for (const line of comment.split('\n')) lines.push(`    ${line}`)
  }
  for (const { key, reason } of plan.excluded ?? []) lines.push(`${key} skipped: ${reason}`)
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
  for (const row of plan.rows) {
    if (row.state === 'done') applied.push(row.key)
    else if (row.state === 'skipped-drift') skipped.push({ key: row.key, reason: row.error })
    else if (row.state === 'failed') failed.push({ key: row.key, reason: row.error })
    else failed.push({ key: row.key, reason: 'not attempted: the run stopped after 3 consecutive failures; fix the cause and rerun the same plan' })
  }
  return done({ plan: input.apply, applied, skipped, failed, aborted: outcome.abortedAfterConsecutiveFailures })
}

async function start(ctx) {
  const { input, config, env, client, facts } = ctx
  checkHeldInput(input, 'start')
  if (input.apply !== undefined) return applyHeld(ctx, 'start')
  const keys = [...new Set(input.items.map((i) => i.key))]
  assertKeysAllowed(keys, env)
  const target = config.statuses.start
  const login = env.assignee ?? (await myself(client))?.name
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
    const steps = [...way.steps]
    if (issue.fields.assignee?.name !== login) steps.push({ fields: { assignee: { name: '<JIRA_ASSIGNEE>' } } })
    if (steps.length === 0) {
      excluded.push({ key, reason: `already ${target} and assigned to the developer` })
      continue
    }
    rows.push({ key, summary: issue.fields.summary ?? '', from, steps, state: 'pending' })
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
  for (const item of input.items) {
    const body = renderComment(template, item.state, item.fields, input.mr)
    const issue = await issueSummary(client, item.key)
    const summary = issue.fields.summary ?? ''
    const comment = { comment: { action: 'add', body } }
    if (item.state === 'partial') {
      rows.push({ key: item.key, summary, steps: [comment], state: 'pending' })
      continue
    }
    const from = issue.fields.status?.name
    const way = route(facts, from, target)
    if (way.reason) {
      excluded.push({ key: item.key, reason: way.reason })
      continue
    }
    rows.push({ key: item.key, summary, from, steps: [...way.steps, { fields: { assignee: { name: '<JIRA_QA>' } } }, comment], state: 'pending' })
  }
  const operation = rows.some((r) => r.steps.some((s) => s.transitionId)) ? 'transition' : 'comment'
  const plan = { version: 1, operation, purpose: 'handoff', allowlist: env.allowedProjects, discoveredAt: facts.discoveredAt, rows, excluded }
  return held(ctx, 'handoff', plan)
}
