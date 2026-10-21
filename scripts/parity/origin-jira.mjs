#!/usr/bin/env node
// Dev tool: compares the Jira plugin (plugins/adf-jira/scripts) with the origin's TypeScript
// plugin (.claude/plugins/jira) on the same inputs, offline. No network call is made, nothing is
// written in the origin project, and no env or credentials file of the origin is read.
//
//   node scripts/parity/origin-jira.mjs <origin project root>
//
// How the origin runs: its own jest setup transpiles with ts-jest to CommonJS. This tool uses
// the same compiler, the `typescript` package of the origin's node_modules, read only: each .ts
// file is transpiled in memory (`transpileModule`, CommonJS, ES2020) and evaluated with a
// require that loads sibling .ts files the same way and returns stubs for the HTTP client and
// the env resolver where a script's `main` is run. The read scripts call `main()` on import, so
// they are evaluated with a stubbed `process` and `console`; their client is a stub that
// returns fixture issues and comments.
//
// Parts, each compared on a generated corpus:
//   paths     solvePath over random graphs and the origin's own discovered workflow, when present
//   allowlist projectOf, assertAllowlist, validatePlan, planFileName
//   render    renderPlan over generated plans of every row shape
//   env       parseEnvFile over generated text; resolveEnv over generated layer files
//   readers   the issue and comment row builders, and both read scripts' payloads
//
// Differences the port makes on purpose are asserted as expected, never counted as failures:
//   configured-allowlist   apply also checks the plan's own allowlist against the configured one
//   placeholders-at-apply  login placeholders stay in the plan and are resolved at apply
//   comments-all-pages     read-comments reads every page; the origin read the first page only
//   main-checkout          the env file is read from the main checkout of a worktree
//   config-wins            config.baseUrl and config.allowlist win over JIRA_URL and
//                          JIRA_ALLOWED_PROJECTS
//   message-wording        the missing-variable message names the env file path it read and the
//                          plugin's env.example; the allowlist messages say "the allowlist"
//                          instead of JIRA_ALLOWED_PROJECTS (follows from config-wins)
// start/handoff writing one row per step has no origin counterpart (the origin has no tracker)
// and is not exercised here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { solvePath } from '../../plugins/adf-jira/scripts/lib/paths.mjs'
import { assertAllowlist, assertConfiguredAllowlist, planFileName, projectOf, validatePlan } from '../../plugins/adf-jira/scripts/lib/plan.mjs'
import { renderPlan } from '../../plugins/adf-jira/scripts/lib/report.mjs'
import { parseEnvFile, resolveEnv } from '../../plugins/adf-jira/scripts/lib/env.mjs'
import { loadContext } from '../../plugins/adf-jira/scripts/lib/context.mjs'
import { resolvePlaceholders, placeholderValues } from '../../plugins/adf-jira/scripts/lib/placeholders.mjs'
import { commentRow, issueRow } from '../../plugins/adf-jira/scripts/lib/readers.mjs'
import { main as portReadIssues } from '../../plugins/adf-jira/scripts/read-issues.mjs'
import { main as portReadComments } from '../../plugins/adf-jira/scripts/read-comments.mjs'

const origin = process.argv[2]
const pluginDir = origin && join(origin, '.claude', 'plugins', 'jira')
const tsPath = origin && join(origin, 'node_modules', 'typescript')
if (!pluginDir || !existsSync(join(pluginDir, 'lib', 'paths.ts')) || !existsSync(tsPath)) {
  console.error('usage: origin-jira.mjs <origin project root with .claude/plugins/jira and node_modules/typescript>')
  process.exit(2)
}
const ts = createRequire(join(origin, 'package.json'))('typescript')
const nodeRequire = createRequire(import.meta.url)

// ---------------------------------------------------------------- the origin's TypeScript

// Evaluates one .ts file as CommonJS. `stubs` maps a specifier as written in the source to the
// module it returns; `globals` replaces `process` and `console` for that file.
function loadTs(file, { stubs = {}, globals = {}, cache = new Map() } = {}) {
  if (cache.has(file)) return cache.get(file).exports
  const source = readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  })
  const module = { exports: {} }
  cache.set(file, module)
  const require = (spec) => {
    if (spec in stubs) return stubs[spec]
    if (spec.startsWith('.')) return loadTs(resolve(dirname(file), `${spec}.ts`), { stubs: {}, cache })
    return nodeRequire(spec)
  }
  const proc = globals.process ?? process
  const cons = globals.console ?? console
  new Function('exports', 'require', 'module', '__filename', '__dirname', 'process', 'console', outputText)(module.exports, require, module, file, dirname(file), proc, cons)
  return module.exports
}

