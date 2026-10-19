// lib/retro.mjs: the retro agent's input from a sidecar over a real git repository (records and
// attempts logs read from the ref's tree, the signals, the keys, the plugins in force), the
// checks of a reply through the lib/reply.mjs role table, what is computed from an accepted one,
// and the retry rule in the retrospective's own log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setBranches } from '../lib/branches.mjs'
import { DispatchError, retroInputFile } from '../lib/dispatch.mjs'
import { fromV1, PLUGIN_ROOT, validateRecord } from '../lib/metrics.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { checkReply } from '../lib/reply.mjs'
import { input, lateCaught, prematureDone, RE_DERIVATION_REASON, recordRetroDispatch, recordRetroReply } from '../lib/retro.mjs'
import { buildSidecar } from '../lib/window.mjs'

const ARCHIVE = 'openspec/changes/archive'
const DATE = '2026-10-19'
const ID = `${DATE}-window`
const AS_OF = '2026-10-19T12:00:00.000Z'
const CORE_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version

function g(cwd, args, at) {
  const env = at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// A schemaVersion 2 record with the groups the input reads: findings with a review stage, the
// review's dispositions, verify's checks and warnings, the ledger's deviations and rulings.
function record(change, { aiReview = 0, verifyChecks = { 'out-of-plan': 'pass' }, tokens = 100 } = {}) {
  const r = fromV1({
    schemaVersion: 1,
    change,
    branch: `feat/${change}`,
    generatedAt: '2026-10-10T10:00:00.000Z',
    sessions: [{ id: 's1', resolved: true, source: 'transcript', scope: 'branch', window: '2026-10-01T10:00:00.000Z/2026-10-01T11:00:00.000Z' }],
    cost: { total: { input: tokens, output: 0, thinking: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, turns: 1 }, byActor: {}, byPhase: {}, byModel: {} },
    findings: { review: { dispatches: 1, findings: 1 } }
  })
  const { convertedFrom: _c, ...sources } = r.sources
  const out = {
    ...r,
    generator: { plugin: 'adf', version: '0.11.0', plugins: {} },
    findings: { review: { dispatches: 1, findings: 1, native: null, mapped: null }, 'ai-review': { dispatches: 1, findings: aiReview, native: null, mapped: null } },
    review: { verdict: 'APPROVE', rounds: 1, dispositions: { fixed: aiReview, recorded: 1, accepted: 1 }, stopped: false },
    verify: { verdict: 'pass', checks: verifyChecks, warnings: [{ check: 'tests', summary: 'a slow test' }], filesOutsidePlan: null },
    ledger: { counts: { deviation: 1 }, unresolvedDebt: [], deviations: [{ id: 'D1', rule: 'one commit per task', reason: 'a shared fixture' }], handoffs: 0, rulings: 2, sessions: [] },
    sources: { ...sources, coverage: { ...sources.coverage, generator: 'record', findings: 'record', review: 'record', verify: 'record', ledger: 'record' } }
  }
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(out))), [], 'the record fixture validates')
  return out
}

const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
const ev = (name, event, result, at) => ({ name, at, event, ...(result ? { result } : {}) })

// Change `one`: T1's impl reported DONE, its review sent it back, its fix round came clean; T2
// was clean at once. Every task review passed in the end, so the review stage's two findings and
// the failed verify check are late-caught.
const ONE_ATTEMPTS = [
  ev('T1 impl', 'dispatch', null, '2026-10-01T10:00:00Z'),
  ev('T1 impl', 'valid', { status: 'DONE' }, '2026-10-01T10:10:00Z'),
  ev('T1 review', 'valid', { result: 'fix' }, '2026-10-01T10:20:00Z'),
  ev('T1 fix r1', 'valid', { status: 'DONE' }, '2026-10-01T10:30:00Z'),
  ev('T1 re-review r1', 'dispatch', null, '2026-10-01T10:35:00Z'),
  ev('T1 re-review r1', 'valid', { result: 'clean' }, '2026-10-01T10:40:00Z'),
  ev('T2 impl', 'valid', { status: 'DONE' }, '2026-10-01T11:00:00Z'),
  ev('T2 review', 'valid', { result: 'clean' }, '2026-10-01T11:10:00Z')
]

