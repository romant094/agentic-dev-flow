// scope.mjs and lib/scope.mjs: propose's scope, against real git repositories in temp
// directories and a fixture tracker plugin enabled by a path entry. No real tracker and no
// network: the fixture answers from its registry config and records each call it gets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { addEntry, resolveEntry, setTracker } from '../lib/debt.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { createChange, markDone } from '../lib/propose.mjs'
import { initRegistry, readRegistry, setDebtRoot, writeRegistry } from '../lib/registry.mjs'
import { CORE } from '../lib/roles.mjs'
import { loadSchema } from '../lib/schema.mjs'
import { changeScopeFile, matchesPhrase, phraseWords, readScope, renderSection, scopeFile, scopeSourcesGate } from '../lib/scope.mjs'
import { run } from '../scope.mjs'
import { run as workspaceCli } from '../workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The frame's `## Tools` section as sent: from its heading to the next, comment lines dropped.
const FRAME = readFileSync(join(here, '..', '..', 'schema', 'prompts', 'frame.md'), 'utf8')
const FRAME_TOOLS = FRAME.slice(FRAME.indexOf('## Tools'), FRAME.indexOf('\n## ', FRAME.indexOf('## Tools')))
  .split('\n')
  .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
  .join('\n')
  .trim()
const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
const schema = loadSchema()
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const ISSUES = [
  { key: 'PROJ-1', url: 'https://tracker.example/PROJ-1', kind: 'bug', title: 'Session pool leaks on reconnect', status: 'Open', open: true, parent: null, links: [{ key: 'PROJ-2', relation: 'relates to' }], branchToken: 'PROJ-1', branchRank: 2, excluded: null, flags: ['status Review has not moved for 40 days'], body: { description: 'The pool keeps a socket per reconnect.', comments: [{ author: 'qa', body: 'Still there on the thing-store build.' }] } },
  { key: 'PROJ-2', url: 'https://tracker.example/PROJ-2', kind: 'task', title: 'Pool metrics', status: 'Open', open: true, parent: null, links: [], branchToken: 'PROJ-2', branchRank: 3, excluded: null, flags: [], body: { description: 'Count the sockets.', comments: [] } },
  { key: 'PROJ-3', url: 'https://tracker.example/PROJ-3', kind: 'sub-task', title: 'Old pool rewrite', status: 'Suspended', open: true, parent: 'PROJ-2', links: [], branchToken: 'PROJ-3', branchRank: 1, excluded: 'Suspended', flags: [], body: { description: 'Parked.', comments: [] } }
]