const lib = (name) => loadTs(join(pluginDir, 'lib', `${name}.ts`))
const theirs = { paths: lib('paths'), plan: lib('plan'), report: lib('report'), env: lib('env') }

// Runs one origin read script's top-level main() with stubs, and resolves with what it printed.
function runOriginScript(name, argv, { env, client }) {
  return new Promise((done) => {
    const printed = { out: [], err: [], exit: null }
    const finish = () => setImmediate(() => done(printed))
    const fakeProcess = { argv: ['node', `${name}.ts`, ...argv], env: {}, cwd: () => '/parity/origin-cwd', stderr: { write: (s) => printed.err.push(s) }, exit: (code) => { printed.exit = code; finish() } }
    const fakeConsole = { log: (s) => { printed.out.push(s); finish() }, error: (s) => printed.err.push(s) }
    let exports
    const stubs = {
      '../lib/client': { JiraClient: class { constructor() { return client } } },
      '../lib/env': { resolveEnv: () => ({ env, sources: [] }) },
      '../lib/profile': { describeSources: () => '' }
    }
    exports = loadTs(join(pluginDir, 'scripts', `${name}.ts`), { stubs: { ...stubs, '../lib/plan': theirs.plan }, globals: { process: fakeProcess, console: fakeConsole } })
    printed.exports = exports
  })
}

// ---------------------------------------------------------------- helpers

let seed = 0x5eed
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(rand() * list.length)]
const some = (list, p = 0.5) => list.filter(() => rand() < p)
const outcome = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

const parts = {}
const part = (name) => (parts[name] ??= { compared: 0, failures: [], expected: {} })
function compare(name, input, mine, their) {
  const p = part(name)
  p.compared++
  if (!isDeepStrictEqual(mine, their) && p.failures.length < 20) p.failures.push({ input, ours: mine, theirs: their })
}
function expect(name, reason, holds, detail) {
  const p = part(name)
  p.expected[reason] ??= { asserted: 0, broken: [] }
  p.expected[reason].asserted++
  if (!holds && p.expected[reason].broken.length < 10) p.expected[reason].broken.push(detail)
}

// ---------------------------------------------------------------- paths

const STATUSES = ['Opened', 'In Progress', 'Review', 'Resolved', 'Closed', 'Reopened', 'Suspended']
let transitionId = 0
const transition = (to) => ({ id: String(++transitionId), name: `to ${to}`, to, requiredFields: some(['resolution', 'assignee'], 0.3), allowedValues: {} })
function randomGraph() {
  const graph = {}
  for (const status of some(STATUSES, 0.8)) graph[status] = Array.from({ length: Math.floor(rand() * 4) }, () => transition(pick(STATUSES)))
  return graph
}
const graphs = Array.from({ length: 150 }, randomGraph)
const discovered = join(origin, '.claude', 'jira', 'profile', 'discovered.json')
let realGraph = false
if (existsSync(discovered)) {
  try {
    const facts = JSON.parse(readFileSync(discovered, 'utf8'))
    if (facts.workflow && typeof facts.workflow === 'object') {
      graphs.push(facts.workflow)
      realGraph = true
    }
  } catch {}
}
for (const graph of graphs) {
  const names = [...new Set([...STATUSES, ...Object.keys(graph), ...Object.values(graph).flat().map((t) => t.to), 'Nowhere'])]
  for (const unsampled of [undefined, [], some(names, 0.3)]) {
    for (const from of names) for (const to of names) {
      compare('paths', { from, to, unsampled }, solvePath(graph, from, to, unsampled), theirs.paths.solvePath(graph, from, to, unsampled))
    }
  }
}

// ---------------------------------------------------------------- allowlist