// A host on develop with two archived changes merged: `one` with its record and attempts log,
// `two` with a record and no log. A fake Claude Code home records one installed plugin.
function host() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'adf-retro-')))
  const root = join(tmp, 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  g(root, ['config', 'user.email', 't@example.com'])
  g(root, ['config', 'user.name', 'T'])
  initRegistry(root, '1.4')
  setBranches(root, { integration: 'develop', protected: [] })
  write(root, { 'src/a.txt': 'a\n' })
  g(root, ['add', '.'])
  g(root, ['commit', '-q', '-m', 'init'], '2026-09-01T10:00:00Z')
  const merge = (branch, files, at) => {
    g(root, ['checkout', '-q', '-b', branch, 'develop'])
    write(root, files)
    g(root, ['add', '.'])
    g(root, ['commit', '-q', '-m', 'work'], at)
    g(root, ['checkout', '-q', 'develop'])
    g(root, ['merge', '-q', '--no-ff', '-m', `Merge branch '${branch}' into 'develop'`, branch], at)
  }
  merge(
    'feat/one',
    {
      [`${ARCHIVE}/2026-10-01-one/tasks.md`]: '- [x] 1.1 a\n- [x] 1.2 b\n',
      [`${ARCHIVE}/2026-10-01-one/metrics.json`]: `${JSON.stringify(record('one', { aiReview: 2, verifyChecks: { 'out-of-plan': 'pass', tests: 'fail' }, tokens: 300 }))}\n`,
      [`${ARCHIVE}/2026-10-01-one/attempts.jsonl`]: jsonl(ONE_ATTEMPTS),
      'src/one.txt': 'one\n'
    },
    '2026-10-02T10:00:00Z'
  )
  merge('feat/two', { [`${ARCHIVE}/2026-10-05-two/tasks.md`]: '- [x] 1.1 a\n', [`${ARCHIVE}/2026-10-05-two/metrics.json`]: `${JSON.stringify(record('two'))}\n`, 'src/two.txt': 'two\n' }, '2026-10-06T10:00:00Z')

  const home = join(tmp, 'home')
  const gitlab = join(tmp, 'cache', 'gitlab')
  write(gitlab, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'gitlab', version: '0.3.0' }) })
  write(home, { 'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'gitlab@adf': [{ scope: 'user', installPath: gitlab }] } }) })
  return { root, home }
}

let cached
function fixture() {
  if (cached) return cached
  const { root, home } = host()
  const sidecar = buildSidecar(root, { ref: 'develop', date: DATE, asOf: AS_OF })
  cached = { root, home, sidecar, input: input(sidecar, { root, home }) }
  return cached
}

// A reply that passes every check: one late-caught finding on `one`, every waiting item decided,
// a computed-or-listed removal candidate, and three improvements given in no particular order.
function validReply(inp) {
  return {
    role: 'retro',
    nothingFound: false,
    findings: [
      {
        id: 'R1',
        title: 'The review stage found what the task reviews passed',
        class: 'late-caught',
        changes: ['one'],
        evidence: ['changes.one.signals.lateCaught', 'changes.one.verify.checks.tests'],
        cost: 'changes.one.values.cost.tokens',
        caughtWhere: 'the task review',
        plugin: 'gitlab',
        body: 'Two findings and a failed test check came after every task review was clean.'
      }
    ],
    decisions: inp.waiting.map((w) => ({ item: w.id, decision: 'wait', basis: [`aggregates.${w.metrics[0]}.n`], reason: 'Two changes cannot tell a trend from noise.' })),
    removalCandidate: { name: 'sweep', reason: 'It last prevented nothing in this window.', basis: ['coverage.records'] },
    improvements: [
      { what: 'Small', file: 'a.md', expectedEffect: 'a little', saving: 'coverage.changes' },
      { what: 'Large', file: 'b.md', expectedEffect: 'much', saving: 'changes.one.values.cost.tokens' },
      { what: 'Middle', file: 'c.md', expectedEffect: 'some', saving: 'aggregates.cost.tokens.mean' }
    ]
  }
}

const checked = (reply, inp) => checkReply('retro', JSON.stringify(reply), { input: inp })

// ---------------------------------------------------------------- input

test('the input carries each change, its signals and every citable key with its value', () => {
  const { input: inp } = fixture()
  assert.deepEqual(
    inp.changes.map((c) => c.change),
    ['one', 'two']
  )
  const [one, two] = inp.changes
  assert.deepEqual(one.ledger.deviations.map((d) => d.id), ['D1'])
  assert.equal(one.ledger.rulings, 2)
  assert.deepEqual([one.review.recorded, one.review.accepted], [1, 1])
  assert.deepEqual(one.verify.warnings, [{ check: 'tests', summary: 'a slow test' }])

  assert.equal(one.signals.lateCaught.value, 3, 'two review-stage findings and one failed verify check')
  assert.deepEqual(one.signals.lateCaught.caught, [{ stage: 'review', findings: 2 }, { stage: 'verify', check: 'tests', verdict: 'fail' }])
  assert.equal(one.signals.prematureDone.value, 1)
  assert.deepEqual(one.signals.prematureDone.cases[0], { task: 1, done: 'T1 impl', at: '2026-10-01T10:10:00Z', by: 'T1 review', how: 'failing review' })
  assert.deepEqual(one.signals.reDerivation, { value: null, reason: RE_DERIVATION_REASON })
  assert.match(two.signals.lateCaught.reason, /no attempts\.jsonl/)
  assert.equal(two.signals.prematureDone.value, null)

  assert.equal(inp.values['changes.one.signals.lateCaught'], 3)
  assert.equal(inp.values['changes.one.values.cost.tokens'], 300)
  assert.equal(inp.values['changes.one.verify.checks.tests'], 'fail')
  assert.equal(inp.values['changes.one.ledger.deviations'], 1)
  assert.equal(inp.values['changes.one.review.dispositions.fixed'], 2)
  assert.equal(inp.values['aggregates.cost.tokens.mean'], 200)
  assert.equal(inp.values['coverage.changes'], 2)
  assert.ok(!('changes.two.signals.lateCaught' in inp.values), 'an unmeasured signal has no key')
  assert.deepEqual(inp.keys, Object.keys(inp.values))

  assert.deepEqual(inp.waiting.map((w) => w.id), ['handoff-threshold', 'fix-round-2-level-up', 'lite-path', 'subagent-cache-ttl', 'recite-before-solving'])
  assert.ok(inp.waiting.find((w) => w.id === 'lite-path').keys.includes('aggregates.cost.tokens.mean'))
  assert.deepEqual(inp.removable.rules, inp.waiting.map((w) => w.id))
  assert.deepEqual(inp.removable.checks, ['out-of-plan', 'tests'])
  assert.ok(inp.removable.layers.includes('sweep'))
  assert.deepEqual(inp.plugins, [
    { name: 'adf', version: CORE_VERSION, source: 'core' },
    { name: 'gitlab', version: '0.3.0', source: 'installed', id: 'gitlab@adf' }
  ])
})

test('signals: a task review left open counts nothing late; a DONE impl followed by a re-review round is premature', () => {
  const open = [ev('T1 review', 'valid', { result: 'clean' }), ev('T2 review', 'valid', { result: 'fix' })]
  assert.deepEqual(lateCaught({ findings: { 'ai-review': { findings: 4 } } }, open), { value: 0, taskReviewsPassed: false, notClean: [2], caught: [] })
  assert.match(lateCaught(null, []).reason, /no accepted task review/)
  const round = [ev('T3 impl', 'valid', { status: 'DONE' }), ev('T3 review', 'valid'), ev('T3 re-review r1', 'dispatch')]
  assert.equal(prematureDone(round).cases[0].how, 're-review round')
  const concerns = [ev('T4 impl', 'valid', { status: 'DONE_WITH_CONCERNS' }), ev('T4 review', 'valid', { result: 'fix' })]
  assert.equal(prematureDone(concerns).value, 0, 'only a reply computed DONE claims done')
})

// ---------------------------------------------------------------- check and compute

test('a valid reply is accepted: every key resolved, the plugin version filled, improvements ordered by saving', () => {
  const { input: inp } = fixture()
  const out = checked(validReply(inp), inp)
  assert.deepEqual(out.errors, [])
  assert.equal(out.valid, true)
  const r = out.result
  assert.deepEqual(
    r.improvements.map((m) => [m.what, m.saving.value]),
    [
      ['Large', 300],
      ['Middle', 200],
      ['Small', 2]
    ]
  )
  assert.equal(r.findings[0].version, '0.3.0')
  assert.deepEqual(r.findings[0].evidence, [
    { key: 'changes.one.signals.lateCaught', value: 3 },
    { key: 'changes.one.verify.checks.tests', value: 'fail' }
  ])
  assert.deepEqual(r.findings[0].cost, { key: 'changes.one.values.cost.tokens', value: 300 })
  assert.deepEqual(r.removalCandidate.kind, 'layer')
  assert.deepEqual(r.decisions.map((d) => d.item), inp.waiting.map((w) => w.id))
})

test('nothing found is said plainly, and a none candidate needs only its reason', () => {
  const { input: inp } = fixture()
  const reply = { ...validReply(inp), nothingFound: true, findings: [], improvements: [], removalCandidate: { name: 'none', reason: 'Every layer fired in this window.', basis: [] } }
  const out = checked(reply, inp)
  assert.deepEqual(out.errors, [])
  assert.equal(out.result.removalCandidate.kind, 'none')
})

test('each rule the schema cannot state refuses the reply', () => {
  const { input: inp } = fixture()
  const refused = (mutate, pattern) => {
    const reply = validReply(inp)
    mutate(reply)
    const out = checked(reply, inp)
    assert.equal(out.valid, false, String(pattern))
    assert.ok(out.errors.some((e) => pattern.test(e)), `${pattern}: ${out.errors.join(' | ')}`)
  }
  refused((r) => r.findings[0].evidence.push('aggregates.cost.tokens.p99'), /evidence\[2\]: aggregates\.cost\.tokens\.p99 is not a key/)
  refused((r) => (r.findings[0].cost = 'cost.tokens'), /cost: cost\.tokens is not a key/)
  refused((r) => (r.improvements[0].saving = 'changes.one.verify.checks.tests'), /holds no number to order by/)
  refused((r) => (r.improvements[1].saving = 'tokens saved'), /saving: tokens saved is not a key/)
  refused((r) => r.decisions.pop(), /the waiting item recite-before-solving is not answered/)
  refused((r) => r.decisions.push({ ...r.decisions[0] }), /handoff-threshold is answered twice/)
  refused((r) => r.decisions.push({ ...r.decisions[0], item: 'my-own-rule' }), /my-own-rule is not an item waiting for data/)
  refused((r) => (r.decisions[0].basis = ['the numbers']), /decisions\[0\]\.basis\[0\]/)
  refused((r) => (r.removalCandidate.name = 'the planning guide'), /removalCandidate\.name: the planning guide is no computed candidate/)
  refused((r) => (r.removalCandidate.basis = []), /a named candidate cites at least one key/)
  refused((r) => (r.findings[0].plugin = 'jira'), /plugin: jira is neither enabled nor installed; known: adf, gitlab/)
  refused((r) => (r.nothingFound = true), /nothingFound: true, yet the reply has 1 finding/)
  refused((r) => (r.findings = []), /nothingFound: false, yet the reply has no finding/)
  refused((r) => r.findings.push({ ...r.findings[0] }), /id: R1 is used twice/)
  refused((r) => (r.findings[0].changes = ['three']), /three is not a change of this retrospective/)
  refused((r) => (r.findings[0].class = 'slow'), /class: must be one of/)
  refused((r) => (r.findings[0].id = 'F1'), /does not match/)
  refused((r) => delete r.removalCandidate, /removalCandidate is required/)
  refused((r) => (r.role = 'investigate'), /role/)
})

// ---------------------------------------------------------------- attempts

test('a refused reply is retried once, the second stops the retro, and a stopped retro records nothing', () => {
  const { root, input: inp } = fixture()
  mkdirSync(dirname(retroInputFile(root, ID)), { recursive: true })
  writeFileSync(retroInputFile(root, ID), JSON.stringify(inp))
  assert.equal(recordRetroDispatch(root, ID).next, 'dispatch')
  const bad = join(root, 'bad.json')
  writeFileSync(bad, JSON.stringify({ ...validReply(inp), decisions: [] }))

  const first = recordRetroReply(root, ID, { file: bad })
  assert.deepEqual([first.name, first.valid, first.next, first.mode], [`retro ${ID}`, false, 'retry', 'resume'])
  assert.ok(first.errors.some((e) => /handoff-threshold is not answered/.test(e)))
  assert.equal(recordRetroDispatch(root, ID).next, 'retry')
  const second = recordRetroReply(root, ID, { file: join(root, 'missing.json'), resume: false })
  assert.deepEqual([second.valid, second.next, second.mode], [false, 'stop', null])
  assert.match(second.errors[0], /no reply file/)
  const good = join(root, 'good.json')
  writeFileSync(good, JSON.stringify(validReply(inp)))
  assert.throws(() => recordRetroReply(root, ID, { file: good }), DispatchError)
})

test('a valid reply proceeds and its computed result is recorded in the retro log', () => {
  const { root, input: inp } = fixture()
  const date = '2026-10-20-window'
  mkdirSync(dirname(retroInputFile(root, date)), { recursive: true })
  writeFileSync(retroInputFile(root, date), JSON.stringify(inp))
  const good = join(root, 'good-2.json')
  writeFileSync(good, JSON.stringify(validReply(inp)))
  const out = recordRetroReply(root, date, { file: good })
  assert.deepEqual([out.valid, out.next], [true, 'proceed'])
  assert.equal(out.result.improvements[0].what, 'Large')
  const events = readFileSync(out.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(events.map((e) => e.event), ['valid'])
  assert.equal(events[0].result.findings[0].version, '0.3.0')
})

test('a retro reply with no input file is refused by the context, not checked against nothing', () => {
  const { root, input: inp } = fixture()
  const good = join(root, 'good-3.json')
  writeFileSync(good, JSON.stringify(validReply(inp)))
  assert.throws(() => recordRetroReply(root, '2026-10-21-window', { file: good }), /input\.json does not exist/)
})
