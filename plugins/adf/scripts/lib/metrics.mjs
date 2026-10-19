// One change's metrics record (`schema/metrics.schema.json`, schemaVersion 2; the format is
// published as contract/metrics-format.md): assembled by script from the change's SDD records
// (lib/metrics-records.mjs), its session transcripts (lib/transcripts.mjs, lib/metrics-facts.mjs)
// and git, then checked against the schema. A record keeps tokens only: `cost` prices them with
// the dated price table (lib/prices.mjs) at the time the record is read.
//
//   buildRecord  every group of the record; a group whose source is absent is null and its
//                `sources.coverage` entry names the reason, never a 0 that reads as measured
//   fromV1       the origin's schemaVersion 1 records, converted; what the origin did not keep,
//                or kept in a form that does not map, is null with a reason starting "v1:"
//   cost         USD over `tokens.byModelDay`, each day at the price entry in force on it
//   renderRecord the record as Markdown for a person
//
// Git figures come from the change's range (`git merge-base <base> HEAD`..HEAD), never from the
// working tree. Machine paths are kept out of a record: it is committed.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBranches } from './branches.mjs'
import { ARCHIVE, CHANGES_DIR, changeDirOf, META_FILE, parseTasks } from './changes.mjs'
import { parseName } from './dispatch.mjs'
import { readSchema, validateJson } from './json-schema.mjs'
import { readRecords } from './ledger.mjs'
import { computeFacts, dayOf, levelOf, maxTurnsFromAgents, TOKEN_FIELDS, UNDATED } from './metrics-facts.mjs'
import { LAYERS, readSddRecords, removalCandidates, summarizeLedger } from './metrics-records.mjs'
import { costOf, priceAt } from './prices.mjs'
import { pluginDir, readRegistry } from './registry.mjs'
import { defaultProjectsDir, onChangeBranch, readTranscripts, RUNTIME } from './transcripts.mjs'

export const SCHEMA_VERSION = 2
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SCHEMA_PATH = join(PLUGIN_ROOT, 'schema', 'metrics.schema.json')
export const RECORD_FILE = 'metrics.json'
// The groups `sources.coverage` names, each `record` or `{ none: reason }`.
export const GROUPS = ['transcripts', 'range', 'generator', 'dispatches', 'tokens', 'context', 'cacheTtl', 'outliers', 'timing', 'autonomy', 'replies', 'impl', 'tests', 'findings', 'review', 'verify', 'ledger', 'isolation', 'compliance', 'maintainability']
const SDD_GROUPS = ['replies', 'impl', 'findings', 'compliance', 'tests', 'review', 'verify', 'ledger']
const TRANSCRIPT_GROUPS = ['transcripts', 'dispatches', 'tokens', 'context', 'cacheTtl', 'outliers', 'autonomy']
// The origin's name of the review stage's layer.
const V1_LAYERS = { 'opsx-review': 'ai-review' }

export class RecordError extends Error {
  constructor(errors) {
    super(`the metrics record fails its schema: ${errors.join('; ')}`)
    this.errors = errors
  }
}

let schema = null
// The record's errors under schema/metrics.schema.json; [] when it is valid.
export function validateRecord(record) {
  schema ??= readSchema(SCHEMA_PATH)
  return validateJson(schema, record)
}

const minutes = (ms) => Number((ms / 60000).toFixed(1))
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
const none = (reason) => ({ none: reason })

// ---------------------------------------------------------------- git

function gitOf(root) {
  return (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, '')
    } catch {
      return null
    }
  }
}

// Spec files of a change, active or archived: `openspec/changes/[archive/]<dir>/specs/<cap>/`.
const CAPABILITY = new RegExp(`^${CHANGES_DIR}/(?:${ARCHIVE}/)?[^/]+/specs/([^/]+)/`)