const PROJECTS = ['ABC', 'XYZ', 'DEST', 'Q1']
const KEYS = ['ABC-1', 'ABC-22', 'XYZ-3', 'DEST-797', 'Q1-5', 'abc-1', 'ABC', 'ABC-', '1A-2', 'ABC-1x', '', 'X9Y-10']
for (const key of KEYS) compare('allowlist', { projectOf: key }, outcome(() => projectOf(key)), outcome(() => theirs.plan.projectOf(key)))

const OPERATIONS = ['transition', 'edit', 'create', 'worklog', 'comment']
function randomRow(allowGood = true) {
  const row = { key: allowGood ? pick(KEYS.slice(0, 5)) : pick(KEYS), summary: pick(['Fix it', 'Add thing', '']), state: 'pending', steps: [] }
  if (rand() < 0.2) row.project = pick(PROJECTS)
  for (let i = Math.floor(rand() * 3); i > 0; i--) {
    row.steps.push(rand() < 0.4 ? { link: { type: 'Blocks', inwardIssue: pick(KEYS), outwardIssue: pick(KEYS) } } : { to: pick(STATUSES) })
  }
  return row
}
for (let i = 0; i < 1500; i++) {
  const plan = { version: 1, operation: pick(OPERATIONS), allowlist: some(PROJECTS, 0.6), discoveredAt: '2026-10-01T00:00:00.000Z', rows: Array.from({ length: Math.floor(rand() * 5) }, () => randomRow(rand() < 0.7)) }
  compare('allowlist', { assertAllowlist: plan }, outcome(() => assertAllowlist(plan)), outcome(() => theirs.plan.assertAllowlist(plan)))

  // configured-allowlist: a plan the origin accepts is refused by the port exactly when its own
  // allowlist names a project outside the configured one.
  const configured = some(PROJECTS, 0.6)
  if (outcome(() => theirs.plan.assertAllowlist(plan)).ok) {
    const foreign = plan.allowlist.some((p) => !configured.includes(p))
    const ours = outcome(() => assertConfiguredAllowlist(plan, configured))
    expect('allowlist', 'configured-allowlist', ours.ok === !foreign, { allowlist: plan.allowlist, configured, ours })
  }
}

const malformed = [
  null, [], 'plan', {}, { version: 2 }, { version: 1, operation: 'delete' }, { version: 1, operation: 'edit' },
  { version: 1, operation: 'edit', allowlist: 'ABC' }, { version: 1, operation: 'edit', allowlist: [] },
  { version: 1, operation: 'edit', allowlist: [], rows: [null] }, { version: 1, operation: 'edit', allowlist: [], rows: [{ key: 1 }] },
  { version: 1, operation: 'edit', allowlist: [], rows: [{ key: 'ABC-1', state: 'new' }] },
  { version: 1, operation: 'edit', allowlist: [], rows: [{ key: 'ABC-1', state: 'done' }] },
  { version: 1, operation: 'edit', allowlist: [], rows: [{ key: 'ABC-1', state: 'skipped-drift', steps: [] }] }
]
for (const value of malformed) compare('allowlist', { validatePlan: value }, outcome(() => validatePlan(value)), outcome(() => theirs.plan.validatePlan(value)))
for (const iso of ['2026-10-21T00:00:00.000Z', '2026-01-02T23:59:59.999Z', '1999-12-31T09:05:00.000Z']) {
  for (const op of OPERATIONS) compare('allowlist', { planFileName: [op, iso] }, planFileName(op, new Date(iso)), theirs.plan.planFileName(op, new Date(iso)))
}

// ---------------------------------------------------------------- render

