// lib/metrics.mjs: a record built in a host repository from SDD records written by the real
// writers, synthetic transcripts and git, checked against schema/metrics.schema.json; a record
// with no sources; the origin's schemaVersion 1 record shapes converted; cost by day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDispatch, recordReply } from '../lib/attempts.mjs'
import { readSchema, unknownKeywords } from '../lib/json-schema.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { buildRecord, cost, fromV1, GROUPS, PLUGIN_ROOT, RecordError, renderRecord, SCHEMA_PATH, validateRecord } from '../lib/metrics.mjs'
import { encodeKeys } from '../lib/transcripts.mjs'
import { commitIn, git, host } from './git-host.mjs'

const CHANGE = 'add-x'
const BRANCH = 'feat/add-x'
const NOW = new Date('2026-10-03T12:00:00.000Z')
const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
const usage = (output, extra = {}) => ({ input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 1 }, ...extra })
const assistant = (id, at, output, { branch = BRANCH, model = 'claude-opus-5-5' } = {}) => ({ type: 'assistant', timestamp: at, gitBranch: branch, message: { id, model, role: 'assistant', content: [{ type: 'text' }], usage: usage(output) } })
const user = (at, text, branch = BRANCH) => ({ type: 'user', timestamp: at, gitBranch: branch, message: { role: 'user', content: text } })
const version = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version

// A projects directory holding one session of the change, across two UTC days, with one
// interleaved record on another branch and one dispatched agent.
function transcripts(repoPath) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-metrics-projects-')))
  const key = join(dir, encodeKeys(repoPath)[0])
  mkdirSync(join(key, 's1', 'subagents'), { recursive: true })
  writeFileSync(
    join(key, 's1.jsonl'),
    jsonl([
      user('2026-10-01T23:50:00.000Z', 'go'),
      assistant('m1', '2026-10-01T23:55:00.000Z', 10),
      user('2026-10-01T23:56:00.000Z', 'elsewhere', 'develop'),
      assistant('m2', '2026-10-02T00:05:00.000Z', 20)
    ])
  )
  writeFileSync(join(key, 's1', 'subagents', 'agent-a1.jsonl'), jsonl([assistant('m3', '2026-10-02T00:01:00.000Z', 5, { model: 'claude-sonnet-5-5' })]))
  writeFileSync(join(key, 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'adf:integration', description: 'T1 impl' }))
  return dir
}

function measuredHost() {
  const h = host({ 'tasks.md': '- [x] 1.1 a\n- [x] 1.2 b\n- [ ] 1.3 c\n' })
  commitIn(h.change, `openspec/changes/${CHANGE}/specs/cap-a/spec.md`, '# A\n\nline\n', 'spec')
  commitIn(h.change, 'src/x.txt', 'one\ntwo\n', 'code')
  recordDispatch(h.change, CHANGE, 'T1 impl', { now: '2026-10-02T00:00:30.000Z' })
  recordReply(h.change, CHANGE, { name: 'T1 impl', file: 'replies/T1 impl.json', result: { status: 'DONE' }, now: '2026-10-02T00:02:00.000Z' })
  appendRecord(h.change, CHANGE, 'session', { phase: 'apply' }, { env: { CLAUDE_CODE_SESSION_ID: 's1' }, now: '2026-10-01T23:51:00.000Z' })
  appendRecord(h.change, CHANGE, 'ruling', { finding: 'F1', decision: 'keep' }, { env: {} })
  // A group worktree left behind, and one of another change.
  git(h.root, 'worktree', 'add', '-q', '-b', `${BRANCH}--group-A`, join(h.root, '.claude', 'worktrees', 'add-x--group-A'), BRANCH)
  git(h.root, 'worktree', 'add', '-q', '-b', 'feat/other', join(h.root, '.claude', 'worktrees', 'other'), 'develop')
  return { ...h, projectsDir: transcripts(h.change) }
}

test('the schema uses only the keywords the validator implements', () => {
  assert.deepEqual(unknownKeywords(readSchema(SCHEMA_PATH)), [])
})