// The diff of the change's range: lines added and removed in all, per file (null for a binary
// file), and per capability the lines changed under the changes' delta specs. Renames are not
// followed, so a moved change directory counts once, at its new place.
export function maintainabilityOf(git, range) {
  const text = git('diff', '--numstat', '--no-renames', `${range.base}..${range.head}`)
  if (text === null) return null
  const out = { insertions: 0, deletions: 0, perFile: [], capabilities: {} }
  for (const line of text.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const insertions = m[1] === '-' ? null : Number(m[1])
    const deletions = m[2] === '-' ? null : Number(m[2])
    out.insertions += insertions ?? 0
    out.deletions += deletions ?? 0
    out.perFile.push({ file: m[3], insertions, deletions })
    const cap = CAPABILITY.exec(m[3])?.[1]
    if (cap) out.capabilities[cap] = (out.capabilities[cap] ?? 0) + (insertions ?? 0) + (deletions ?? 0)
  }
  return out
}

// The author time of the first commit that added a file under the change's directory, within
// the range when there is one.
export function proposedAtOf(git, change, range) {
  const text = git('log', '--reverse', '--diff-filter=A', '--format=%aI', range ? `${range.base}..${range.head}` : 'HEAD', '--', `${CHANGES_DIR}/${change}/`)
  return text ? text.split('\n')[0] || null : null
}

// The worktrees still present on the change's branch or one of its group branches, other than
// the checkout the record is built in; paths relative to the main checkout. Null when git cannot
// list them or the branch is unknown.
export function strayWorktreesOf(git, branch) {
  if (!branch) return null
  const text = git('worktree', 'list', '--porcelain')
  const top = git('rev-parse', '--show-toplevel')
  if (text === null || top === null) return null
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const blocks = text
    .split(/\n\n+/)
    .map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1] ?? null, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null }))
    .filter((w) => w.path)
  const main = blocks[0]?.path ?? top
  return blocks
    .filter((w) => w.branch && onChangeBranch(w.branch, branch) && real(w.path) !== real(top))
    .map((w) => ({ path: relative(main, w.path).split(sep).join('/') || '.', branch: w.branch }))
}

// ---------------------------------------------------------------- plugins

function manifestOf(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    return typeof m?.name === 'string' && typeof m.version === 'string' ? m : null
  } catch {
    return null
  }
}

// The core's version and each enabled plugin's, from their manifests. A plugin whose manifest
// cannot be read is left out and named in `warnings`.
export function generatorOf(root, { pluginRoot = PLUGIN_ROOT, home } = {}) {
  const core = manifestOf(pluginRoot)
  if (!core) return { value: null, reason: 'the adf plugin manifest has no version', warnings: [] }
  const plugins = {}
  const warnings = []
  for (const entry of readRegistry(root)?.extensions ?? []) {
    const label = entry.plugin ?? entry.path
    let manifest = null
    try {
      manifest = manifestOf(pluginDir(root, entry, { home }))
    } catch {
      // An entry whose install cannot be found is named below.
    }
    if (manifest) plugins[manifest.name] = manifest.version
    else warnings.push(`generator: no readable plugin manifest for the registry entry ${label}`)
  }
  return { value: { plugin: 'adf', version: core.version, plugins }, reason: null, warnings }
}

function maxTurnsOf(pluginRoot) {
  const dir = join(pluginRoot, 'agents')
  if (!existsSync(dir)) return {}
  return maxTurnsFromAgents(
    readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
  )
}

// ---------------------------------------------------------------- build

function metaBase(dir) {
  try {
    const base = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')).base
    return typeof base === 'string' && base.trim() ? base : null
  } catch {
    return null
  }
}

// Machine paths out of a reason: the root, the transcript directory and the home directory.
const scrubber = (root, projectsDir) => {
  const home = homedir()
  const projects = projectsDir.startsWith(`${home}${sep}`) ? `~${projectsDir.slice(home.length)}` : '<projects>'
  return (text) => String(text).split(root).join('.').split(projectsDir).join(projects).split(home).join('~')
}

function transcriptSessions(tx, facts) {
  return tx.sessions.map((s) => ({ id: s.id, source: s.source, resolved: s.resolved, scope: s.scope ?? null, first: s.first ?? null, last: s.last ?? null, phaseSource: facts?.phases?.[s.id] ?? null }))
}

// Where the ledger and the transcripts disagree on the change's sessions.
function disagreementsOf(tx, ledger) {
  const out = (tx.unresolved ?? []).map((id) => ({ sessionId: id, issue: 'the ledger names this session; no transcript holds it' }))
  if (ledger.some((r) => r?.kind === 'session')) {
    for (const s of tx.sessions) if (s.source === 'branch') out.push({ sessionId: s.id, issue: 'a session on the change branch the ledger does not name' })
  }
  return out
}

