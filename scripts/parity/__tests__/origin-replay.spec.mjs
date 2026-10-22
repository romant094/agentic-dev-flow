// origin-replay.mjs: the classification is read from the rules data (a strong difference no rule
// explains is a defect, a weak one is recorded only, an `explained` rule must cite a lessons row
// that exists), the parsers read the origin's records, and the whole tool runs on the fixture
// origin of replay-fixture.mjs: the fresh and the mid-flight replay compared with the origin, the
// origin unchanged, and a run without an author or a candidate skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { byPhase, citeLessons, classify, compareLedgers, headings, loadRules, main, originVerify, planGraph, reviewRecord, RULES_FILE } from '../origin-replay.mjs'
import { createSandbox } from '../lib/sandbox.mjs'
import { findCandidates } from '../lib/replay-candidates.mjs'
import { buildReplies } from '../lib/replay-replies.mjs'
import { ORDER, PLUGINS } from '../lib/replay-host.mjs'
import { drive, driveMidFlight, writeRunRecord } from '../lib/replay-drive.mjs'
import { CHANGE, DEV, fixtureOrigin } from './replay-fixture.mjs'

const RULES = loadRules()

// A lessons tree with one table, for citations.
function lessonsRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-replay-lessons-')))
  mkdirSync(join(root, 'docs', 'lessons'), { recursive: true })
  writeFileSync(join(root, 'docs', 'lessons', 'x.md'), [
    '# X', '', '| Rule | Why it exists (the incident or the measurement) | Decision | Where it lives now | Evidence |', '|---|---|---|---|---|',
    '| The thing is done twice. | Once was not enough. | changed — the port does it twice, by script. | `a.mjs` | — |', ''
  ].join('\n'))
  return root
}

const rules = (list) => ({ ...RULES, rules: list })

test('classify: the first matching rule wins; an unmatched strong difference is a defect, a weak one recorded only', () => {
  const r = rules([
    { id: 'one', match: { key: '^ledger-invented:', hint: 'injected', notHint: 'blocked' }, class: 'injected', why: 'synthesized' },
    { id: 'two', match: { key: '^ledger-invented:' }, class: 'older-origin', why: 'older' }
  ])
  assert.equal(classify({ key: 'ledger-invented:ruling', hints: ['injected'] }, { mode: 'fresh', steps: [] }, r).rule, 'one')
  assert.equal(classify({ key: 'ledger-invented:ruling', hints: ['injected', 'blocked'] }, { mode: 'fresh', steps: [] }, r).rule, 'two')
  const strong = classify({ key: 'ledger-lost:debt', what: 'x' }, { steps: [] }, r)
  assert.deepEqual([strong.strong, strong.class], [true, 'defect'])
  const weak = classify({ key: 'commits:apply:tick', what: 'x' }, { steps: [] }, r)
  assert.deepEqual([weak.strong, weak.class], [false, null])
})

test('classify: mode, flag, what, evidence and a named injected step narrow a rule', () => {
  const record = { mode: 'mid-flight', steps: [{ n: 4, step: 'agent: ingest', classification: [{ kind: 'injected', why: 'no reply' }] }] }
  const r = rules([
    { id: 'mode', match: { key: '^mr:state$', mode: 'fresh' }, class: 'injected' },
    { id: 'flag', match: { flag: 'base-drift' }, class: 'injected' },
    { id: 'step', match: { area: 'tree', stepNamed: '^agent: ingest$' }, class: 'injected' },
    { id: 'what', match: { key: '^driver:', what: 'suggest', evidence: 'step 5' }, class: 'older-origin' }
  ])
  assert.equal(classify({ key: 'mr:state' }, record, r).class, 'defect')
  assert.equal(classify({ key: 'tree-only-port:a', flags: ['base-drift'] }, record, r).rule, 'flag')
  assert.equal(classify({ area: 'tree', key: 'tree-content:b' }, record, r).rule, 'step')
  assert.equal(classify({ area: 'tree', key: 'tree-content:b' }, { ...record, steps: [] }, r).rule, null)
  assert.equal(classify({ key: 'driver:propose', what: 'suggest proposes', evidence: { detail: 'step 5' } }, record, r).rule, 'what')
})

test('classify: an explained difference carries the lessons row it cites; a citation to no row is a defect', () => {
  const root = lessonsRoot()
  const good = rules([{ id: 'x', match: { key: '^spec-format:' }, class: 'explained', cite: { file: 'docs/lessons/x.md', phrase: 'the port does it  twice' } }])
  const out = classify({ key: 'spec-format:cap' }, { steps: [] }, good, root)
  assert.deepEqual([out.class, out.cite], ['explained', { file: 'docs/lessons/x.md', line: 5, decision: 'changed' }])
  const bad = rules([{ id: 'y', match: { key: '^spec-format:' }, class: 'explained', cite: { file: 'docs/lessons/x.md', phrase: 'Once was not enough' } }])
  assert.equal(classify({ key: 'spec-format:cap' }, { steps: [] }, bad, root).class, 'explained', 'a phrase of the Why cell is still the row')
  const none = rules([{ id: 'z', match: { key: '^spec-format:' }, class: 'explained', cite: { file: 'docs/lessons/x.md', phrase: 'no such words' } }])
  assert.equal(classify({ key: 'spec-format:cap' }, { steps: [] }, none, root).class, 'defect')
  assert.equal(citeLessons({ file: 'README.md', phrase: 'x' }, root), null, 'only docs/lessons files are cited')
  rmSync(root, { recursive: true, force: true })
})