test('a record built from SDD records, transcripts and git validates', () => {
  const h = measuredHost()
  const r = buildRecord({ root: h.change, change: CHANGE, now: NOW, projectsDir: h.projectsDir })
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(r))), [])
  assert.equal(r.schemaVersion, 2)
  assert.equal(r.branch, BRANCH)
  assert.equal(r.base, 'develop')
  assert.equal(r.range.base, git(h.root, 'rev-parse', 'develop'))
  assert.equal(r.range.head, git(h.change, 'rev-parse', 'HEAD'))
  assert.deepEqual(r.generator, { plugin: 'adf', version, plugins: {} })

  // Transcripts: the ledger's session, found on the branch too; tokens per model and UTC day.
  assert.deepEqual(r.sources.transcripts.sessions.map((s) => [s.id, s.source, s.phaseSource]), [['s1', 'both', 'ledger']])
  assert.deepEqual(r.sources.disagreements, [])
  assert.equal(r.tokens.total.output, 35)
  assert.equal(r.tokens.dayBasis, 'response')
  assert.deepEqual(Object.keys(r.tokens.byModelDay['claude-opus-5-5']).sort(), ['2026-10-01', '2026-10-02'])
  assert.equal(r.tokens.byModelDay['claude-sonnet-5-5']['2026-10-02'].output, 5)
  assert.deepEqual(r.dispatches.map((d) => [d.name, d.role, d.task, d.level]), [['T1 impl', 'impl', 1, 'integration']])
  assert.equal(r.autonomy.rulings, 1)

  // SDD groups present and absent.
  assert.deepEqual(r.impl, { DONE: 1, DONE_WITH_CONCERNS: 0, BLOCKED: 0, NEEDS_CONTEXT: 0 })
  assert.equal(r.tests, null)
  assert.match(r.sources.coverage.tests.none, /no \.superpowers\/sdd\/add-x\/tests\//)
  assert.equal(r.ledger.rulings, 1)

  // Git: the range's figures, the proposal time, the tasks; isolation.
  assert.equal(r.maintainability.capabilities['cap-a'], 3)
  assert.deepEqual(r.maintainability.perFile.find((f) => f.file === 'src/x.txt'), { file: 'src/x.txt', insertions: 2, deletions: 0 })
  assert.equal(r.timing.proposedAt, git(h.change, 'log', '-1', '--format=%aI', `develop..HEAD`, '--', `openspec/changes/${CHANGE}/tasks.md`))
  assert.equal(r.timing.tasks, 3)
  assert.equal(r.timing.extractedAt, NOW.toISOString())
  assert.equal(r.timing.first, '2026-10-01T23:50:00.000Z')
  assert.equal(r.isolation.foreignBranchRecords, 1)
  assert.deepEqual(r.isolation.strayWorktrees, [{ path: '.claude/worktrees/add-x--group-A', branch: `${BRANCH}--group-A` }], 'the checkout the record is built in is no stray')
  for (const g of GROUPS) assert.ok(r.sources.coverage[g] === 'record' || r.sources.coverage[g].none, g)
})

test('a source absent is null with its coverage reason, never 0, and no machine path', () => {
  const h = host()
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'adf-metrics-none-')))
  const r = buildRecord({ root: h.change, change: CHANGE, now: NOW, projectsDir: empty })
  assert.deepEqual(validateRecord(r), [])
  for (const g of ['dispatches', 'tokens', 'context', 'cacheTtl', 'outliers', 'autonomy', 'replies', 'impl', 'tests', 'findings', 'review', 'verify', 'ledger']) {
    assert.equal(r[g], null, g)
    assert.equal(typeof r.sources.coverage[g].none, 'string', g)
  }
  assert.equal(r.sources.transcripts, null)
  assert.match(r.sources.coverage.tokens.none, /^transcripts: no project key/)
  assert.equal(r.isolation.foreignBranchRecords, null)
  assert.equal(r.timing.activeMinutes, null)
  assert.deepEqual(r.isolation.strayWorktrees, [])
  const text = JSON.stringify(r)
  assert.ok(!text.includes(h.root) && !text.includes(empty), 'the record names no absolute path')
})