const VALUES = [
  'plain', 42, null, true, ['a', 'b'], { name: 'High' }, { key: 'ABC-9' }, { value: 'Yes' }, { id: '10001' }, { other: 1 },
  [{ name: 'x' }, { key: 'K-1' }, 3], { name: 7, key: 'K' }, undefined
]
const LONG = 'word '.repeat(30)
function shapedSteps(shape) {
  switch (shape) {
    case 'transition': return Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ transitionId: '1', to: pick(STATUSES), ...(rand() < 0.4 ? { fields: { resolution: pick(VALUES) } } : {}) }))
    case 'edit': return [{ fields: Object.fromEntries(some(['priority', 'labels', 'assignee', 'customfield_1'], 0.6).map((k) => [k, pick(VALUES)])) }]
    case 'create': return [{ create: { fields: { ...(rand() < 0.8 ? { project: pick([{ key: 'ABC' }, 'XYZ']) } : {}), ...(rand() < 0.8 ? { issuetype: pick([{ name: 'Task' }, { id: '3' }, 'Bug']) } : {}), summary: pick(['S', LONG]), labels: pick(VALUES) } } }]
    case 'worklog': return [{ worklog: { timeSpent: pick(['8h', '4h 30m']), ...(rand() < 0.6 ? { started: '2026-10-20T09:00:00.000+0300' } : {}), ...(rand() < 0.6 ? { comment: pick(['did it', LONG]) } : {}) } }]
    case 'link': return [{ link: { type: pick(['Blocks', 'Relates']), inwardIssue: 'ABC-1', outwardIssue: 'ABC-2' } }]
    case 'comment': return [{ comment: rand() < 0.5 ? { action: 'add', body: pick(['short', LONG]) } : { action: 'edit', id: '100', body: pick(['short', LONG]) } }]
    default: return []
  }
}
for (let i = 0; i < 600; i++) {
  const shapes = some(['transition', 'edit', 'create', 'worklog', 'link', 'comment', 'empty'], 0.4)
  const template = shapes.map((shape) => ({ shape, steps: shapedSteps(shape), from: rand() < 0.7 ? pick(STATUSES) : undefined }))
  const rows = []
  for (let n = Math.floor(rand() * 9); n > 0 && template.length > 0; n--) {
    const t = pick(template)
    rows.push({ key: `ABC-${rows.length + 1}`, summary: pick(['Fix it', 'Add thing', '']), from: t.from, ...(rand() < 0.1 ? { project: 'XYZ' } : {}), state: 'pending', steps: t.steps })
  }
  const plan = { version: 1, operation: 'edit', allowlist: ['ABC'], discoveredAt: '2026-10-01T00:00:00.000Z', rows }
  const opts = {
    plan,
    planPath: '/plans/plan.json',
    title: 'jira:apply — edit',
    ...(rand() < 0.4 ? { excluded: some([{ key: 'ABC-90', reason: 'closed' }, { key: 'ABC-91', reason: 'closed' }, { key: 'ABC-92', reason: 'no path' }], 0.6) } : {}),
    ...(rand() < 0.4 ? { sampleSize: pick([0, 1, 2, 5]) } : {})
  }
  compare('render', { opts }, outcome(() => renderPlan(opts)), outcome(() => theirs.report.renderPlan(opts)))
}

// placeholders-at-apply: the port's preview of a plan with placeholders equals the origin's
// rendering of the same plan with the logins written in; the plan itself keeps the placeholder.
{
  const values = placeholderValues({ assignee: 'dev.one', pm: 'pm.one', qa: 'qa.one' })
  for (const [placeholder, login] of [['<JIRA_ASSIGNEE>', 'dev.one'], ['<JIRA_PM>', 'pm.one'], ['<JIRA_QA>', 'qa.one']]) {
    const plan = { version: 1, operation: 'edit', allowlist: ['ABC'], discoveredAt: 'd', rows: [{ key: 'ABC-1', summary: 'S', state: 'pending', steps: [{ fields: { assignee: { name: placeholder } } }] }] }
    const literal = JSON.parse(JSON.stringify(plan).replaceAll(placeholder, login))
    const ours = renderPlan({ plan: resolvePlaceholders(plan, values), planPath: 'p', title: 't' })
    const their = theirs.report.renderPlan({ plan: literal, planPath: 'p', title: 't' })
    expect('render', 'placeholders-at-apply', ours === their && plan.rows[0].steps[0].fields.assignee.name === placeholder, { placeholder, ours, their })
  }
}

// ---------------------------------------------------------------- env

const LINES = [
  'JIRA_URL=https://jira.example', ' JIRA_PAT = "tok en" ', "JIRA_QA='qa.one'", '# JIRA_PM=nope', '', '   ', 'noequals',
  '=value', 'JIRA_X="', 'JIRA_Y=a=b', 'JIRA_Z="a" b', 'JIRA_W=\'\'', 'JIRA_V=""', 'export JIRA_U=1', 'OTHER=1', 'JIRA_URL=second',
  'JIRA_CR=value\r', '\tJIRA_TAB=\tv\t', 'JIRA_Q="mixed\''
]
for (let i = 0; i < 1500; i++) {
  const text = Array.from({ length: Math.floor(rand() * 8) }, () => pick(LINES)).join(pick(['\n', '\r\n']))
  compare('env', { parseEnvFile: text }, parseEnvFile(text), theirs.env.parseEnvFile(text))
}