// The fixture tracker. config: { check, items, gather, start, handoff } as the answer of each
// operation; held plans by default.
const TRACKER = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
let t = ''
process.stdin.on('data', (d) => (t += d)).on('end', () => {
  const { root, config, input } = JSON.parse(t)
  const op = process.argv[2]
  appendFileSync(join(root, 'tracker-calls.jsonl'), JSON.stringify({ op, input }) + '\\n')
  const out = (o) => console.log(JSON.stringify(o))
  if (config[op] && !(input.apply && config[op + ':apply'])) return out(config[op])
  if (input.apply && config[op + ':apply']) return out(config[op + ':apply'])
  if (op === 'check') return out({ state: 'done', tool: 'ready', account: 'dev' })
  if (op === 'gather') {
    mkdirSync(input.stateDir, { recursive: true })
    const items = config.items ?? []
    for (const i of items) writeFileSync(join(input.stateDir, i.key + '.json'), JSON.stringify(i.body))
    return out({ state: 'done', items: items.map(({ body, ...i }) => ({ ...i, file: i.key + '.json' })), notes: config.notes ?? [] })
  }
  if (!input.apply) return out({ state: 'done', held: true, plan: op + '-plan', preview: input.items.map((i) => i.key + ': ' + op) })
  return out({ state: 'done', applied: input.items.map((i) => i.key), skipped: [], failed: [] })
})
`

function host({ tracker = true, config = {}, debt = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-scope-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  mkdirSync(join(root, 'openspec', 'specs', 'session-pool'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'specs', 'session-pool', 'spec.md'), '# session-pool\n')
  mkdirSync(join(root, 'openspec', 'specs', 'thing-store'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'specs', 'thing-store', 'spec.md'), '# thing-store\n')
  initRegistry(root, CORE.coreContract)
  setBranches(root, { integration: 'develop', protected: ['main'] })
  if (debt) {
    setDebtRoot(root, 'docs/debt')
    const tree = join(root, 'docs', 'debt')
    addEntry(tree, { block: 'snmp', title: 'Session pool leaks connections', anchors: ['pool.ts:10'], class: 'defect', source: 'review' })
    addEntry(tree, { block: 'snmp', title: 'Trailing index parsed twice', anchors: ['oid.ts:4'], class: 'debt', source: 'review' })
    addEntry(tree, { block: 'snmp', title: 'Reconnect storm on the session pool', anchors: ['pool.ts:80'], class: 'debt', source: 'review' })
    writeFileSync(join(tree, 'snmp', 'pool.md'), '# Pool\n\nWhy the pool leaks.\n')
    setTracker(tree, { id: 'snmp-01', key: 'PROJ-1' })
  }
  if (tracker) {
    const dir = join(root, 'plugins', 't')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify({ name: 't', contract: '1.7', provides: { tracker: { script: 't.mjs', operations: ['check', 'gather', 'start', 'handoff'] } } }))
    writeFileSync(join(dir, 't.mjs'), TRACKER)
    writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/t', points: ['tracker'], config: { items: ISSUES, ...config } }] })
  }
  ignoreLocalDirs(root)
  writeFileSync(join(root, '.gitignore'), `${readFileSync(join(root, '.gitignore'), 'utf8')}plugins/\ntracker-calls.jsonl\n`)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

const scope = (root, ...args) => run([...args, '--root', root, ...(['gather', 'check-input', 'start', 'retest'].includes(args[0]) ? ['--home', home] : [])])
const calls = (root) => (existsSync(join(root, 'tracker-calls.jsonl')) ? readFileSync(join(root, 'tracker-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const reply = (root, name, body) => {
  const file = join(root, `${name}.json`)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}
const CHECKED = [{ kind: 'code', ref: 'src/pool.ts:40', finding: 'one socket per reconnect' }]
const valid = (key, over = {}) => ({ role: 'scope-check', key, verdict: 'current', requirements: [{ text: 'close the old socket', status: 'current', sources: [] }], corrections: [], questions: [], checked: CHECKED, ...over })
const BUG = { reproduction: ['reconnect 3 times', 'count sockets'], expected: 'one socket', actual: 'three sockets', sources: ['src/pool.ts:40'] }

// ---------------------------------------------------------------- gather

test('the phrase words are deterministic: four letters at least, no common word, two to match', () => {
  assert.deepEqual(phraseWords('Fix the session pool when it leaks'), ['session', 'pool', 'leaks'])
  assert.equal(matchesPhrase('Session pool leaks connections', phraseWords('session pool')), true)
  assert.equal(matchesPhrase('Session timeout', phraseWords('session pool')), false)
  assert.equal(matchesPhrase('Pool metrics', phraseWords('pool')), true)
})

test('a phrase with no tracker gathers only debt, and the report says the tracker step was skipped', () => {
  const root = host({ tracker: false })
  const out = scope(root, 'gather', '--change', 'fix-pool', '--text', 'session pool reconnect')
  assert.equal(out.tracker.state, 'none')
  assert.deepEqual(out.items.map((i) => [i.key, i.source, i.state]), [['snmp-01', 'debt', 'candidate'], ['snmp-03', 'debt', 'candidate']])
  assert.equal(out.empty, false)
  assert.equal(out.report.split('\n')[0], 'Tracker gather: none; no tracker plugin is enabled; the tracker step was skipped.')
  assert.match(out.report, /Debt: snmp-01 \(phrase\), snmp-03 \(phrase\)\./)
  const saved = readScope(root, 'fix-pool')
  assert.deepEqual(saved.items[0].files, ['docs/debt/snmp/index.md', 'docs/debt/snmp/pool.md'])
})

test('no tracker and no debt match is empty: one report, nothing to select, and nothing copied into the change', () => {
  const root = host({ tracker: false })
  const out = scope(root, 'gather', '--change', 'add-export')
  assert.equal(out.empty, true)
  assert.equal(out.report, 'Tracker gather: none; no tracker plugin is enabled; the tracker step was skipped.\nDebt: no entry matches.')
  const made = createChange(root, { change: 'add-export', branch: 'feat/add-export', base: 'integration' }, schema, { env: {} })
  assert.equal(made.scope, undefined)
  assert.equal(existsSync(changeScopeFile(made.root, 'add-export')), false)
})

test('with neither keys nor a phrase the change name searches the debt store', () => {
  const root = host({ tracker: false })
  assert.deepEqual(scope(root, 'gather', '--change', 'fix-session-pool').items.map((i) => i.key), ['snmp-01', 'snmp-03'])
})

test('gather returns resolved debt as precedents, never as items; check-input gives each item its own, and render lists them', () => {
  const root = host({ tracker: false })
  const tree = join(root, 'docs', 'debt')
  const fixIndex = 'openspec/changes/archive/2026-10-01-fix-index'
  const fixPool = 'openspec/changes/archive/2026-10-02-fix-old-pool'
  addEntry(tree, { block: 'snmp', title: 'Session pool reconnect leaks sockets', anchors: ['pool.ts:5'], class: 'defect', source: 'review' })
  resolveEntry(tree, { id: 'snmp-02', by: fixIndex, date: '2026-10-01' })
  resolveEntry(tree, { id: 'snmp-04', by: fixPool, date: '2026-10-02' })
  addEntry(tree, { block: 'snmp', title: 'Pool reconnect drops the session', anchors: ['pool.ts:90'], class: 'debt', source: 'review', precedent: 'snmp-02' })
  for (const f of ['proposal.md', 'design.md', 'tasks.md']) {
    mkdirSync(join(root, fixPool), { recursive: true })
    writeFileSync(join(root, fixPool, f), `# ${f}\n`)
  }
  const out = scope(root, 'gather', '--change', 'fix-pool', '--text', 'session pool reconnect')
  assert.deepEqual(out.items.map((i) => [i.key, i.state]), [['snmp-01', 'candidate'], ['snmp-03', 'candidate'], ['snmp-05', 'candidate']])
  assert.deepEqual(out.precedents, [
    { key: 'snmp-02', title: 'Trailing index parsed twice', resolvedBy: fixIndex, date: '2026-10-01' },
    { key: 'snmp-04', title: 'Session pool reconnect leaks sockets', resolvedBy: fixPool, date: '2026-10-02' }
  ])
  assert.deepEqual(readScope(root, 'fix-pool').precedents.map((p) => [p.key, p.matched]), [['snmp-02', 'precedent'], ['snmp-04', 'text']])
  assert.match(out.report, /Debt: snmp-01 \(phrase\), snmp-03 \(phrase\), snmp-05 \(phrase\)\.\nPrecedent: snmp-02, Trailing index parsed twice, resolved by `openspec\/changes\/archive\/2026-10-01-fix-index` on 2026-10-01\.\nPrecedent: snmp-04,/)

  scope(root, 'select', '--change', 'fix-pool', '--take', 'snmp-01,snmp-05', '--rest', 'its own change')
  const input = scope(root, 'check-input', '--change', 'fix-pool')
  const of = (key) => JSON.parse(readFileSync(input.dispatches.find((d) => d.key === key).inputFile, 'utf8')).precedents
  assert.deepEqual(of('snmp-01'), [
    { key: 'snmp-04', title: 'Session pool reconnect leaks sockets', class: 'defect', anchors: ['pool.ts:5'], resolvedBy: join(root, fixPool), date: '2026-10-02', files: ['proposal.md', 'design.md', 'tasks.md'].map((f) => join(root, fixPool, f)) }
  ])
  assert.deepEqual(of('snmp-05').map((p) => [p.key, p.files.length]), [['snmp-02', 0], ['snmp-04', 3]], 'its Precedent cell, and the title match')
  assert.match(readFileSync(input.dispatches[0].promptFile, 'utf8'), /read the design and the tasks of each precedent/)

  const section = renderSection(readScope(root, 'fix-pool'))
  assert.match(section, /\| snmp-05 \| debt \| Pool reconnect drops the session \| taken \|.*\n\nPrecedent: snmp-02, Trailing index parsed twice, resolved by `openspec\/changes\/archive\/2026-10-01-fix-index` on 2026-10-01\.\nPrecedent: snmp-04, Session pool reconnect leaks sockets, resolved by `openspec\/changes\/archive\/2026-10-02-fix-old-pool` on 2026-10-02\.$/)
})