test('a record that fails its schema is refused with the errors', () => {
  const h = host()
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'adf-metrics-none-')))
  assert.throws(() => buildRecord({ root: h.change, change: 'Not-Kebab', now: NOW, projectsDir: empty }), (e) => e instanceof RecordError && e.errors.some((x) => x.startsWith('$.change')))
})

// ---------------------------------------------------------------- v1

const bucket = (output) => ({ input: 1, output, thinking: 0, cacheRead: 10, cacheWrite5m: 2, cacheWrite1h: 0, turns: 3, costUsd: 0.1, unpriced: 0, cacheHitRate: 0.5 })
const cost1 = () => ({ total: bucket(30), byActor: { orchestrator: bucket(10), worker: bucket(20) }, byPhase: { other: bucket(30) }, byModel: { 'claude-opus-5': bucket(30) }, unpricedModels: [], orchestratorPerDispatch: 0.5 })
const base1 = (extra) => ({
  schemaVersion: 1,
  change: 'old-change',
  branch: 'feat/old-change',
  generatedAt: '2026-09-30T10:00:00.000Z',
  prices: { source: 'x', fetchedAt: 'y', models: {} },
  sessions: [{ id: 's1', resolved: true, source: 'transcript', scope: 'branch', window: '2026-09-02T10:00:00.000Z/2026-09-02T11:00:00.000Z', phase: null }],
  cost: cost1(),
  facts: {
    rows: [
      { actor: 'orchestrator', agentType: '-', model: 'claude-opus-5', effort: 'medium', phase: 'other', agents: 0, turns: 1, input: 1, output: 10, thinking: 0, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 0 },
      { actor: 'worker', agentType: 'adf-integration', model: 'claude-opus-5', effort: 'medium', phase: 'other', agents: 1, turns: 2, input: 0, output: 20, thinking: 0, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 0 }
    ],
    dispatches: [{ sessionId: 's1', agentId: 'a1', parentAgentId: null, actor: 'worker', agentType: 'adf-integration', model: 'claude-opus-5', effort: 'medium', phase: 'other', description: 'merge-review A', role: 'merge-review', task: null, round: null, exact: true, turns: 2, input: 0, output: 20, thinking: 0, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 0, costUsd: 0.1 }],
    contextSources: []
  },
  tokenEconomy: [],
  subagentNotifications: { dispatches: 1, tokens: 1, toolUses: 1, durationMs: 1, usageBlocks: 1, duplicateBlocks: 0 },
  velocity: { sessionCount: 1 },
  compliance: [],
  maintainability: { insertionsVsDeletions: { insertions: 40, deletions: 4 }, insertionsVsDeletionsScope: 'a30d280d151a044568f251b7e8f9cb63217ec1e1..HEAD', perFileChurn: [{ file: 'a', changes: 44 }], capabilityChurn: { capabilityCount: 1, editsByCapability: { x: 1 } } },
  normativeBytes: [],
  ...extra
})
// The backfilled shape: the markdown ledger counts, no autonomy, timing or isolation.
const backfilled = () => base1({ ledger: { dispatches: { total: 0, byRole: {}, unparsed: 0 }, deviations: { count: 0, entries: [], withoutReason: 0, unparsed: 0 } }, findings: { sweep: { dispatches: 1, findings: 2 }, 'opsx-review': { dispatches: 1, findings: 0 } } })
// The archive-time shape: ledger records, timing by phase, isolation, booleans for the fan-out.
const archived = () =>
  base1({
    sessions: [{ id: 's1', resolved: true, source: 'both', scope: 'branch', window: '2026-10-15T14:00:00.000Z/2026-10-16T06:00:00.000Z', phase: 'propose' }],
    cost: { ...cost1(), total: { ...bucket(30), outputPlaceholderTurns: 2 }, cacheTtl: { coldResumes: 2, beyondOneHour: 0, rewrittenTokens: 100, rewriteCostUsd: 1, oneHourPremiumUsd: 2, netSavingWithOneHourUsd: -1 } },
    facts: { ...base1().facts, outliers: [{ agentId: 'a1', description: 'T11 impl', role: 'impl', agentType: 'adf-integration', turns: 91, maxTurns: 200, roleMedian: 30, reasons: ['above-role-median'] }] },
    ledger: {
      records: [
        { id: 'session-1', kind: 'session', at: '2026-10-15T14:06:22.516Z', sessionId: 's1', phase: 'propose' },
        { id: 'ruling-1', kind: 'ruling', at: '2026-10-15T15:04:02.577Z', finding: 'f', decision: 'd' },
        { id: 'debt-1', kind: 'debt', at: '2026-10-15T15:05:00.000Z', what: 'w', reason: 'r' }
      ],
      unresolvedDebt: [],
      markdownDispatches: { total: 0, byRole: {}, unparsed: 0 },
      markdownDeviations: { count: 0, entries: [], withoutReason: 0, unparsed: 0 }
    },
    compliance: [{ rule: 'wave-1 fan-out', required: false, performed: true }],
    findings: { review: { dispatches: 9, findings: 22 }, 'merge-review': { dispatches: 1, findings: 2 }, 'opsx-review': { dispatches: 1, findings: 1 } },
    autonomy: { developerMessages: 5, askUserQuestion: 5, clears: 0, sessions: 1, rulings: 14 },
    timing: { proposedAt: '2026-10-15T18:50:47+04:00', proposedAtSource: 'git', archivedAt: '2026-10-16T06:48:48.341Z', elapsedMinutes: 958, tasks: 11, minutesPerTask: [{ task: 'T1', minutes: 5.3 }], byPhase: { other: 0.5, apply: 10 } },
    isolation: { foreignBranchRecords: 3, filesOutsidePlan: ['a.sql'], strayWorktrees: [] }
  })
