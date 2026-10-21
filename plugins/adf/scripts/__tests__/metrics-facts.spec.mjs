import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COVERAGE_WARNING,
  TOKEN_FIELDS,
  cacheTtlEvidence,
  classify,
  coldResumes,
  computeFacts,
  dayOf,
  levelOf,
  maxTurnsFromAgents,
  outliers,
  phaseAt,
  phaseMarks
} from '../lib/metrics-facts.mjs'

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents')

const resp = (at, f = {}) => ({
  id: `m-${at}`,
  at,
  model: 'claude-opus-5-5',
  effort: 'medium',
  input: 0,
  output: 0,
  thinking: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  outputFinal: true,
  ...f
})
const T = (hhmm) => `2026-10-01T${hhmm}:00.000Z`
const agent = (agentId, description, agentType, list, extra = {}) => ({
  agentId,
  agentType,
  description,
  parentAgentId: null,
  model: null,
  controller: false,
  missing: false,
  reason: null,
  responses: list,
  times: list.map((r) => r.at),
  first: list[0]?.at ?? null,
  last: list.at(-1)?.at ?? null,
  ...extra
})
const session = (id, extra = {}) => ({
  id,
  key: 'k',
  source: 'ledger',
  resolved: true,
  scope: 'branch',
  first: null,
  last: null,
  times: [],
  responses: [],
  sidechain: [],
  commands: [],
  autonomy: { developerMessages: 0, askUserQuestion: 0, clears: 0 },
  compactions: [],
  foreignRecords: 0,
  subagents: [],
  ...extra
})

// ---------------------------------------------------------------- classify

test('classify reads every fixed dispatch form exactly', () => {
  const cases = {
    'T1 impl': { role: 'impl', task: 1 },
    'T3 impl r2': { role: 'impl', task: 3, round: 2 },
    'T2 review': { role: 'review', task: 2 },
    'T2 re-review r1': { role: 're-review', task: 2, round: 1 },
    'T2 fix r1': { role: 'fix', task: 2, round: 1 },
    'final-review': { role: 'final-review' },
    sweep: { role: 'sweep' },
    'merge-review A': { role: 'merge-review', group: 'A' },
    'fix A r1': { role: 'fix', group: 'A', round: 1 },
    're-review A r2': { role: 're-review', group: 'A', round: 2 },
    'fix r1': { role: 'fix', round: 1 },
    're-review r3': { role: 're-review', round: 3 },
    'investigate cache': { role: 'investigate', topic: 'cache' },
    'verify c4': { role: 'verify', check: 'c4' },
    'verify c8': { role: 'verify', check: 'c8' },
    'ai-review r1': { role: 'ai-review', round: 1 },
    'ai-review r2 s3': { role: 'ai-review', round: 2, slice: 3 },
    'ai-fix F3 r1': { role: 'ai-fix', finding: 'F3', round: 1 },
    'spec-merge metrics-format': { role: 'spec-merge', capability: 'metrics-format' },
    ingest: { role: 'ingest' },
    'retro 2026-10-19-window': { role: 'retro', id: '2026-10-19-window' },
    'retro 2026-10-19-my-change': { role: 'retro', id: '2026-10-19-my-change' },
    'scope-check PROJ-12': { role: 'scope-check', key: 'PROJ-12' },
    'scope-check snmp-01': { role: 'scope-check', key: 'snmp-01' }
  }
  for (const [name, want] of Object.entries(cases)) {
    assert.deepEqual(classify(name), { role: null, task: null, group: null, round: null, ...want, exact: true }, name)
  }
})

test('classify reads the Superpowers nouns and a many-word investigation exactly', () => {
  const blank = { task: null, group: null, round: null, exact: true }
  assert.deepEqual(classify('T1 implementer r1'), { ...blank, role: 'impl', task: 1, round: 1 })
  assert.deepEqual(classify('T2 reviewer'), { ...blank, role: 'review', task: 2 })
  assert.deepEqual(classify('T2 re-reviewer r2'), { ...blank, role: 're-review', task: 2, round: 2 })
  assert.deepEqual(classify('T4 fixer r1'), { ...blank, role: 'fix', task: 4, round: 1 })
  assert.deepEqual(classify('investigate cache layout'), { ...blank, role: 'investigate', topic: 'cache layout' })
})