// The record of one change. `root` is the change's checkout; `branch` defaults to its current
// branch, `base` to the change's recorded base, else the registry's integration branch.
// Throws RecordError when the assembled record fails its schema.
export function buildRecord({ root, change, branch, base, now = new Date(), projectsDir = defaultProjectsDir(), home, pluginRoot = PLUGIN_ROOT } = {}) {
  root = realpathSync(resolve(root))
  const git = gitOf(root)
  const scrub = scrubber(root, resolve(projectsDir))
  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  const dir = changeDirOf(root, change)
  branch ??= git('branch', '--show-current') || null
  base ??= (dir && metaBase(dir)) ?? readBranches(root)?.integration ?? null
  const coverage = {}
  const warnings = []

  const sdd = readSddRecords(root, change)
  for (const g of SDD_GROUPS) coverage[g] = sdd.coverage[g] === 'record' ? 'record' : none(scrub(sdd.coverage[g].none))

  let ledger = []
  try {
    ledger = readRecords(root, change)
  } catch {
    // A ledger that does not parse is the ledger group's gap, named by its reader.
  }
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const tx = readTranscripts({ repoPath: root, commonDir, branch, ledger, projectsDir })
  const facts = computeFacts(tx.value, { ledger, maxTurns: maxTurnsOf(pluginRoot), rulings: sdd.ledger?.rulings ?? null })
  for (const g of TRANSCRIPT_GROUPS) coverage[g] = facts ? 'record' : none(`transcripts: ${scrub(tx.reason)}`)
  if (facts) warnings.push(...facts.warnings)

  const head = git('rev-parse', 'HEAD')
  const mergeBase = base && head ? git('merge-base', base, 'HEAD') : null
  const range = mergeBase ? { base: mergeBase, head } : null
  const noRange = !head ? 'no commit at HEAD' : !base ? 'no base branch: the change records none and the registry sets no integration branch' : `no merge base of ${base} and HEAD`
  coverage.range = range ? 'record' : none(noRange)
  const maintainability = range ? maintainabilityOf(git, range) : null
  coverage.maintainability = maintainability ? 'record' : none(range ? 'git diff of the range failed' : noRange)

  const generator = generatorOf(root, { pluginRoot, home })
  coverage.generator = generator.value ? 'record' : none(generator.reason)
  warnings.push(...generator.warnings)

  const proposedAt = proposedAtOf(git, change, range)
  const tasksFile = dir ? join(dir, 'tasks.md') : null
  const timing = {
    proposedAt,
    extractedAt: at,
    elapsedMinutes: proposedAt ? minutes(Date.parse(at) - Date.parse(proposedAt)) : null,
    first: facts?.timing.first ?? null,
    last: facts?.timing.last ?? null,
    activeMinutes: facts?.timing.activeMinutes ?? null,
    tasks: tasksFile && existsSync(tasksFile) ? parseTasks(readFileSync(tasksFile, 'utf8')).length : null,
    minutesPerTask: facts?.timing.minutesPerTask ?? null
  }
  coverage.timing = 'record'

  const isolation = {
    filesOutsidePlan: sdd.isolation.filesOutsidePlan,
    foreignBranchRecords: tx.value ? tx.value.sessions.reduce((n, s) => n + (s.foreignRecords ?? 0), 0) : null,
    strayWorktrees: strayWorktreesOf(git, branch)
  }
  coverage.isolation = 'record'

  const verify = sdd.verify && { ...sdd.verify, warnings: sdd.verify.warnings.map((w) => ({ check: w.check, summary: w.summary ?? null })) }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    change,
    branch,
    base,
    range,
    generatedAt: at,
    generator: generator.value,
    sources: {
      transcripts: tx.value ? { runtime: tx.value.runtime, sessions: transcriptSessions(tx.value, facts), unresolved: tx.value.unresolved } : null,
      disagreements: tx.value ? disagreementsOf(tx.value, ledger) : [],
      coverage: Object.fromEntries(GROUPS.map((g) => [g, coverage[g]])),
      warnings
    },
    dispatches: facts?.dispatches ?? null,
    tokens: facts ? { ...facts.tokens, dayBasis: 'response' } : null,
    context: facts?.context ?? null,
    cacheTtl: facts?.cacheTtl ?? null,
    outliers: facts?.outliers ?? null,
    timing,
    autonomy: facts?.autonomy ?? null,
    replies: sdd.replies,
    impl: sdd.impl,
    tests: sdd.tests,
    findings: sdd.findings,
    review: sdd.review,
    verify,
    ledger: sdd.ledger,
    isolation,
    compliance: sdd.compliance,
    maintainability
  }
  const errors = validateRecord(record)
  if (errors.length > 0) throw new RecordError(errors)
  return record
}