test('the rules data: known classes, every explained rule resolves to a lessons row, and no origin content', () => {
  for (const r of RULES.rules) {
    assert.ok(RULES.classes.includes(r.class), r.id)
    if (r.class === 'explained') assert.ok(citeLessons(r.cite), `${r.id}: ${r.cite?.phrase}`)
    if (r.class === 'defect') assert.ok(r.fix, `${r.id} proposes a fix`)
  }
  const text = readFileSync(RULES_FILE, 'utf8')
  assert.doesNotMatch(text, /xnms|DESTELENG|\b[0-9a-f]{8,40}\b/i)
  assert.equal(new Set(RULES.rules.map((r) => r.id)).size, RULES.rules.length)
})

test('parsers: verify, review, plan graph, phases, ledger and headings', () => {
  const verify = ['# Verification Report', '', '## 1. Structural Validation (`x`)', '', '**Result**: FAIL on two old specs', '', '## 4. Design / Specs Coherence', '', 'Result: `C4: PASS WITH WARNINGS`.', '', '## 7. No Leftover Group Worktree', '', '- [x] none left', '', '## Overall Decision', '', '- [x] ⚠️ PASS WITH WARNINGS — proceed'].join('\n')
  assert.deepEqual(originVerify(verify, RULES.verifyTitles), { checks: { validation: 'fail', c4: 'warn', worktrees: 'pass' }, verdict: 'PASS WITH WARNINGS' })

  const review = ['**Verdict**: PASS', '**Rounds**: `2` (round 1 ...)', '**Counts**: CRITICAL `0` | HIGH `1` | MEDIUM `0` | LOW `1`', '', '| # | Severity | Where | Disposition |', '|---|---|---|---|', '| 1 | HIGH | `a.ts:1` | fixed in `abc1234` |', '| F2 | 1 | LOW | `b.ts:2` | t | recorded, non-blocking |'].join('\n')
  assert.deepEqual(reviewRecord(review), { verdict: 'PASS', rounds: 2, counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1 }, dispositions: { fixed: 1, recorded: 1, accepted: 0, dismissed: 0 } })

  const plan = ['## Execution Graph', '', '| Group | Tasks | Files | Wave |', '|---|---|---|---|', '| A: contracts, storage | 1, 2 | `a` | 1 |', '| **B** | 3 | `b` | 2 |', '', '| Group A | Group B | Coupling |', '|---|---|---|', '| A | B | strong |', '', '### Task 1: a', '### Task 2: b', '### Task 3: c', '### Task 4: d'].join('\n')
  assert.deepEqual(planGraph(plan), { groups: [{ letter: 'A', tasks: [1, 2], wave: 1 }, { letter: 'B', tasks: [3], wave: 2 }], tasks: [1, 2, 3, 4] })

  const phases = byPhase(['docs(openspec): propose x', 'feat(a): one', 'chore(openspec): record apply of x', 'docs(openspec): verify x', 'fix(a): two', 'docs(openspec): review x', 'docs(specs): archive x', 'docs(memory): ingest what x taught', 'fix(a): after the merge request review'], RULES)
  assert.deepEqual(Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.length])), { propose: 1, apply: 2, verify: 1, review: 2, archive: 2, 'after-archive': 1 })

  const o = [{ id: 'debt-1', kind: 'debt', at: '1', what: 'w' }, { id: 'resolve-1', kind: 'resolve', at: '2', debt: 'debt-1', as: 'flow-debt', where: 'q' }, { id: 'ruling-1', kind: 'ruling', at: '3', check: 'c' }]
  const p = [{ id: 'debt-1', kind: 'debt', at: '9', what: 'w' }, { id: 'resolve-1', kind: 'resolve', at: '9', debt: 'debt-1', as: 'adf-debt', where: 'q' }, { id: 'ruling-2', kind: 'ruling', at: '9', finding: 'deviation-1' }]
  const cmp = compareLedgers(o, p, RULES.ledgerRenames)
  assert.deepEqual([cmp.lost.map((r) => r.id), cmp.invented.map((r) => r.id), cmp.renamed.map((x) => x.port.id)], [['ruling-1'], ['ruling-2'], ['resolve-1']])

  assert.deepEqual(headings('# A\ntext\n## B\n#notheading\n### C'), ['# A', '## B', '### C'])
})