test('classify guesses any other description and marks it', () => {
  assert.deepEqual(classify('Review task 3 for spec compliance'), { role: 'review', task: 3, group: null, round: null, exact: false })
  assert.equal(classify('Explore the parser').exact, false)
  assert.equal(classify('T1 implement it').exact, false)
  assert.deepEqual(classify(null), { role: null, task: null, group: null, round: null, exact: false })
})

// ---------------------------------------------------------------- levels and ceilings

test('levels from the flow agent types; ceilings from the shipped agent definitions', () => {
  assert.equal(levelOf('adf:mechanical'), 'mechanical')
  assert.equal(levelOf('adf-architecture'), 'architecture')
  assert.equal(levelOf('general-purpose'), null)
  const texts = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(agentsDir, f), 'utf8'))
  assert.deepEqual(maxTurnsFromAgents(texts), { architecture: 300, integration: 200, mechanical: 120 })
})

// ---------------------------------------------------------------- phases

test('phases: the ledger first, its first record covering the session from its start', () => {
  const s = session('s1', { commands: [{ at: T('10:00'), name: 'adf:propose' }] })
  const ledger = [
    { kind: 'session', sessionId: 's1', at: T('10:30'), phase: 'apply' },
    { kind: 'session', sessionId: 's1', at: T('10:05'), phase: 'propose' },
    { kind: 'session', sessionId: 'other', at: T('10:00'), phase: 'verify' }
  ]
  const { source, marks } = phaseMarks(s, ledger)
  assert.equal(source, 'ledger')
  assert.equal(phaseAt(marks, T('09:00')), 'propose')
  assert.equal(phaseAt(marks, T('10:31')), 'apply')
})

test('phases: /adf:<x> launches when the ledger marks none; before the first is other', () => {
  const s = session('s2', { commands: [{ at: T('10:00'), name: 'adf:apply' }, { at: T('11:00'), name: 'clear' }, { at: T('12:00'), name: 'adf:verify' }] })
  const { source, marks } = phaseMarks(s, [])
  assert.equal(source, 'commands')
  assert.deepEqual([T('09:00'), T('10:00'), T('11:30'), T('12:01')].map((at) => phaseAt(marks, at)), ['other', 'apply', 'apply', 'verify'])
  assert.deepEqual(phaseMarks(session('s3'), []), { source: 'none', marks: [] })
})

// ---------------------------------------------------------------- cache and outliers

test('a gap over 300 s is a cold resume; over an hour is counted apart', () => {
  const list = [resp(T('10:00')), resp(T('10:04'), { cacheWrite5m: 10 }), resp(T('10:10'), { cacheWrite5m: 500 }), resp(T('11:30'), { cacheWrite5m: 900, model: 'claude-sonnet-5-5' })]
  const gaps = coldResumes(list)
  assert.deepEqual(gaps.map((g) => g.gapSec), [360, 4800])
  const evidence = cacheTtlEvidence([{ responses: list, coldResumes: gaps }])
  assert.deepEqual(evidence, {
    coldResumes: 1,
    beyondOneHour: 1,
    rewrittenTokens: 500,
    write5m: 1410,
    byModel: { 'claude-opus-5-5': { rewrittenTokens: 500, write5m: 510 }, 'claude-sonnet-5-5': { rewrittenTokens: 0, write5m: 900 } }
  })
})

test('outliers: near the level ceiling, or far above the role median', () => {
  const d = (agentId, role, level, turns) => ({ agentId, name: agentId, role, level, turns, missing: false })
  const out = outliers([d('a', 'review', 'mechanical', 60), d('b', 'impl', 'integration', 1), d('c', 'impl', 'integration', 1), d('e', 'impl', 'integration', 25), { agentId: 'm', missing: true }], { mechanical: 120, integration: 200 })
  assert.deepEqual(out.map((o) => [o.agentId, o.reasons, o.maxTurns, o.roleMedian]), [
    ['a', ['near-ceiling'], 120, null],
    ['e', ['above-role-median'], 200, 1]
  ])
})