// The shape with no transcript left: unresolved ledger sessions, zero tokens, no autonomy.
const unmeasured = () =>
  base1({
    sessions: [{ id: 's9', resolved: false, source: 'ledger', scope: null, window: null, phase: 'propose' }],
    cost: { ...cost1(), total: bucket(0) },
    facts: { rows: [], dispatches: [], outliers: [], contextSources: [] },
    ledger: { records: [], unresolvedDebt: [], markdownDispatches: { total: 0, byRole: {}, unparsed: 0 }, markdownDeviations: { count: 0, entries: [], withoutReason: 0, unparsed: 0 } },
    compliance: [{ rule: 'wave-1 fan-out', required: true, performed: false, unparsedWorktrees: 0 }],
    findings: { 'opsx-review': { dispatches: 1, findings: 0 } },
    autonomy: null,
    timing: { proposedAt: '2026-10-12T17:36:10+02:00', proposedAtSource: 'git', archivedAt: '2026-10-12T15:47:19.048Z', elapsedMinutes: 11.2, tasks: 17, minutesPerTask: [], byPhase: null },
    isolation: { foreignBranchRecords: null, filesOutsidePlan: null, strayWorktrees: [] }
  })

test('every origin record shape converts to a valid schemaVersion 2 record', () => {
  for (const [name, make] of Object.entries({ backfilled, archived, unmeasured })) {
    const r = fromV1(make())
    assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(r))), [], name)
    assert.equal(r.sources.convertedFrom, 1)
    assert.equal(r.generator, null)
    assert.match(r.sources.coverage.generator.none, /^v1: /)
    assert.equal(r.compliance, null, `${name}: booleans do not map to group letters`)
    assert.ok(r.findings['ai-review'] && !('opsx-review' in r.findings), `${name}: opsx-review is the ai-review layer`)
    assert.ok(!('cost' in r) && !('prices' in r), 'no price or cost is carried')
    renderRecord(r)
  }
})