// ---------------------------------------------------------------- v1

const v1 = (what) => none(`v1: ${what}`)

function bucketV1(b) {
  return {
    ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, int(b?.[f])])),
    turns: int(b?.turns),
    placeholderTurns: Number.isInteger(b?.outputPlaceholderTurns) ? b.outputPlaceholderTurns : null
  }
}

const bucketsV1 = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([k, b]) => [k, bucketV1(b)]))

// By level from the origin's fact rows: the orchestrator's rows, then each agent type's level.
function byLevelV1(rows) {
  const out = {}
  for (const row of rows ?? []) {
    const level = row.actor === 'orchestrator' ? 'orchestrator' : (levelOf(row.agentType) ?? 'other')
    const b = bucketV1(row)
    const into = (out[level] ??= { ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])), turns: 0, placeholderTurns: 0 })
    for (const f of [...TOKEN_FIELDS, 'turns']) into[f] += b[f]
    into.placeholderTurns = into.placeholderTurns === null || b.placeholderTurns === null ? null : into.placeholderTurns + b.placeholderTurns
  }
  return out
}

function windowOf(session) {
  const [first, last] = typeof session.window === 'string' ? session.window.split('/') : []
  return { first: first || null, last: last || null }
}

// The origin's record (`schemaVersion: 1`) as a schemaVersion 2 record. Its prices, cost,
// velocity, token-economy, notification and normative-bytes figures are not carried: a record
// keeps tokens only, and the port does not measure the rest. Its tokens have no per-day split:
// `byModelDay` puts each model's tokens on the record's own UTC day, the day the origin priced
// them, and `dayBasis: "generatedAt"` says so.
export function fromV1(old) {
  if (old?.schemaVersion !== 1) throw new Error('not a schemaVersion 1 metrics record')
  const coverage = {}
  const warnings = []
  const sessions = Array.isArray(old.sessions) ? old.sessions : []
  const resolved = sessions.filter((s) => s.resolved)
  const hasTx = resolved.length > 0
  const noTx = v1('no session of the record resolved to a transcript')
  const tx = (value, what) => {
    if (!hasTx) return { value: null, cover: noTx }
    return value === null ? { value, cover: v1(what) } : { value, cover: 'record' }
  }

  const transcripts = hasTx
    ? {
        runtime: RUNTIME,
        sessions: resolved.map((s) => ({ id: s.id, source: s.source === 'transcript' ? 'branch' : s.source, resolved: true, scope: s.scope ?? null, ...windowOf(s), phaseSource: null })),
        unresolved: sessions.filter((s) => !s.resolved).map((s) => s.id)
      }
    : null
  coverage.transcripts = hasTx ? 'record' : noTx

  const total = old.cost?.total
  const tokens = tx(
    total
      ? {
          total: bucketV1(total),
          byActor: bucketsV1(old.cost.byActor),
          byPhase: bucketsV1(old.cost.byPhase),
          byModel: bucketsV1(old.cost.byModel),
          byLevel: byLevelV1(old.facts?.rows),
          byModelDay: Object.fromEntries(Object.entries(old.cost.byModel ?? {}).map(([model, b]) => [model, { [dayOf(old.generatedAt)]: Object.fromEntries(TOKEN_FIELDS.map((f) => [f, int(b?.[f])])) }])),
          dayBasis: 'generatedAt'
        }
      : null,
    'no token totals'
  )

  const dispatches = tx(
    Array.isArray(old.facts?.dispatches)
      ? old.facts.dispatches.map((d) => ({
          sessionId: String(d.sessionId ?? ''),
          agentId: String(d.agentId ?? ''),
          parentAgentId: d.parentAgentId ?? null,
          name: d.description ?? null,
          role: d.role ?? null,
          task: Number.isInteger(d.task) ? d.task : null,
          group: parseName(d.description)?.group ?? null,
          round: Number.isInteger(d.round) ? d.round : null,
          exact: d.exact === true,
          actor: d.actor === 'controller' ? 'controller' : 'worker',
          agentType: d.agentType ?? null,
          level: levelOf(d.agentType),
          missing: false,
          reason: null,
          model: d.model ?? null,
          effort: d.effort ?? null,
          phase: d.phase ?? null,
          turns: int(d.turns),
          tokens: bucketV1(d),
          startedAt: null,
          endedAt: null,
          coldResumes: Array.isArray(d.coldResumes) ? d.coldResumes.length : null,
          activeMinutes: null
        }))
      : null,
    'no dispatch facts'
  )

  const ttl = old.cost?.cacheTtl
  const cacheTtl = tx(ttl ? { coldResumes: int(ttl.coldResumes), beyondOneHour: int(ttl.beyondOneHour), rewrittenTokens: int(ttl.rewrittenTokens), write5m: null, byModel: null } : null, 'no cache-lifetime evidence')

  const outliers = tx(
    Array.isArray(old.facts?.outliers)
      ? old.facts.outliers.map((o) => ({ agentId: String(o.agentId ?? ''), name: o.description ?? null, role: o.role ?? null, level: levelOf(o.agentType), turns: int(o.turns), maxTurns: Number.isInteger(o.maxTurns) ? o.maxTurns : null, roleMedian: typeof o.roleMedian === 'number' ? o.roleMedian : null, reasons: o.reasons }))
      : null,
    'no outlier facts'
  )

  const a = old.autonomy
  const autonomy = tx(a ? { developerMessages: int(a.developerMessages), askUserQuestion: int(a.askUserQuestion), clears: int(a.clears), sessions: int(a.sessions), rulings: Number.isInteger(a.rulings) ? a.rulings : null } : null, 'no autonomy counts')

  const t = old.timing
  let timing = null
  if (t) {
    const firsts = resolved.map((s) => windowOf(s).first).filter(Boolean).sort()
    const lasts = resolved.map((s) => windowOf(s).last).filter(Boolean).sort()
    const byPhase = t.byPhase && typeof t.byPhase === 'object' ? t.byPhase : null
    timing = {
      proposedAt: t.proposedAt ?? null,
      extractedAt: t.archivedAt ?? old.generatedAt,
      elapsedMinutes: typeof t.elapsedMinutes === 'number' ? t.elapsedMinutes : null,
      first: firsts[0] ?? null,
      last: lasts.at(-1) ?? null,
      activeMinutes: byPhase ? { total: Number(Object.values(byPhase).reduce((n, m) => n + m, 0).toFixed(1)), byPhase } : null,
      tasks: Number.isInteger(t.tasks) ? t.tasks : null,
      minutesPerTask: Array.isArray(t.minutesPerTask) && t.minutesPerTask.length > 0 ? Object.fromEntries(t.minutesPerTask.map((m) => [String(m.task).replace(/^T/, ''), m.minutes])) : null
    }
  }
  coverage.timing = timing ? 'record' : v1('no timing group')

  let findings = null
  if (old.findings && typeof old.findings === 'object') {
    findings = {}
    for (const [name, entry] of Object.entries(old.findings)) {
      const layer = V1_LAYERS[name] ?? name
      if (!LAYERS.includes(layer)) {
        warnings.push(`v1: findings layer ${name} has no v2 layer; not carried`)
        continue
      }
      findings[layer] = { dispatches: int(entry?.dispatches), findings: int(entry?.findings), native: null, mapped: null }
    }
  }
  coverage.findings = findings ? 'record' : v1('no findings group')

  const ledger = Array.isArray(old.ledger?.records) ? summarizeLedger(old.ledger.records) : null
  coverage.ledger = ledger ? 'record' : v1('no ledger records: the origin counted its markdown progress log')

  const iso = old.isolation
  const isolation = iso
    ? { filesOutsidePlan: Array.isArray(iso.filesOutsidePlan) ? iso.filesOutsidePlan : null, foreignBranchRecords: Number.isInteger(iso.foreignBranchRecords) ? iso.foreignBranchRecords : null, strayWorktrees: Array.isArray(iso.strayWorktrees) && iso.strayWorktrees.length === 0 ? [] : null }
    : null
  coverage.isolation = isolation ? 'record' : v1('no isolation group')

  const scope = /^([0-9a-f]{7,40})\.\.(\S+)$/.exec(old.maintainability?.insertionsVsDeletionsScope ?? '')
  const range = scope ? { base: scope[1], head: /^[0-9a-f]{7,40}$/.test(scope[2]) ? scope[2] : null } : null
  coverage.range = range ? 'record' : v1('no range')
  const iv = old.maintainability?.insertionsVsDeletions
  const maintainability = iv ? { insertions: int(iv.insertions), deletions: int(iv.deletions), perFile: null, capabilities: null } : null
  coverage.maintainability = maintainability ? 'record' : v1('no maintainability group')
  if (maintainability) warnings.push('v1: maintainability keeps the lines added and removed only; the origin read them against a moving HEAD, and its per-file and per-capability churn have no v2 form')

  coverage.generator = v1('the record names no plugin versions')
  coverage.context = hasTx ? v1('no peak context or compactions') : noTx
  for (const [g, what] of Object.entries({ replies: 'no reply counts', impl: 'no impl statuses', tests: 'no test-run records', review: 'no review-stage state', verify: 'no verify run' })) coverage[g] = v1(what)
  coverage.compliance = v1('the wave-1 fan-out was kept as booleans, not as group letters')
  for (const [g, r] of Object.entries({ tokens, dispatches, cacheTtl, outliers, autonomy })) coverage[g] = r.cover

  return {
    schemaVersion: SCHEMA_VERSION,
    change: old.change,
    branch: old.branch ?? null,
    base: null,
    range,
    generatedAt: old.generatedAt,
    generator: null,
    sources: {
      transcripts,
      disagreements: (transcripts?.unresolved ?? sessions.filter((s) => !s.resolved).map((s) => s.id)).map((id) => ({ sessionId: id, issue: 'the ledger names this session; no transcript holds it' })),
      coverage: Object.fromEntries(GROUPS.map((g) => [g, coverage[g]])),
      warnings,
      convertedFrom: 1
    },
    dispatches: dispatches.value,
    tokens: tokens.value,
    context: null,
    cacheTtl: cacheTtl.value,
    outliers: outliers.value,
    timing,
    autonomy: autonomy.value,
    replies: null,
    impl: null,
    tests: null,
    findings,
    review: null,
    verify: null,
    ledger,
    isolation,
    compliance: null,
    maintainability
  }
}