// ---------------------------------------------------------------- the facts

function transcripts() {
  const s1 = session('s1', {
    first: T('10:00'),
    last: T('10:32'),
    times: [T('10:00'), T('10:01'), T('10:20'), T('10:31'), T('10:32')],
    responses: [
      resp(T('10:01'), { input: 1, cacheRead: 100, cacheWrite1h: 50, output: 120, thinking: 30 }),
      resp(T('10:31'), { output: 7, outputFinal: false })
    ],
    sidechain: [resp(T('10:31'), { output: 9 })],
    autonomy: { developerMessages: 2, askUserQuestion: 1, clears: 0 },
    compactions: [{ at: T('10:20'), trigger: 'auto', preTokens: 1000 }],
    subagents: [
      agent('a1', 'T1 implementer r1', 'adf:integration', [resp(T('10:32'), { model: 'claude-sonnet-5-5', output: 40, cacheWrite5m: 200 }), resp(T('10:40'), { model: 'claude-sonnet-5-5', output: 10, cacheWrite5m: 300 })]),
      agent('a2', 'T1 review', 'adf:mechanical', [], { missing: true, reason: 'no agent-a2.jsonl beside its .meta.json' }),
      agent('a3', 'Explore the parser', 'general-purpose', [resp(T('10:33'), { output: 3 })], { controller: true })
    ]
  })
  const s2 = session('s2', {
    source: 'branch',
    first: T('12:00'),
    last: T('12:02'),
    times: [T('12:00'), T('12:02')],
    commands: [{ at: T('12:00'), name: 'adf:verify' }],
    responses: [resp(T('12:02'), { input: 5, cacheRead: 1000, output: 2 })],
    autonomy: { developerMessages: 1, askUserQuestion: 0, clears: 1 }
  })
  return { runtime: 'claude-code', sessions: [s1, s2], unresolved: [] }
}
const ledger = [
  { kind: 'session', sessionId: 's1', at: T('10:00'), phase: 'propose' },
  { kind: 'session', sessionId: 's1', at: T('10:30'), phase: 'apply' }
]

test('no transcripts gives no facts', () => {
  assert.equal(computeFacts(null), null)
})

test('tokens by actor, phase, model and level, each summing to the total', () => {
  const f = computeFacts(transcripts(), { ledger, maxTurns: { integration: 4 }, rulings: 2 })
  const t = f.tokens
  assert.equal(t.total.output, 120 + 7 + 9 + 40 + 10 + 3 + 2)
  assert.equal(t.total.thinking, 30, 'thinking is part of output, never subtracted')
  assert.equal(t.total.turns, 7)
  assert.equal(t.total.placeholderTurns, 1)
  for (const group of ['byActor', 'byPhase', 'byModel', 'byLevel']) {
    for (const field of [...TOKEN_FIELDS, 'turns']) {
      assert.equal(Object.values(t[group]).reduce((n, b) => n + b[field], 0), t.total[field], `${group}.${field}`)
    }
  }
  assert.deepEqual(Object.keys(t.byActor).sort(), ['controller', 'orchestrator', 'worker'])
  assert.equal(t.byActor.worker.output, 9 + 50, 'a sidechain record is a worker\'s')
  assert.equal(t.byActor.controller.output, 3)
  assert.deepEqual(Object.keys(t.byLevel).sort(), ['integration', 'orchestrator', 'other'])
  assert.equal(t.byLevel.integration.output, 50)
  assert.equal(t.byModel['claude-sonnet-5-5'].cacheWrite5m, 500)
  assert.deepEqual(Object.fromEntries(Object.entries(t.byPhase).map(([k, v]) => [k, v.output])), { propose: 120, apply: 7 + 9 + 40 + 10 + 3, verify: 2 })
  assert.deepEqual(f.phases, { s1: 'ledger', s2: 'commands' })
  assert.deepEqual(f.warnings, [])
})