test('v1 conversion: what maps is carried, what does not is null with a v1 reason', () => {
  const b = fromV1(backfilled())
  assert.equal(b.ledger, null)
  assert.match(b.sources.coverage.ledger.none, /^v1: no ledger records/)
  assert.equal(b.timing, null)
  assert.equal(b.isolation, null)
  assert.equal(b.autonomy, null)
  assert.deepEqual(b.range, { base: 'a30d280d151a044568f251b7e8f9cb63217ec1e1', head: null })
  assert.deepEqual(b.maintainability, { insertions: 40, deletions: 4, perFile: null, capabilities: null })
  assert.deepEqual(b.tokens.byModelDay, { 'claude-opus-5': { '2026-09-30': { input: 1, output: 30, thinking: 0, cacheRead: 10, cacheWrite5m: 2, cacheWrite1h: 0 } } })
  assert.equal(b.tokens.dayBasis, 'generatedAt')
  assert.deepEqual(Object.fromEntries(Object.entries(b.tokens.byLevel).map(([k, v]) => [k, v.output])), { orchestrator: 10, integration: 20 })
  assert.equal(b.tokens.total.placeholderTurns, null, 'the oldest records flagged no placeholders')
  assert.deepEqual(b.dispatches.map((d) => [d.name, d.role, d.group, d.level]), [['merge-review A', 'merge-review', 'A', 'integration']])
  assert.equal(b.sources.transcripts.sessions[0].source, 'branch')

  const a = fromV1(archived())
  assert.deepEqual(a.ledger.counts, { session: 1, ruling: 1, debt: 1 })
  assert.equal(a.ledger.unresolvedDebt.length, 1)
  assert.deepEqual(a.timing.activeMinutes, { total: 10.5, byPhase: { other: 0.5, apply: 10 } })
  assert.deepEqual(a.timing.minutesPerTask, { 1: 5.3 })
  assert.equal(a.timing.first, '2026-10-15T14:00:00.000Z')
  assert.deepEqual(a.cacheTtl, { coldResumes: 2, beyondOneHour: 0, rewrittenTokens: 100, write5m: null, byModel: null })
  assert.equal(a.outliers[0].level, 'integration')
  assert.equal(a.tokens.total.placeholderTurns, 2)

  const u = fromV1(unmeasured())
  for (const g of ['transcripts', 'tokens', 'dispatches', 'outliers', 'autonomy', 'cacheTtl', 'context']) assert.match(u.sources.coverage[g].none, /no session of the record resolved/, g)
  assert.equal(u.tokens, null, 'zero tokens with no transcript are unmeasured, not 0')
  assert.deepEqual(u.sources.disagreements, [{ sessionId: 's9', issue: 'the ledger names this session; no transcript holds it' }])
  assert.equal(u.timing.activeMinutes, null)
  assert.equal(u.timing.minutesPerTask, null)
  assert.throws(() => fromV1({ schemaVersion: 2 }), /not a schemaVersion 1/)
})

// ---------------------------------------------------------------- cost

test('cost prices each day at the entry in force on it', () => {
  const opus = { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 }
  const table = [
    { from: '2026-10-01', source: 'x', models: { 'Claude Opus 5.5': opus } },
    { from: '2026-10-02', source: 'x', models: { 'Claude Opus 5.5': { ...opus, output: 50 } } }
  ]
  const million = { input: 0, output: 1e6, thinking: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  const record = { tokens: { byModelDay: { 'claude-opus-5-5': { '2026-10-01': million, '2026-10-02': million, undated: million }, 'claude-mystery-1': { '2026-10-02': million } } } }
  const got = cost(record, table)
  assert.equal(got.usd, 75)
  assert.deepEqual(got.byModel, { 'claude-opus-5-5': 75 })
  assert.deepEqual(got.entries, ['2026-10-01', '2026-10-02'])
  assert.deepEqual(
    got.unpriced.map((u) => [u.model, u.day]),
    [
      ['claude-opus-5-5', 'undated'],
      ['claude-mystery-1', '2026-10-02']
    ]
  )
  assert.equal(cost(record, []).usd, null, 'no entry at all leaves cost unpriced, never 0')
  assert.equal(cost({ tokens: null, sources: { coverage: { tokens: { none: 'transcripts: gone' } } } }, table).unpriced[0].reason, 'transcripts: gone')
  assert.equal(cost(fromV1(backfilled()), [{ from: '2026-09-01', source: 'x', models: { 'Claude Opus 5': opus } }]).usd, Number(((1 * 5 + 30 * 25 + 10 * 0.5 + 2 * 6.25) / 1e6).toFixed(4)))
})