// A record of either version as schemaVersion 2.
export const asV2 = (record) => (record?.schemaVersion === 1 ? fromV1(record) : record)

// Every archived change's record under `openspec/changes/archive/*/metrics.json`, converted and
// checked; one that does not parse or fails its schema is skipped with the reason.
export function archivedRecords(root) {
  const dir = join(root, CHANGES_DIR, ARCHIVE)
  const records = []
  const skipped = []
  if (!existsSync(dir)) return { records, skipped }
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, RECORD_FILE)
    if (!existsSync(file)) continue
    const where = `${CHANGES_DIR}/${ARCHIVE}/${name}/${RECORD_FILE}`
    try {
      const record = asV2(JSON.parse(readFileSync(file, 'utf8')))
      const errors = validateRecord(record)
      if (errors.length > 0) skipped.push({ file: where, reason: errors.join('; ') })
      else records.push(record)
    } catch (error) {
      skipped.push({ file: where, reason: error.message })
    }
  }
  return { records, skipped }
}

export function candidates(root) {
  const { records, skipped } = archivedRecords(root)
  return { records: records.length, skipped, ...removalCandidates(records) }
}

// ---------------------------------------------------------------- cost

const round = (usd) => Number(usd.toFixed(4))

// USD for a record's tokens: each model's tokens of each day at the price entry in force on that
// day. A day or model no entry prices is listed in `unpriced` and left out of `usd`; `usd` is
// null when nothing could be priced. A schemaVersion 1 record is converted first.
export function cost(input, table) {
  const record = asV2(input)
  const days = record?.tokens?.byModelDay
  if (!days) {
    const reason = record?.sources?.coverage?.tokens?.none ?? 'the record holds no tokens'
    return { usd: null, byModel: {}, unpriced: [{ model: null, day: null, reason }], entries: [] }
  }
  let usd = null
  const byModel = {}
  const unpriced = []
  const entries = new Set()
  for (const [model, perDay] of Object.entries(days)) {
    for (const [day, tokens] of Object.entries(perDay)) {
      const price = day === UNDATED ? { rates: null, reason: 'no response time' } : priceAt(table, model, `${day}T00:00:00.000Z`)
      const got = costOf(tokens, price)
      if (got.usd === null) {
        unpriced.push({ model, day, reason: got.reason })
        continue
      }
      entries.add(price.from)
      usd = (usd ?? 0) + got.usd
      byModel[model] = (byModel[model] ?? 0) + got.usd
    }
  }
  return { usd: usd === null ? null : round(usd), byModel: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, round(v)])), unpriced, entries: [...entries].sort() }
}