test('tokens by model and UTC day of the response, summing to the model figures', () => {
  const late = '2026-10-01T23:59:00.000Z'
  const next = '2026-10-02T00:01:00.000Z'
  const s = session('s1', {
    responses: [resp(late, { input: 1, output: 10 }), resp(next, { input: 2, output: 20 }), resp(null, { output: 5 })],
    subagents: [agent('a1', 'T1 impl', 'adf:integration', [resp(next, { model: 'claude-sonnet-5-5', cacheWrite5m: 7 })])]
  })
  const t = computeFacts({ sessions: [s] }).tokens
  assert.deepEqual(Object.keys(t.byModelDay).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.deepEqual(t.byModelDay['claude-opus-5-5']['2026-10-01'], { input: 1, output: 10, thinking: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
  assert.equal(t.byModelDay['claude-opus-5-5']['2026-10-02'].output, 20)
  assert.equal(t.byModelDay['claude-opus-5-5'].undated.output, 5, 'a response with no time is undated, never dropped')
  assert.equal(t.byModelDay['claude-sonnet-5-5']['2026-10-02'].cacheWrite5m, 7)
  for (const [model, days] of Object.entries(t.byModelDay)) {
    for (const f of TOKEN_FIELDS) assert.equal(Object.values(days).reduce((n, d) => n + d[f], 0), t.byModel[model][f], `${model}.${f}`)
  }
  assert.equal(dayOf('2026-10-01T23:59:59.999Z'), '2026-10-01')
  assert.equal(dayOf('nonsense'), 'undated')
})

test('dispatches: classified, levelled, a missing transcript named with null figures', () => {
  const f = computeFacts(transcripts(), { ledger, maxTurns: { integration: 4 } })
  const [a1, a2, a3] = f.dispatches
  assert.equal(a1.name, 'T1 implementer r1')
  assert.deepEqual([a1.role, a1.task, a1.round, a1.exact, a1.level, a1.actor, a1.phase, a1.turns, a1.coldResumes], ['impl', 1, 1, true, 'integration', 'worker', 'apply', 2, 1])
  assert.equal(a1.tokens.output, 50)
  assert.equal(a1.model, 'claude-sonnet-5-5')
  assert.equal(a1.activeMinutes, 5)
  assert.deepEqual([a2.missing, a2.turns, a2.tokens], [true, null, null])
  assert.match(a2.reason, /no agent-a2/)
  assert.deepEqual([a3.exact, a3.actor, a3.level], [false, 'controller', null])
  assert.equal(f.dispatches.some((d) => 'responses' in d), false)
  assert.deepEqual(f.outliers.map((o) => [o.agentId, o.reasons]), [['a1', ['near-ceiling']]])
  assert.deepEqual([f.cacheTtl.coldResumes, f.cacheTtl.rewrittenTokens, f.cacheTtl.write5m], [1, 300, 500])
})

test('autonomy, context and timing with gaps capped at 300 s', () => {
  const f = computeFacts(transcripts(), { ledger, rulings: 2 })
  assert.deepEqual(f.autonomy, { developerMessages: 3, askUserQuestion: 1, clears: 1, sessions: 2, rulings: 2 })
  assert.deepEqual(f.context, { peakBySession: { s1: 151, s2: 1005 }, compactions: 1 })
  // s1: 1 + 5 (19 min capped) + 5 (11 min capped) + 1 = 12; s2: 2.
  assert.deepEqual(f.timing.activeMinutes, { total: 14, byPhase: { propose: 11, apply: 1, verify: 2 } })
  assert.deepEqual(f.timing.minutesPerTask, { 1: 5 })
  assert.equal(f.timing.first, T('10:00'))
  assert.equal(f.timing.last, T('12:02'))
  assert.equal(f.timing.elapsedMinutes, 122)
})

test('active time all in other is a coverage warning', () => {
  const s = session('s', { times: [T('10:00'), T('10:02')], responses: [resp(T('10:01'))] })
  const f = computeFacts({ sessions: [s] }, {})
  assert.deepEqual(f.warnings, [COVERAGE_WARNING])
  assert.equal(f.autonomy.rulings, null)
})