test('keys gather the tracker items, the debt holding a key, and a change in flight holding one; a flag is shown once', () => {
  const root = host()
  mkdirSync(join(root, 'openspec', 'changes', 'other-change'), { recursive: true })
  writeFileSync(join(root, 'openspec', 'changes', 'other-change', 'scope.json'), JSON.stringify({ items: [{ key: 'PROJ-2', state: 'taken' }, { key: 'PROJ-9', state: 'taken' }] }))
  const out = scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  assert.deepEqual(calls(root).map((c) => c.op), ['check', 'gather'])
  assert.deepEqual(calls(root)[1].input.keys, ['PROJ-1'])
  assert.equal(calls(root)[1].input.stateDir, join(root, '.superpowers', 'sdd', 'fix-pool', 'tracker'))
  assert.deepEqual(out.tracker, { state: 'done', plugin: 't' })
  assert.deepEqual(out.items.map((i) => [i.key, i.source, i.state]), [['PROJ-1', 'tracker', 'candidate'], ['PROJ-2', 'tracker', 'candidate'], ['PROJ-3', 'tracker', 'excluded'], ['snmp-01', 'debt', 'candidate']])
  assert.equal(out.items[2].reason, 'Suspended')
  assert.deepEqual(out.inFlight, [{ change: 'other-change', checkout: '.', keys: ['PROJ-2'] }])
  assert.deepEqual(out.flags, [{ key: 'PROJ-1', flag: 'status Review has not moved for 40 days' }, { key: 'PROJ-2', flag: 'in flight in change other-change' }])
  assert.match(out.report, /In flight: change other-change already takes PROJ-2\./)
  assert.match(out.report, /Debt: snmp-01 \(tracker key PROJ-1\)\./)
  assert.equal(readScope(root, 'fix-pool').items[0].file, '.superpowers/sdd/fix-pool/tracker/PROJ-1.json')

  scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1')
  const again = scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  assert.deepEqual(again.flags, [], 'a flag already shown is not shown again')
  assert.deepEqual(again.items[0].flags, ['status Review has not moved for 40 days'])
  assert.equal(again.items[0].state, 'taken', 'a gather again keeps the selection')
})