test('main: skipped, not failed, without an author or a candidate', async () => {
  const log = console.log
  const lines = []
  console.log = (s) => lines.push(s)
  try {
    const env = { ...process.env }
    delete process.env.ADF_AUTHOR
    delete process.env.ADF_REPLAY_FRESH
    delete process.env.ADF_REPLAY_MID
    try {
      assert.equal(await main(['/nowhere']), 0)
      assert.equal(await main(['/nowhere', '--author', 'Dev One']), 0)
    } finally {
      Object.assign(process.env, env)
    }
  } finally {
    console.log = log
  }
  assert.match(lines[0], /^SKIP origin-replay: no author/)
  assert.match(lines[1], /^SKIP origin-replay: no candidate named/)
})

// ---------------------------------------------------------------- the fixture origin

const REGISTRY = ORDER.map((name) => ({
  name,
  path: join(PLUGINS, name),
  config: { 'adf-postgres': { prefix: 't', url: { file: '.env', key: 'DATABASE_URL' }, exec: 'local' }, 'adf-jira': { baseUrl: 'https://jira.example.invalid', allowlist: ['K'] } }[name] ?? null,
  notes: []
}))
const snapshot = (dir) => {
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' })
  return { refs: git('for-each-ref'), status: git('status', '--porcelain'), stash: git('stash', 'list') }
}

test('the fixture: both modes compared with the origin; every difference classified, the in-flight base, the specs-base check and the fixture\'s own spec merge the defects; the origin unchanged', { timeout: 600_000 }, async () => {
  const F = fixtureOrigin()
  const before = snapshot(F.dir)
  const [candidate] = findCandidates(F.dir, { author: DEV.name, since: F.base })
  const sandbox = createSandbox({ origin: F.dir })
  const out = join(sandbox.root, 'compare')
  const log = console.log
  try {
    writeRunRecord(sandbox, drive(sandbox, candidate, buildReplies(sandbox, candidate), { host: { registry: REGISTRY } }))
    writeRunRecord(sandbox, driveMidFlight(sandbox, candidate, buildReplies(sandbox, candidate), { host: { registry: REGISTRY } }))
    console.log = () => {}
    const exit = await main([F.dir, '--author', DEV.name, '--since', F.base, '--fresh', CHANGE, '--mid', CHANGE, '--sandbox', sandbox.root, '--out', out])
    console.log = log
    const result = JSON.parse(readFileSync(join(out, 'compare.json'), 'utf8'))
    assert.equal(result.origin.unchanged, true)
    assert.deepEqual(result.runs.map((r) => r.mode), ['fresh', 'mid-flight'])
    const [fresh, mid] = result.runs
    for (const r of result.runs) {
      for (const area of ['phases', 'branch', 'base', 'artifacts', 'gates', 'ledger', 'review', 'main specs', 'openspec/ and memory tree', 'merge request', 'commits by phase']) assert.ok(r.compared.includes(area), `${r.mode}: ${area} compared`)
      for (const d of r.differences) assert.ok(d.class !== null || !d.strong, JSON.stringify(d))
    }
    // The fresh run: one defect, the main spec after the merge. The fixture origin's archive
    // commit kept a scenario line its delta changed, so the port's merge of the delta differs:
    // a strong difference (D7) no rule explains.
    const specDefect = fresh.differences.filter((d) => d.class === 'defect')
    assert.deepEqual(specDefect.map((d) => d.key), ['spec-merge:cap'])
    assert.deepEqual(specDefect[0].evidence.port, ['- **THEN** the thing is done twice'])
    // The branch suggestion is explained by its lessons row.
    const suggest = fresh.differences.find((d) => d.key === 'driver:propose')
    assert.equal(suggest.class, 'explained')
    assert.match(`${suggest.cite.file}:${suggest.cite.line}`, /^docs\/lessons\/propose\.md:\d+$/)
    assert.equal(fresh.differences.find((d) => d.key === 'artifact-only-origin:.openspec.yaml')?.class, 'explained')
    assert.ok(!fresh.differences.some((d) => d.key.startsWith('ledger-')), 'the ledgers agree')
    // The mid-flight run: the port refuses the origin's in-flight change (no .adf.json), and its
    // verify fails the change for having no specs-base.json, which archive only warns about.
    assert.deepEqual(mid.differences.filter((d) => d.class === 'defect').map((d) => d.rule ?? d.key), ['in-flight-metadata', 'specs-base-mid-flight', 'spec-merge:cap'])
    assert.equal(mid.differences.find((d) => d.key === 'mr:state')?.class, 'injected', 'the mid-flight mode runs no land')
    assert.equal(exit, 1)
    const md = readFileSync(join(out, 'compare.md'), 'utf8')
    assert.match(md, /^# Replay comparison/)
    assert.match(md, /## Defects\n\n- add-thing \(fresh\) spec-merge:cap: [^\n]*\n- add-thing \(mid-flight\) driver:apply/)
  } finally {
    console.log = log
    sandbox.destroy()
  }
  assert.deepEqual(snapshot(F.dir), before)
})