const ENV_VALUES = {
  JIRA_URL: ['', 'https://jira.example', 'https://jira.example///', 'https://other.example/'],
  JIRA_PAT: ['', 'token-1', 'token-22'],
  JIRA_ALLOWED_PROJECTS: ['', 'ABC', ' ABC , XYZ ', ',', ' , '],
  JIRA_ASSIGNEE: ['', 'dev.one'],
  JIRA_PM: ['', 'pm.one'],
  JIRA_QA: ['', 'qa.one'],
  JIRA_GIT_AUTHOR: ['', 'Dev One'],
  JIRA_DEFAULT_PROJECT: ['', 'ABC'],
  NOT_JIRA: ['', 'x']
}
const randomLayer = () => (rand() < 0.2 ? null : Object.fromEntries(some(Object.keys(ENV_VALUES), 0.5).map((k) => [k, pick(ENV_VALUES[k])])))
const envText = (layer) => Object.entries(layer).map(([k, v]) => `${k}=${rand() < 0.3 ? `"${v}"` : v}`).join('\n')
const missingOf = (message) => /^Missing required variable\(s\): ([A-Z_, ]+)\./.exec(message)?.[1].split(', ') ?? null
const sortSources = (sources) => [...sources].sort((a, b) => a.key.localeCompare(b.key))
const scratch = mkdtempSync(join(tmpdir(), 'adf-parity-jira-'))
try {
  for (let i = 0; i < 400; i++) {
    const projectDir = join(scratch, `p${i}`)
    const homeDir = join(scratch, `h${i}`)
    const [processLayer, projectLayer, homeLayer] = [randomLayer() ?? {}, randomLayer(), randomLayer()]
    if (projectLayer) {
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      writeFileSync(join(projectDir, '.claude', '.env'), envText(projectLayer))
    }
    if (homeLayer) {
      mkdirSync(join(homeDir, '.claude'), { recursive: true })
      writeFileSync(join(homeDir, '.claude', '.env'), envText(homeLayer))
    }
    const args = { projectDir, homeDir, processEnv: processLayer }
    const ours = outcome(() => resolveEnv(args))
    const their = outcome(() => theirs.env.resolveEnv(args))
    if (ours.ok || their.ok) {
      compare('env', { resolveEnv: { processLayer, projectLayer, homeLayer } }, ours.ok && { env: ours.value.env, sources: ours.value.sources }, their.ok && their.value)
    } else {
      // Same refusal: the same missing list, or the same message when nothing is missing.
      const [m, t] = [missingOf(ours.error), missingOf(their.error)]
      compare('env', { resolveEnv: { processLayer, projectLayer, homeLayer } }, m ?? ours.error, t ?? their.error)
      if (m && t) expect('env', 'message-wording', ours.error.includes(join(projectDir, '.claude', '.env')) && ours.error.includes("plugin's env.example"), { ours: ours.error })
    }

    // config-wins: with a registry baseUrl and allowlist, the port equals the origin run with
    // JIRA_URL and JIRA_ALLOWED_PROJECTS set to them, the two sources renamed to the config.
    const config = { baseUrl: pick(['https://cfg.example', 'https://cfg.example/']), allowlist: some(PROJECTS, 0.6).concat('ABC') }
    const ourCfg = outcome(() => resolveEnv({ ...args, config }))
    const theirCfg = outcome(() => theirs.env.resolveEnv({ ...args, processEnv: { ...processLayer, JIRA_URL: config.baseUrl, JIRA_ALLOWED_PROJECTS: config.allowlist.join(',') } }))
    const renamed = theirCfg.ok && sortSources(theirCfg.value.sources.map((s) => (s.key === 'JIRA_URL' ? { key: 'baseUrl', layer: 'config', length: s.length } : s.key === 'JIRA_ALLOWED_PROJECTS' ? { key: 'allowlist', layer: 'config', length: s.length } : s)))
    const holds = ourCfg.ok === theirCfg.ok && (ourCfg.ok ? isDeepStrictEqual(ourCfg.value.env, theirCfg.value.env) && isDeepStrictEqual(sortSources(ourCfg.value.sources), renamed) : isDeepStrictEqual(missingOf(ourCfg.error), missingOf(theirCfg.error)))
    expect('env', 'config-wins', holds, { config, processLayer, projectLayer, homeLayer, ours: ourCfg, theirs: theirCfg })
  }

  // main-checkout: from a worktree, the port reads the main checkout's env file; the origin,
  // which reads the working directory's, finds nothing there.
  {
    const main = join(scratch, 'main')
    const worktree = join(main, '.claude', 'worktrees', 'T-1')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(main, '.claude', '.env'), 'JIRA_URL=https://main.example\nJIRA_PAT=t\nJIRA_ALLOWED_PROJECTS=ABC\n')
    const home = join(scratch, 'empty-home')
    const ours = outcome(() => loadContext({ cwd: worktree, home, processEnv: {}, run: () => join(main, '.git') }))
    const their = outcome(() => theirs.env.resolveEnv({ projectDir: worktree, homeDir: home, processEnv: {} }))
    expect('env', 'main-checkout', ours.ok && ours.value.env.url === 'https://main.example' && !their.ok, { ours, their })
  }

  // ---------------------------------------------------------------- readers

  const person = [undefined, null, {}, { name: 'dev' }, { displayName: 'Dev One' }, { name: 'dev', displayName: 'Dev One' }, { displayName: '' }, { name: 5 }]
  const fieldVariants = {
    summary: [undefined, '', 'Summary', 7],
    description: [undefined, null, '', 'Text'],
    status: [undefined, null, { name: 'Opened' }, { id: '1' }, 'Opened'],
    assignee: person,
    issuetype: [undefined, { name: 'Bug' }, { name: '' }, {}],
    parent: [undefined, null, { key: 'ABC-9' }, { id: '9' }],
    resolution: [undefined, null, { name: 'Done' }],
    created: [undefined, '', '2026-10-01T10:00:00.000+0000'],
    updated: [undefined, '2026-10-02T10:00:00.000+0000'],
    labels: [undefined, [], ['a', 1, 'b', null], 'a']
  }
  const randomIssue = (key) => ({ key, fields: Object.fromEntries(Object.entries(fieldVariants).map(([k, v]) => [k, pick(v)]).filter(([, v]) => v !== undefined)) })
  const randomComment = (i) => {
    const c = { id: pick([i, String(i), undefined]), author: pick(person), created: pick([undefined, '', '2026-10-01']), updated: pick([undefined, '2026-10-03']), body: pick([undefined, null, '', 'body text']) }
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k]
    return c
  }
  const issues = Array.from({ length: 400 }, (_, i) => randomIssue(`ABC-${i + 1}`))
  const comments = Array.from({ length: 400 }, (_, i) => randomComment(i))

  const issueScript = await runOriginScript('read-issues', [], { env: { allowedProjects: ['ABC'] }, client: { search: async () => [] } })
  const commentScript = await runOriginScript('read-comments', [], { env: { allowedProjects: ['ABC'] }, client: { get: async () => ({}) } })
  for (const issue of issues) compare('readers', { issue }, issueRow(issue), issueScript.exports.toRow(issue))
  for (const comment of comments) compare('readers', { comment }, commentRow(comment), commentScript.exports.toRow(comment))

  // The scripts' payloads, with the same rows fed to both: the origin through its stubbed
  // client, the port through a fake fetch over its real client.
  const portEnv = { JIRA_URL: 'https://jira.example', JIRA_PAT: 't', JIRA_ALLOWED_PROJECTS: 'ABC' }
  const portDeps = (fetch, printed) => ({ cwd: scratch, home: join(scratch, 'empty-home'), processEnv: portEnv, run: () => null, fetch, now: () => new Date(0), out: (s) => printed.push(s), err: () => {} })
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  const withoutReadAt = (text) => {
    const { readAt, ...rest } = JSON.parse(text)
    return rest
  }

  for (const [label, selection] of [['none', []], ['some', issues.slice(0, 7)], ['many', issues.slice(0, 120)], ['foreign', [issues[0], { key: 'XYZ-1', fields: {} }]]]) {
    const their = await runOriginScript('read-issues', ['project = ABC'], { env: { allowedProjects: ['ABC'] }, client: { search: async () => selection } })
    const printed = []
    const fetch = async (url, init) => {
      const { startAt, maxResults } = JSON.parse(init.body)
      return json({ startAt, maxResults, total: selection.length, issues: selection.slice(startAt, startAt + maxResults) })
    }
    const ours = await portReadIssues(['project = ABC'], portDeps(fetch, printed)).then(() => ({ ok: true, payload: withoutReadAt(printed[0]) }), (e) => ({ ok: false, error: e.message }))
    const theirsResult = their.exit === null ? { ok: true, payload: withoutReadAt(their.out[0]) } : { ok: false, error: their.err.at(-1) }
    if (label === 'foreign') {
      expect('readers', 'message-wording', !ours.ok && !theirsResult.ok && ours.error === theirsResult.error.replace('outside JIRA_ALLOWED_PROJECTS', 'outside the allowlist'), { ours, theirs: theirsResult })
    } else {
      compare('readers', { readIssues: label }, ours, theirsResult)
    }
  }

  for (const [label, key, all] of [['one page', 'ABC-1', comments.slice(0, 30)], ['empty', 'ABC-2', []], ['three pages', 'ABC-3', comments.slice(0, 250)], ['foreign', 'XYZ-1', comments.slice(0, 3)]]) {
    const theirCalls = []
    const pageSize = 100
    const their = await runOriginScript('read-comments', [key], {
      env: { allowedProjects: ['ABC'] },
      client: { get: async (path) => { theirCalls.push(path); return { startAt: 0, maxResults: pageSize, total: all.length, comments: all.slice(0, pageSize) } } }
    })
    const ourCalls = []
    const printed = []
    const fetch = async (url) => {
      ourCalls.push(url)
      const q = new URL(url).searchParams
      const startAt = Number(q.get('startAt'))
      return json({ startAt, maxResults: pageSize, total: all.length, comments: all.slice(startAt, startAt + Number(q.get('maxResults'))) })
    }
    const ours = await portReadComments([key], portDeps(fetch, printed)).then(() => ({ ok: true, payload: withoutReadAt(printed[0]) }), (e) => ({ ok: false, error: e.message }))
    const theirsResult = their.exit === null ? { ok: true, payload: withoutReadAt(their.out[0]) } : { ok: false, error: their.err.at(-1) }
    if (label === 'foreign') {
      const refusedBeforeRequest = ourCalls.length === 0 && theirCalls.length === 0
      expect('readers', 'message-wording', refusedBeforeRequest && !ours.ok && !theirsResult.ok && ours.error === theirsResult.error.replace('outside JIRA_ALLOWED_PROJECTS', 'outside the allowlist'), { ours, theirs: theirsResult })
    } else if (all.length > pageSize) {
      const complete = ours.ok && ours.payload.count === all.length && isDeepStrictEqual(ours.payload.comments, all.map(commentRow))
      const firstPageOnly = theirsResult.ok && theirsResult.payload.count === pageSize
      expect('readers', 'comments-all-pages', complete && firstPageOnly && ourCalls.length === Math.ceil(all.length / pageSize), { ours: ours.payload?.count, theirs: theirsResult.payload?.count, calls: ourCalls.length })
    } else {
      compare('readers', { readComments: label }, ours, theirsResult)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------- report

const broken = Object.values(parts).some((p) => p.failures.length > 0 || Object.values(p.expected).some((e) => e.broken.length > 0))
const report = Object.fromEntries(Object.entries(parts).map(([name, p]) => [name, {
  compared: p.compared,
  failures: p.failures.length,
  expected: Object.fromEntries(Object.entries(p.expected).map(([r, e]) => [r, `${e.asserted - e.broken.length}/${e.asserted}`])),
  ...(p.failures.length > 0 ? { firstFailures: p.failures.slice(0, 5) } : {}),
  ...(Object.values(p.expected).some((e) => e.broken.length > 0) ? { brokenExpectations: Object.fromEntries(Object.entries(p.expected).filter(([, e]) => e.broken.length > 0).map(([r, e]) => [r, e.broken.slice(0, 3)])) } : {})
}]))
console.log(JSON.stringify({ originGraph: realGraph, ...report }, null, 2))
process.exitCode = broken ? 1 : 0