test('keys and a phrase together: the tracker gets both, and the debt is gathered by key and by the phrase', () => {
  const root = host()
  const out = scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1', '--text', 'reconnect storm')
  assert.deepEqual(calls(root)[1].input.keys, ['PROJ-1'])
  assert.equal(calls(root)[1].input.text, 'reconnect storm')
  assert.match(out.report, /Debt: snmp-01 \(tracker key PROJ-1\), snmp-03 \(phrase\)\./)
})

test('a debt id among the keys is matched in the debt, never sent to the tracker', () => {
  const root = host()
  const out = scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1,snmp-02')
  assert.deepEqual(calls(root)[1].input.keys, ['PROJ-1'])
  assert.ok(out.items.some((i) => i.key === 'snmp-02' && i.source === 'debt'))

  const only = host()
  const debtOnly = scope(only, 'gather', '--change', 'fix-pool', '--keys', 'snmp-02')
  assert.deepEqual(calls(only).map((c) => c.op), ['check'])
  assert.deepEqual(debtOnly.items.map((i) => i.key), ['snmp-02'])
  assert.match(debtOnly.report, /Debt: snmp-02 \(debt id\)\./)
})

test('a ready check with notes shows them with the gather report', () => {
  const root = host({ config: { check: { state: 'done', tool: 'ready', account: 'dev', notes: ['config.statuses.initial is unset'] } } })
  const out = scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  assert.match(out.report, /\n {2}note: config\.statuses\.initial is unset/)
  const bare = scope(root, 'gather', '--change', 'fix-pool')
  assert.ok(bare.report.includes('note: config.statuses.initial is unset'))
})