// ---------------------------------------------------------------- render

const n = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v))
const row = (cells) => `| ${cells.map(n).join(' | ')} |`
const table = (head, rows) => [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n')
const gap = (record, group) => `Not measured: ${record.sources.coverage[group]?.none ?? 'no reason recorded'}.`

function tokenRows(tokens) {
  const rows = [['total', '', ...TOKEN_FIELDS.map((f) => tokens.total[f]), tokens.total.turns]]
  for (const by of ['byActor', 'byPhase', 'byModel', 'byLevel']) {
    for (const [key, b] of Object.entries(tokens[by] ?? {})) rows.push([by.slice(2).toLowerCase(), key, ...TOKEN_FIELDS.map((f) => b[f]), b.turns])
  }
  return rows
}

// The record as Markdown for a person; a group with no source says why.
export function renderRecord(input) {
  const r = asV2(input)
  const out = [`# Metrics: ${r.change}`, '']
  const plugins = Object.entries(r.generator?.plugins ?? {}).map(([p, v]) => `${p} ${v}`)
  out.push(
    `Branch ${n(r.branch)} into ${n(r.base)}${r.range ? `, range ${r.range.base.slice(0, 10)}..${(r.range.head ?? 'HEAD').slice(0, 10)}` : ''}. Generated ${r.generatedAt}${r.generator ? ` by adf ${r.generator.version}${plugins.length ? ` with ${plugins.join(', ')}` : ''}` : ''}${r.sources.convertedFrom ? `, converted from schemaVersion ${r.sources.convertedFrom}` : ''}.`,
    ''
  )
  out.push('## Coverage', '', table(['Group', 'Source'], GROUPS.map((g) => [g, r.sources.coverage[g] === 'record' ? 'record' : `none: ${r.sources.coverage[g].none}`])), '')
  out.push('## Tokens', '', r.tokens ? table(['By', 'Key', ...TOKEN_FIELDS, 'turns'], tokenRows(r.tokens)) : gap(r, 'tokens'), '')
  const t = r.timing
  out.push('## Time', '')
  if (!t) out.push(gap(r, 'timing'))
  else {
    out.push(`- Proposed ${n(t.proposedAt)}, extracted ${t.extractedAt}, ${n(t.elapsedMinutes)} minutes between them.`)
    out.push(`- Active minutes: ${t.activeMinutes ? `${n(t.activeMinutes.total)} (${Object.entries(t.activeMinutes.byPhase).map(([p, m]) => `${p} ${n(m)}`).join(', ') || 'no phase'})` : '-'}.`)
    out.push(`- Tasks: ${n(t.tasks)}${t.minutesPerTask ? `; minutes per task ${Object.entries(t.minutesPerTask).map(([k, m]) => `T${k} ${n(m)}`).join(', ')}` : ''}.`)
  }
  out.push('')
  const a = r.autonomy
  out.push('## Autonomy', '', a ? `Developer messages ${n(a.developerMessages)}, questions asked ${n(a.askUserQuestion)}, /clear ${n(a.clears)}, sessions ${n(a.sessions)}, rulings ${n(a.rulings)}.` : gap(r, 'autonomy'), '')
  out.push('## Dispatches', '')
  if (!r.dispatches) out.push(gap(r, 'dispatches'))
  else {
    const byRole = {}
    for (const d of r.dispatches) {
      const e = (byRole[d.role ?? '(unknown)'] ??= { count: 0, turns: 0, guessed: 0 })
      e.count++
      e.turns += d.turns ?? 0
      if (!d.exact) e.guessed++
    }
    out.push(table(['Role', 'Dispatches', 'Turns', 'Guessed names'], Object.entries(byRole).map(([role, e]) => [role, e.count, e.turns, e.guessed])))
  }
  out.push('')
  if (r.outliers?.length) out.push('## Outliers', '', table(['Dispatch', 'Role', 'Level', 'Turns', 'Ceiling', 'Role median', 'Why'], r.outliers.map((o) => [o.name, o.role, o.level, o.turns, o.maxTurns, o.roleMedian, o.reasons.join(', ')])), '')
  out.push('## Findings per layer', '')
  out.push(r.findings ? table(['Layer', 'Dispatches', 'Findings', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], Object.entries(r.findings).map(([layer, e]) => [layer, e.dispatches, e.findings, e.mapped?.CRITICAL, e.mapped?.HIGH, e.mapped?.MEDIUM, e.mapped?.LOW])) : gap(r, 'findings'), '')
  out.push('## Review', '', r.review ? `Verdict ${n(r.review.verdict)} after ${n(r.review.rounds)} round(s)${r.review.stopped ? ', stopped' : ''}; dispositions ${Object.entries(r.review.dispositions).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.` : gap(r, 'review'), '')
  out.push('## Verify', '')
  if (!r.verify) out.push(gap(r, 'verify'))
  else {
    out.push(`Verdict ${n(r.verify.verdict)}.`, '', table(['Check', 'Verdict'], Object.entries(r.verify.checks)))
    for (const w of r.verify.warnings) out.push(`- warning ${w.check}: ${n(w.summary)}`)
  }
  out.push('')
  out.push('## Tests', '', r.tests ? `${n(r.tests.runs)} run(s), ${n(r.tests.failed)} failed, ${n(r.tests.uncounted)} with no count line${r.tests.unreadable.length ? `; unreadable: ${r.tests.unreadable.join(', ')}` : ''}.` : gap(r, 'tests'), '')
  const l = r.ledger
  out.push('## Ledger', '', l ? `Records ${Object.entries(l.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; unresolved debt ${l.unresolvedDebt.length}, deviations ${l.deviations.length}, handoffs ${l.handoffs}, rulings ${l.rulings}.` : gap(r, 'ledger'), '')
  const i = r.isolation
  out.push('## Isolation', '')
  if (!i) out.push(gap(r, 'isolation'))
  else {
    out.push(`- Records on another branch inside the change's sessions: ${n(i.foreignBranchRecords)}.`)
    out.push(`- Files outside the plan: ${i.filesOutsidePlan === null ? '-' : i.filesOutsidePlan.length === 0 ? 'none' : i.filesOutsidePlan.join(', ')}.`)
    out.push(`- Stray worktrees: ${i.strayWorktrees === null ? '-' : i.strayWorktrees.length === 0 ? 'none' : i.strayWorktrees.map((w) => `${w.path} (${w.branch})`).join(', ')}.`)
  }
  out.push('')
  out.push('## Compliance', '', r.compliance ? r.compliance.map((c) => `- ${c.rule}: required ${c.required.join(', ') || 'none'}, performed ${c.performed.join(', ') || 'none'}.`).join('\n') || 'No rule applied.' : gap(r, 'compliance'), '')
  const m = r.maintainability
  out.push('## Maintainability', '')
  if (!m) out.push(gap(r, 'maintainability'))
  else {
    out.push(`${n(m.insertions)} line(s) added, ${n(m.deletions)} removed${m.perFile ? ` in ${m.perFile.length} file(s)` : ''}.`)
    const caps = Object.entries(m.capabilities ?? {})
    if (caps.length) out.push('', table(['Capability', 'Spec lines changed'], caps))
  }
  out.push('')
  if (r.sources.disagreements.length) out.push('## Disagreements', '', ...r.sources.disagreements.map((d) => `- ${d.sessionId}: ${d.issue}`), '')
  if (r.sources.warnings.length) out.push('## Warnings', '', ...r.sources.warnings.map((w) => `- ${w}`), '')
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