test('a degraded tracker says so with its hint; select waits; --skip-tracker records the skip once and every tracker step skips', () => {
  const root = host({ config: { check: { state: 'degraded', tool: 'unauthenticated', hint: 'create a new token' } } })
  const out = scope(root, 'gather', '--change', 'fix-pool', '--text', 'session pool')
  assert.deepEqual(out.tracker, { state: 'degraded', plugin: 't', hint: 'create a new token', tool: 'unauthenticated' })
  assert.equal(out.empty, false)
  assert.match(out.report, /^Tracker check: not done \(unauthenticated\)\. create a new token Fix it and gather again, or gather again with --skip-tracker "<reason>"\./)
  assert.match(out.next, /--skip-tracker "<reason>"/)
  assert.throws(() => scope(root, 'select', '--change', 'fix-pool', '--take', 'snmp-01'), /the tracker is degraded/)

  const skipped = scope(root, 'gather', '--change', 'fix-pool', '--text', 'session pool', '--skip-tracker', 'token expired; renewing tomorrow')
  assert.deepEqual(skipped.tracker, { state: 'skipped', plugin: null, reason: 'token expired; renewing tomorrow' })
  assert.equal(calls(root).filter((c) => c.op === 'check').length, 1, 'a skipped tracker is not called')
  assert.match(skipped.report, /^Tracker: skipped for this change \(token expired; renewing tomorrow\)\./)
  scope(root, 'select', '--change', 'fix-pool', '--take', 'snmp-01', '--rest', 'another change')
  assert.deepEqual(scope(root, 'start', '--change', 'fix-pool'), { ok: true, change: 'fix-pool', step: 'start', state: 'skipped', report: 'Tracker: skipped for this change (token expired; renewing tomorrow); nothing was sent.' })
  assert.match(renderSection(readScope(root, 'fix-pool')), /^## Scope sources\n\nTracker: skipped for this change \(token expired; renewing tomorrow\)\./)
})

test('a tracker that refuses stops the gather and writes no scope', () => {
  const root = host({ config: { gather: { state: 'refused', error: 'PROJ-1 is outside the allowlist' } } })
  assert.throws(() => scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1'), /Tracker gather: refused; PROJ-1 is outside the allowlist/)
  assert.equal(existsSync(scopeFile(root, 'fix-pool')), false)
})

// ---------------------------------------------------------------- select

test('select records each choice, needs a reason for every non-taken one, refuses an unknown key, and names the branch key', () => {
  const root = host()
  scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  assert.throws(() => scope(root, 'select', '--change', 'fix-pool', '--partial', 'PROJ-2'), /takes "<KEY>: <reason>"/)
  assert.throws(() => scope(root, 'select', '--change', 'fix-pool', '--partial', 'PROJ-2: '), /a partial item needs a reason/)
  assert.throws(() => scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-7'), /PROJ-7 is not an item of the scope/)
  assert.throws(() => scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1', '--exclude', 'PROJ-1: no'), /PROJ-1 is named twice/)
  const first = scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1', '--partial', 'PROJ-2: the metrics only')
  assert.deepEqual(first.undecided, ['snmp-01'])
  assert.deepEqual(first.branch, { key: 'PROJ-1', token: 'PROJ-1' })
  const done = scope(root, 'select', '--change', 'fix-pool', '--rest', 'its own change')
  assert.deepEqual(done.undecided, [])
  assert.deepEqual(done.items.map((i) => [i.key, i.state, i.reason ?? null]), [['PROJ-1', 'taken', null], ['PROJ-2', 'partial', 'the metrics only'], ['PROJ-3', 'excluded', 'Suspended'], ['snmp-01', 'excluded', 'its own change']])
})

test('the branch takes the key of the lowest rank; a tie lists the choices; the worktree path stays per change', () => {
  const tied = ISSUES.map((i) => ({ ...i, branchRank: 2 }))
  const root = host({ config: { items: tied } })
  scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1,PROJ-2', '--rest', 'later')
  const tie = workspaceCli(['suggest', '--change', 'fix-pool', '--root', root])
  assert.deepEqual([tie.branch, tie.keyChoices], ['fix/fix-pool', ['PROJ-1', 'PROJ-2']])
  const chosen = workspaceCli(['suggest', '--change', 'fix-pool', '--key', 'PROJ-2', '--root', root])
  assert.deepEqual([chosen.branch, chosen.key, chosen.path], ['fix/PROJ-2/fix-pool', 'PROJ-2', join(root, '.claude', 'worktrees', 'fix-pool')])
  const single = host()
  scope(single, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  scope(single, 'select', '--change', 'fix-pool', '--take', 'PROJ-1,PROJ-2', '--rest', 'later')
  assert.equal(workspaceCli(['suggest', '--change', 'fix-pool', '--root', single]).branch, 'fix/PROJ-1/fix-pool')
  assert.throws(() => workspaceCli(['suggest', '--change', 'fix-pool', '--key', 'a/b', '--root', single]), /cannot name a branch/)
  assert.equal(workspaceCli(['suggest', '--change', 'fix-other', '--root', single]).branch, 'fix/fix-other', 'no scope: the branch as before')
})

// ---------------------------------------------------------------- check-input and check

function selected({ config } = {}) {
  const root = host({ config })
  scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1,snmp-01', '--partial', 'PROJ-2: the metrics only')
  return root
}

test('check-input writes one input and one prompt per taken or partial item, with the comments, the links, the debt and the base', () => {
  const root = host()
  scope(root, 'gather', '--change', 'fix-pool', '--keys', 'PROJ-1')
  scope(root, 'select', '--change', 'fix-pool', '--take', 'PROJ-1')
  assert.throws(() => scope(root, 'check-input', '--change', 'fix-pool'), /decide PROJ-2, snmp-01 first/)
  scope(root, 'select', '--change', 'fix-pool', '--partial', 'PROJ-2: metrics only', '--take', 'snmp-01')
  const out = scope(root, 'check-input', '--change', 'fix-pool')
  assert.deepEqual(out.dispatches.map((d) => [d.name, d.agent, d.worktree]), [['scope-check PROJ-1', 'adf:integration', root], ['scope-check PROJ-2', 'adf:integration', root], ['scope-check snmp-01', 'adf:integration', root]])
  assert.equal(out.base.ref, 'develop')
  assert.equal(out.base.commit, git(root, 'rev-parse', 'HEAD'))
  const input = JSON.parse(readFileSync(out.dispatches[0].inputFile, 'utf8'))
  assert.equal(input.issueFile, join(root, '.superpowers', 'sdd', 'fix-pool', 'tracker', 'PROJ-1.json'))
  assert.match(readFileSync(input.issueFile, 'utf8'), /Still there on the thing-store build/, 'the comments are in the issue file')
  assert.deepEqual(input.related.map((r) => r.key), ['PROJ-2'])
  assert.deepEqual(input.debt.map((d) => [d.key, d.files]), [['snmp-01', [join(root, 'docs/debt/snmp/index.md'), join(root, 'docs/debt/snmp/pool.md')]]])
  assert.deepEqual(input.specs.matched, ['session-pool', 'thing-store'])
  assert.equal(input.knowledgeIndex, null)
  assert.match(input.knowledge, /^Knowledge: none/)
  assert.equal(input.bug, true)
  const prompt = readFileSync(out.dispatches[0].promptFile, 'utf8')
  assert.doesNotMatch(prompt, /\{\{|<!--/)
  assert.match(prompt, /You are dispatched as `scope-check PROJ-1`, at the integration capability level/)
  assert.ok(prompt.includes(FRAME_TOOLS), 'the frame\'s Tools rule, verbatim')
  assert.ok(prompt.includes(out.dispatches[0].replyFile) && prompt.includes('scope-check.schema.json'))
  const debtInput = JSON.parse(readFileSync(out.dispatches[2].inputFile, 'utf8'))
  assert.deepEqual([debtInput.issueFile, debtInput.related.map((r) => r.key), debtInput.debt.map((d) => d.key), debtInput.bug], [null, ['PROJ-1'], ['snmp-01'], false])
  assert.throws(() => scope(root, 'check-input', '--change', 'fix-pool', '--key', 'PROJ-3'), /PROJ-3 is not taken or partial/)
})

test('the reply schema uses only the keywords the validator implements', async () => {
  const { readSchema, unknownKeywords } = await import('../lib/json-schema.mjs')
  assert.deepEqual(unknownKeywords(readSchema(join(here, '..', '..', 'schema', 'scope-check.schema.json'))), [])
})

test('check refuses every rule the schema cannot state, and records a valid reply', () => {
  const root = selected()
  scope(root, 'check-input', '--change', 'fix-pool')
  const refused = (key, body) => {
    const out = scope(root, 'check', '--change', 'fix-pool', '--key', key, '--file', reply(root, `r-${Math.random()}`, body))
    assert.equal(out.ok, false)
    assert.equal(out.valid, false)
    assert.match(out.next, /^retry/)
    return out.errors
  }
  assert.match(refused('PROJ-2', 'not json').join('\n'), /^not JSON: /)
  assert.ok(refused('PROJ-2', { ...valid('PROJ-2'), checked: [] }).some((e) => /checked: must hold at least 1 item/.test(e)))
  assert.deepEqual(refused('PROJ-2', valid('PROJ-9')), ['key is PROJ-9, but this dispatch checks PROJ-2'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { verdict: 'corrected' })), ['a corrected verdict lists no correction'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { verdict: 'corrected', corrections: [{ what: 'unit', was: 'count', now: 'gauge', sources: [] }] })), ['corrections[0] names no source'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { requirements: [{ text: 'count', status: 'done', sources: [] }] })), ['requirements[0] is done and names no source'])
  const question = { question: 'Which unit?', about: 'requirement', checked: [], needs: '' }
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { verdict: 'needs-developer', questions: [question] })), ['questions[0] does not say what was checked', 'questions[0] does not say what it needs'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { verdict: 'needs-developer' })), ['a needs-developer verdict asks no question'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { questions: [{ ...question, checked: ['spec:session-pool'], needs: 'the unit' }] })), ['a question leaves the verdict needs-developer, not current'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1')), ['a bug with no reproduction asks no question about it', 'a bug with no expected behaviour asks no question about it'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', { bug: { ...BUG, expected: '' } })), ['a bug with no expected behaviour asks no question about it'])
  assert.deepEqual(refused('PROJ-2', valid('PROJ-2', { verdict: 'not-reproduced' })), ['not-reproduced is a bug\'s verdict; PROJ-2 is a task'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', { verdict: 'not-reproduced', bug: BUG })), ['a not-reproduced verdict lists nothing tried (bug.tried)'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', { verdict: 'not-reproduced', bug: { ...BUG, tried: ['see https://ci.example/run/4'] } })), ['bug.tried holds a link or URL ("https://ci.example/run/4"); write plain text: the provider adds the merge request link itself'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', { verdict: 'not-reproduced', bug: { ...BUG, tried: [Array.from({ length: 81 }, () => 'step').join(' ')] } })), ['bug.tried has 81 words; the limit is 80'])
  assert.deepEqual(refused('PROJ-1', valid('PROJ-1', { verdict: 'not-reproduced', bug: { ...BUG, reproduction: [] }, questions: [] })), [
    'a bug with no reproduction asks no question about it',
    'a not-reproduced verdict names no reproduction it tried',
    'a not-reproduced verdict lists nothing tried (bug.tried)'
  ])
  const missing = scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-2', '--file', join(root, 'none.json'))
  assert.deepEqual(missing.errors, [`no reply file at ${join(root, 'none.json')}`])
  assert.throws(() => scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-3', '--file', join(root, 'none.json')), /PROJ-3 is excluded/)

  const asked = { question: 'Must the old socket close before the new one opens?', about: 'reproduction', checked: ['src/pool.ts:40', 'PROJ-1 comments'], needs: 'the order the server expects' }
  const ok = scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-1', '--file', reply(root, 'ok-1', valid('PROJ-1', { verdict: 'needs-developer', bug: { ...BUG, reproduction: [] }, questions: [asked] })))
  assert.deepEqual([ok.ok, ok.valid, ok.verdict, ok.questions.map((q) => q.n)], [true, true, 'needs-developer', [1]])
  assert.match(ok.next, /in one message/)
  const fenced = scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-2', '--file', reply(root, 'ok-2', `\`\`\`json\n${JSON.stringify(valid('PROJ-2', { verdict: 'corrected', corrections: [{ what: 'unit', was: 'count', now: 'gauge', sources: ['spec:session-pool/Metrics'] }] }))}\n\`\`\``))
  assert.equal(fenced.verdict, 'corrected')
  const saved = readScope(root, 'fix-pool').items.find((i) => i.key === 'PROJ-2')
  assert.deepEqual([saved.verdict, saved.check.fenced, saved.check.reply], ['corrected', true, 'ok-2.json'])
})

test('answer records each answer, then the verdict; an obsolete item leaves the scope with its reason', () => {
  const root = selected()
  scope(root, 'check-input', '--change', 'fix-pool')
  const q = (n) => ({ question: `Question ${n}?`, about: 'requirement', checked: ['src/pool.ts:1'], needs: 'a decision' })
  scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-2', '--file', reply(root, 'q', valid('PROJ-2', { verdict: 'needs-developer', questions: [q(1), q(2)] })))
  assert.throws(() => scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--verdict', 'current'), /question\(s\) 1, 2 of PROJ-2 are not answered yet/)
  assert.throws(() => scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--question', '3', '--answer', 'x'), /has no question 3/)
  assert.deepEqual(scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--question', '1', '--answer', 'yes').open, [2])
  const last = scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--question', '2', '--answer', 'the gauge')
  assert.match(last.next, /give the verdict/)
  assert.throws(() => scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--verdict', 'obsolete'), /leaves the scope with a reason/)
  const out = scope(root, 'answer', '--change', 'fix-pool', '--key', 'PROJ-2', '--verdict', 'obsolete', '--reason', 'done by the metrics change')
  assert.deepEqual([out.verdict, out.state], ['obsolete', 'excluded'])
  const item = readScope(root, 'fix-pool').items.find((i) => i.key === 'PROJ-2')
  assert.deepEqual([item.reason, item.check.questions.map((x) => x.answer)], ['done by the metrics change', ['yes', 'the gauge']])
})

// ---------------------------------------------------------------- retest

test('a bug that does not reproduce is held for a retest, then sent with what was tried and the commit, and leaves the scope', () => {
  const root = selected()
  const { base } = scope(root, 'check-input', '--change', 'fix-pool')
  const tried = ['reconnect 3 times on the base commit', 'reconnect under load']
  scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-1', '--file', reply(root, 'nr', valid('PROJ-1', { verdict: 'not-reproduced', bug: { ...BUG, tried } })))
  assert.throws(() => scope(root, 'retest', '--change', 'fix-pool', '--yes'), /no held retest plan to apply/)
  const pending = scope(root, 'retest', '--change', 'fix-pool')
  assert.deepEqual([pending.ok, pending.state, pending.held, pending.plan, pending.preview], [true, 'pending', true, 'handoff-plan', ['PROJ-1: handoff']])
  assert.equal(pending.waiting, "the developer's yes: scope.mjs retest --change fix-pool --yes")
  assert.equal(pending.report, "Tracker handoff: held for the developer's yes; plan handoff-plan\n  PROJ-1: handoff")
  const sent = calls(root).at(-1)
  assert.deepEqual([sent.op, sent.input.items, sent.input.mr, sent.input.apply], ['handoff', [{ key: 'PROJ-1', state: 'not-reproduced', fields: { tried, commit: base.commit } }], null, undefined])
  assert.equal(readScope(root, 'fix-pool').items[0].state, 'taken', 'held: nothing changes yet')
  const applied = scope(root, 'retest', '--change', 'fix-pool', '--yes')
  assert.deepEqual([applied.ok, applied.state, applied.applied], [true, 'done', ['PROJ-1']])
  assert.equal(calls(root).at(-1).input.apply, 'handoff-plan')
  const item = readScope(root, 'fix-pool').items[0]
  assert.deepEqual([item.state, item.reason, item.verdict], ['excluded', 'does not reproduce; sent to retest', 'not-reproduced'])
  assert.equal(scope(root, 'retest', '--change', 'fix-pool').report, 'Retest: no item is not-reproduced.')
})

// ---------------------------------------------------------------- propose: create, start, render, gate

test('propose: create copies the scope, start holds then applies after the worktree exists, and the proposal gate reads the rendering', async () => {
  const root = selected()
  scope(root, 'check-input', '--change', 'fix-pool')
  scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-1', '--file', reply(root, 'a', valid('PROJ-1', { bug: BUG })))
  assert.throws(() => scope(root, 'start', '--change', 'fix-pool'), /settle every taken or partial issue before start: PROJ-2 \(not checked\)/)
  scope(root, 'check', '--change', 'fix-pool', '--key', 'PROJ-2', '--file', reply(root, 'b', valid('PROJ-2', { verdict: 'corrected', corrections: [{ what: 'unit', was: 'count', now: 'gauge', sources: ['spec:session-pool/Metrics'] }] })))
  scope(root, 'check', '--change', 'fix-pool', '--key', 'snmp-01', '--file', reply(root, 'c', valid('snmp-01')))
  assert.throws(() => scope(root, 'start', '--change', 'fix-pool'), /start runs after the branch and the worktree exist/)

  const made = createChange(root, { change: 'fix-pool', branch: 'fix/PROJ-1/fix-pool', base: 'integration' }, schema, { env: {} })
  assert.equal(made.scope, 'openspec/changes/fix-pool/scope.json')
  assert.deepEqual(JSON.parse(readFileSync(changeScopeFile(made.root, 'fix-pool'), 'utf8')), readScope(root, 'fix-pool'))

  const pending = scope(root, 'start', '--change', 'fix-pool')
  assert.deepEqual([pending.state, pending.plan, pending.preview], ['pending', 'start-plan', ['PROJ-1: start', 'PROJ-2: start']])
  assert.deepEqual(calls(root).at(-1).input.items, [
    { key: 'PROJ-1', state: 'taken', verdict: 'current', corrections: [], answers: [] },
    { key: 'PROJ-2', state: 'partial', verdict: 'corrected', corrections: [{ what: 'unit', was: 'count', now: 'gauge' }], answers: [] }
  ])
  const started = scope(root, 'start', '--change', 'fix-pool', '--yes')
  assert.deepEqual([started.ok, started.state, started.applied, started.report], [true, 'done', ['PROJ-1', 'PROJ-2'], 'Tracker start: applied PROJ-1, PROJ-2; skipped none; failed none'])
  assert.equal(JSON.parse(readFileSync(changeScopeFile(made.root, 'fix-pool'), 'utf8')).start.state, 'done', 'the change copy follows the state')

  const dir = join(made.root, 'openspec', 'changes', 'fix-pool')
  writeFileSync(join(dir, 'brainstorm.md'), '# Brainstorm\n\nThe pool closes the old socket first.\n')
  writeFileSync(join(dir, 'proposal.md'), '## Why\n\nThe pool leaks.\n\n## What Changes\n\n- Close the socket.\n')
  assert.match(scopeSourcesGate(made.root, 'fix-pool').error, /section is missing; run scope\.mjs render/)
  const refusedDone = await markDone(made.root, 'fix-pool', 'proposal', schema)
  assert.deepEqual(refusedDone.gates.map((g) => [g.gate, g.ok]), [['scope-sources', false]])
  const rendered = scope(made.root, 'render', '--change', 'fix-pool')
  assert.equal(rendered.written, true)
  const proposal = readFileSync(join(dir, 'proposal.md'), 'utf8')
  assert.ok(proposal.includes('| PROJ-2 | tracker | Pool metrics | partial | the metrics only | corrected | corrected: unit (was count), now gauge |'), proposal)
  assert.ok(proposal.includes('| PROJ-3 | tracker | Old pool rewrite | excluded | Suspended |  |  |'))
  assert.equal((await markDone(made.root, 'fix-pool', 'proposal', schema)).ok, true)
  assert.equal(scope(made.root, 'render', '--change', 'fix-pool').written, true)
  assert.equal(readFileSync(join(dir, 'proposal.md'), 'utf8'), proposal, 'a render again changes nothing')
  writeFileSync(join(dir, 'proposal.md'), proposal.replace('| partial |', '| taken |'))
  assert.match(scopeSourcesGate(made.root, 'fix-pool').error, /is not the rendering of scope\.json/)
})

test('start without a tracker plugin skips with the line, and a change without scope.json passes the gate', () => {
  const root = host({ tracker: false })
  scope(root, 'gather', '--change', 'fix-pool', '--text', 'session pool')
  scope(root, 'select', '--change', 'fix-pool', '--take', 'snmp-01,snmp-03')
  assert.equal(scope(root, 'start', '--change', 'fix-pool').report, 'Tracker: none; no tracker plugin is enabled; the tracker step was skipped.')
  assert.deepEqual(scopeSourcesGate(root, 'fix-pool'), { ok: true })
})

// ---------------------------------------------------------------- the CLI

test('the CLI prints one JSON result: exit 1 on a refusal, exit 2 on a usage error', () => {
  const root = host({ tracker: false })
  const cli = (...args) => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [join(here, '..', 'scope.mjs'), ...args, '--root', root], { encoding: 'utf8' })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }
  assert.equal(cli('select', '--change', 'fix-pool', '--take', 'x').code, 1)
  assert.match(cli('select', '--change', 'fix-pool', '--take', 'x').out.error, /no scope yet; run scope\.mjs gather/)
  assert.equal(cli('frobnicate', '--change', 'fix-pool').code, 2)
  assert.equal(cli('gather', '--change', 'fix-pool', '--yes').code, 2)
  assert.equal(cli('gather', '--text', 'x').code, 2)
  const ok = cli('gather', '--change', 'fix-pool', '--text', 'session pool', '--home', home)
  assert.deepEqual([ok.code, ok.out.ok, ok.out.items.length], [0, true, 2])
})
