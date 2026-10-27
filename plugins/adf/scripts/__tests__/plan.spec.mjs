// plan.mjs and lib/plan.mjs: the plan lint, the Execution Graph, the schedule and the
// "Added during apply" record, as pure functions and against real git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addDuringApply,
  addRoundTask,
  computeGraph,
  frozenGroups,
  graphFindings,
  lintPlanText,
  packagesFromGuide,
  parseGraph,
  parseNeeds,
  parsePlan,
  planInputs,
  parseRisks,
  reconcileRisks,
  renderGraph,
  schedule,
  sweepDeletes,
  testFirst,
  unplannedFiles,
  writeGraph
} from '../lib/plan.mjs'
import { run } from '../plan.mjs'
import { initRegistry, readRegistry, writeRegistry } from '../lib/registry.mjs'

// ---------------------------------------------------------------- fixtures

function task(n, item, { files = [`- Modify: \`src/t${n}.ts\` — the change`], consumes = null, level = 'integration', red = true, commit = true, refactor = false, omit = [] } = {}) {
  const out = [`### Task ${n}: task ${n}`, '', `> Implements \`tasks.md\` ${item}.`, '']
  if (!omit.includes('files')) out.push('**Files:**', ...files, '')
  if (!omit.includes('interfaces')) out.push('**Interfaces:**', ...(consumes ? [`- Consumes: ${consumes}`] : ['none']), '')
  if (!omit.includes('level')) out.push(`**Level:** ${level}`, '')
  if (!omit.includes('behaviour')) out.push('**Behaviour and acceptance:** it works.', '')
  if (red) out.push('- [ ] **Step 1: RED** — a test', '- [ ] **Step 2: GREEN** — the code')
  if (refactor) out.push('- [ ] **Step 3: REFACTOR** — tidy')
  if (commit) out.push('- [ ] **Step 4: Commit** — `feat: x`')
  out.push('', '---', '')
  return out.join('\n')
}

const TASKS = '## 1. One\n\n- [ ] 1.1 first\n- [ ] 1.2 second\n\n## 2. Two\n\n- [ ] 2.1 third\n'
const GRAPH = [
  '## Execution Graph',
  '',
  '| Group | Tasks | Files | Wave |',
  '|---|---|---|---|',
  '| A | 1, 2 | `src/t1.ts`, `src/t2.ts` | 1 |',
  '| B | 3 | `src/t3.ts` | 1 |',
  '',
  '| Group A | Group B | Coupling | Reasoning (required if medium) |',
  '|---|---|---|---|',
  '',
  '---',
  ''
].join('\n')
const plan = (tasks = [task(1, '1.1'), task(2, '1.2'), task(3, '2.1')], graph = GRAPH) => `# Plan\n\n${graph}\n${tasks.join('\n')}`
const errors = (findings) => findings.filter((f) => f.severity === 'error')
const kinds = (findings) => findings.map((f) => f.kind).sort()

// ---------------------------------------------------------------- lint

test('a plan that follows the rules has no error, and its test-first tasks are named', () => {
  const text = plan([task(1, '1.1'), task(2, '1.2', { red: false }), task(3, '2.1')])
  const { tasks, findings } = lintPlanText({ planText: text, tasksText: TASKS })
  assert.deepEqual(errors(findings), [])
  assert.deepEqual(testFirst(tasks), [1, 3])
})

test('back-references: unknown, out of order, duplicated, and an item with no task', () => {
  const text = plan([task(1, '1.2'), task(2, '1.2'), task(3, '9.9')])
  const { findings } = lintPlanText({ planText: text, tasksText: TASKS })
  const e = errors(findings)
  assert.deepEqual(
    e.filter((f) => !f.kind.startsWith('graph')).map((f) => `${f.kind}:${f.task ?? f.item}`),
    ['order:1', 'duplicate-reference:2', 'unknown-item:3', 'unplanned-item:1.1', 'unplanned-item:2.1']
  )
  assert.ok(e.find((f) => f.kind === 'unknown-item').line > 0, 'a finding names its line')
})

test('every field, the level enum, a commit step, RED with GREEN, no REFACTOR', () => {
  const text = plan([
    task(1, '1.1', { omit: ['interfaces', 'behaviour'] }),
    task(2, '1.2', { level: 'senior', commit: false }),
    task(3, '2.1', { refactor: true })
  ])
  const { findings } = lintPlanText({ planText: text, tasksText: TASKS })
  assert.deepEqual(kinds(errors(findings)), ['level', 'missing-field', 'missing-field', 'no-commit-step', 'refactor-step'])
  const t1 = '### Task 1: a\n\n> Implements tasks.md 1.1.\n\n**Files:**\n- Modify: `a.ts`\n\n**Interfaces:** none\n\n**Level:** mechanical\n\n**Behaviour and acceptance:** x\n\n- [ ] **Step 1: RED** — t\n- [ ] **Step 2: Commit** — c\n'
  assert.deepEqual(kinds(errors(lintPlanText({ planText: `${t1}`, tasksText: '## 1. A\n- [ ] 1.1 a\n' }).findings)), ['graph-missing', 'red-green'])
})

test('a task spanning two packages is a warning, from the guide only', () => {
  const files = ['- Modify: `apps/server/a.ts`', '- Modify: `apps/client/b.ts`']
  const text = plan([task(1, '1.1', { files }), task(2, '1.2'), task(3, '2.1')], GRAPH.replace('`src/t1.ts`', '`apps/server/a.ts`, `apps/client/b.ts`'))
  const guide = '# Guide\n\n## Packages\n\n- `apps/server` first\n- `apps/client/` then\n\n## Other\n\n`not/a/package`\n'
  assert.deepEqual(packagesFromGuide(guide), ['apps/server', 'apps/client'])
  const withGuide = lintPlanText({ planText: text, tasksText: TASKS, guideText: guide }).findings
  assert.deepEqual(withGuide.filter((f) => f.kind === 'cross-package').map((f) => [f.severity, f.task, f.packages]), [['warning', 1, ['apps/server', 'apps/client']]])
  // Without a package map there is no package boundary: no guide, a guide without the section,
  // or the template's section with only its comment.
  const template = '## Packages\n\n<!-- The project\'s packages or top-level source directories. -->\n\n## Other\n'
  for (const guideText of [null, '# Guide\n\n## Where to look\n\n`apps/server`\n', template])
    assert.deepEqual(lintPlanText({ planText: text, tasksText: TASKS, guideText }).findings.filter((f) => f.kind === 'cross-package'), [])
  // The origin's spans by top-level directory ("spans apps, tests", "spans packages, apps") are silent too.
  const origin = plan([task(1, '1.1', { files: ['- Modify: `apps/server/src/a.ts`', '- Test: `tests/e2e/a.spec.ts`', '- Modify: `packages/shared/src/b.ts`'] }), task(2, '1.2'), task(3, '2.1')])
  assert.deepEqual(lintPlanText({ planText: origin, tasksText: TASKS }).findings.filter((f) => f.kind === 'cross-package'), [])
})

test('every design risk needs a plan line naming a Task or a deferral', () => {
  const design = [
    '# Design',
    '',
    '## Risks / Trade-offs',
    '',
    '- [The bench may reject the speed mode write] → read back after',
    '  every write.',
    '- [Byte counts never arrive from the firmware] → optional.',
    '- [Cache invalidation races with the poller] → a lock.',
    '',
    '## Migration'
  ].join('\n')
  const risks = parseRisks(design)
  assert.deepEqual(risks.map((r) => r.line), [5, 7, 8])
  const lines = ['- Speed mode write rejected by the bench → Task 2 reads back.', '- Byte counts never arrive → deferred: the firmware has no counter yet.', '- Cache races → handled somewhere.']
  assert.deepEqual(reconcileRisks(risks, lines).map((r) => r.text), ['Cache invalidation races with the poller'])
  const { findings } = lintPlanText({ planText: `${plan()}\n${lines.join('\n')}\n`, tasksText: TASKS, designText: design })
  assert.deepEqual(findings.filter((f) => f.kind === 'risk-unreconciled').map((f) => [f.severity, f.file, f.line]), [['warning', 'design.md', 8]])
})

test('a risk with an id is reconciled by a plan line citing the id with a Task or a deferral', () => {
  const design = [
    '## Risks / Trade-offs',
    '',
    '- [R1] The bench may reject the speed mode write → read back after every write.',
    '- [R2] Byte counts never arrive → optional.',
    '- [R3] Cache races with the poller → a lock.',
    '- [R3] Twice → no.',
    ''
  ].join('\n')
  assert.deepEqual(parseRisks(design).map((r) => [r.id, r.text]), [['R1', 'The bench may reject the speed mode write'], ['R2', 'Byte counts never arrive'], ['R3', 'Cache races with the poller'], ['R3', 'Twice']])
  // R1's line shares no word with the risk: the id alone matches. R3's line shares many words but
  // cites no id, so it does not count. R9 is not defined; Task 7 does not exist.
  const lines = ['- R1 → Task 2.', '- R2: deferred, the firmware has no counter yet.', '- Cache races with the poller → Task 3.', '- R9 → Task 1.', '- R1 also → Task 7.']
  const { findings } = lintPlanText({ planText: `${plan()}\n${lines.join('\n')}\n`, tasksText: TASKS, designText: design })
  const risk = findings.filter((f) => f.kind.startsWith('risk-')).map((f) => [f.severity, f.kind, f.risk, f.file])
  assert.deepEqual(risk, [
    ['error', 'risk-duplicate-id', 'R3', 'design.md'],
    ['error', 'risk-unknown-id', 'R9', 'plan.md'],
    ['error', 'risk-unknown-task', 'R1', 'design.md'],
    ['error', 'risk-unreconciled', 'R3', 'design.md']
  ])
})

test('the Delete sweep reports each file outside the task that still names the path or an export', async () => {
  const files = ['- Delete: `src/old/thing.ts` — gone', '- Modify: `src/uses-thing.ts` — import removed']
  const { tasks } = parsePlan(plan([task(1, '1.1', { files }), task(2, '1.2'), task(3, '2.1')]))
  const calls = []
  const grep = async ({ fixed, word }) => {
    calls.push({ fixed, word })
    if (!word) return ['src/old/thing.ts', 'src/uses-thing.ts', 'src/other.ts']
    return fixed[0] === 'makeThing' ? ['src/old/thing.ts', 'src/other.ts', 'src/third.ts'] : []
  }
  const read = async () => 'export function makeThing() {}\nexport const x = 1\nexport { helper as renamedHelper }\n'
  const findings = await sweepDeletes(tasks, { grep, read })
  assert.deepEqual(calls[0], { fixed: ['src/old/thing.ts', 'thing.ts', "/thing'", '/thing"'], word: false })
  assert.deepEqual(calls.slice(1).map((c) => c.fixed[0]), ['makeThing', 'renamedHelper'])
  assert.deepEqual(findings.map((f) => [f.severity, f.task, f.file]), [['error', 1, 'src/other.ts'], ['warning', 1, 'src/third.ts']])
})

test('the Delete sweep skips the files its exclusion names: the knowledge base and the debt tree', async () => {
  const files = ['- Delete: `src/old/thing.ts` — gone']
  const { tasks } = parsePlan(plan([task(1, '1.1', { files }), task(2, '1.2'), task(3, '2.1')]))
  const grep = async ({ word }) => (word ? [] : ['src/other.ts', 'kb/entities/thing.md', 'debt/index.md'])
  const read = async () => ''
  const exclude = (file) => file.startsWith('kb/') || file.startsWith('debt/')
  const findings = await sweepDeletes(tasks, { grep, read, exclude })
  assert.deepEqual(findings.map((f) => f.file), ['src/other.ts'])
})

// ---------------------------------------------------------------- graph

const graphTasks = () =>
  parsePlan(
    plan([
      task(1, '1.1', { files: ['- Modify: `src/shared.ts`', '- Modify: `src/a.ts`'] }),
      task(2, '1.2', { files: ['- Modify: `src/shared.ts`'] }),
      task(3, '2.1', { files: ['- Modify: `src/c.ts`'], consumes: '`thing` from `src/a.ts`' })
    ])
  ).tasks

test('the floor: both write is strong, a read of the other side is weak-or-medium, else none', () => {
  const g = computeGraph(graphTasks(), [
    { letter: 'A', tasks: [1] },
    { letter: 'B', tasks: [2] },
    { letter: 'C', tasks: [3] }
  ])
  assert.deepEqual(g.pairs.map((p) => `${p.a}${p.b}:${p.floor}`), ['AB:strong', 'AC:weak-or-medium', 'BC:none'])
  assert.deepEqual(g.undecided, ['A/C'])
  assert.deepEqual(g.groups.map((x) => [x.letter, x.wave, x.dependsOn]), [['A', 1, []], ['B', 2, ['A']], ['C', 1, []]])
  assert.deepEqual(g.groups[0].files, ['src/a.ts', 'src/shared.ts'])
  assert.deepEqual(g.errors, [])
})

test('a decision raises a floor, never lowers it; medium needs a criticality; tasks are partitioned', () => {
  const t = graphTasks()
  const spec = [{ letter: 'A', tasks: [1] }, { letter: 'B', tasks: [2] }, { letter: 'C', tasks: [3] }]
  assert.match(computeGraph(t, spec, { coupling: { 'A/B': { coupling: 'weak' } } }).errors.join(), /below the floor strong/)
  assert.match(computeGraph(t, spec, { coupling: { 'A-C': { coupling: 'medium' } } }).errors.join(), /needs criticality/)
  const high = computeGraph(t, spec, { coupling: { 'C/A': { coupling: 'medium', criticality: 'high', reason: 'C reads A.' } } })
  assert.deepEqual(high.undecided, [])
  assert.equal(high.pairs[1].reason, 'High criticality: C reads A.')
  // A–B strong sends B to wave 2; A–C high sends C to wave 2; B and C may share wave 2.
  assert.deepEqual(high.groups.map((x) => [x.letter, x.wave, x.dependsOn]), [['A', 1, []], ['B', 2, ['A']], ['C', 2, ['A']]])
  assert.match(computeGraph(t, [{ letter: 'A', tasks: [1, 2] }]).errors.join(), /Task 3 is in no group/)
  assert.match(computeGraph(t, [{ letter: 'A', tasks: [1, 2, 3] }, { letter: 'B', tasks: [3, 7] }]).errors.join(), /Task 3 is in group A and group B.*Task 7/)
  // Two wave-2 groups that may not share a wave would need a third tier.
  const third = computeGraph(t, spec, { depends: { B: ['A'], C: ['A'] }, coupling: { 'B/C': { coupling: 'strong' }, 'A/C': { coupling: 'weak' } } })
  assert.match(third.errors.join(), /no wave 3/)
})

test('the rendered graph is the format the parser and the graph check read back', () => {
  const t = graphTasks()
  const g = computeGraph(t, [{ letter: 'A', tasks: [1] }, { letter: 'B', tasks: [2] }, { letter: 'C', tasks: [3] }], { coupling: { 'A/C': { coupling: 'weak', reason: 'C reads a.ts.' } } })
  const table = renderGraph(g)
  assert.match(table, /^\| Group \| Tasks \| Files \| Wave \|\n\|---\|---\|---\|---\|\n\| A \| 1 \| `src\/a\.ts`, `src\/shared\.ts` \| 1 \|/)
  assert.match(table, /\| A \| B \| strong \| Both write `src\/shared\.ts`\. \|/)
  assert.match(table, /Group B \(wave 2\) depends on: Group A$/)
  // A pair whose files do not overlap and that no decision raises is none: it gets no row.
  assert.doesNotMatch(table, /^\| B \| C \|/m)
  const apart = renderGraph(computeGraph(t, [{ letter: 'S', tasks: [1, 2] }, { letter: 'C', tasks: [3] }], { depends: { C: ['S'] }, coupling: { 'C/S': { coupling: 'weak' } } }))
  assert.match(apart, /\| S \| C \| weak \|/)
  assert.match(apart, /Group C \(wave 2\) depends on: Group S$/)
  const written = writeGraph(plan([task(1, '1.1', { files: ['- Modify: `src/shared.ts`', '- Modify: `src/a.ts`'] }), task(2, '1.2', { files: ['- Modify: `src/shared.ts`'] }), task(3, '2.1', { files: ['- Modify: `src/c.ts`'], consumes: '`thing` from `src/a.ts`' })]), table)
  const parsed = parseGraph(written)
  assert.deepEqual(parsed.groups.map((x) => [x.letter, x.tasks, x.wave]), [['A', [1], 1], ['B', [2], 2], ['C', [3], 1]])
  assert.deepEqual(parsed.depends, { B: ['A'] })
  assert.deepEqual(graphFindings(written), [])
  // Writing again replaces the tables instead of adding a second set.
  assert.equal(writeGraph(written, table), written)
})

test('writeGraph replaces the template section and adds a missing one before the first task', () => {
  const template = readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', '..', 'schema', 'templates', 'plan.md'), 'utf8')
  const out = writeGraph(template, '| Group | Tasks | Files | Wave |\n|---|---|---|---|\n| A | 1 | none | 1 |')
  const section = out.slice(out.indexOf('## Execution Graph'), out.indexOf('### Task 1'))
  assert.equal(section, '## Execution Graph\n\n| Group | Tasks | Files | Wave |\n|---|---|---|---|\n| A | 1 | none | 1 |\n\n---\n\n')
  const bare = '# P\n\nIntro.\n\n---\n\n### Task 1: x\n'
  assert.equal(writeGraph(bare, 'TABLE'), '# P\n\nIntro.\n\n## Execution Graph\n\nTABLE\n\n---\n\n### Task 1: x\n')
})

test('the graph check: same wave, criticality, a lowered floor, a dependency on wave 2', () => {
  const g = (rows, pairs = [], deps = '') =>
    `## Execution Graph\n\n| Group | Tasks | Files | Wave |\n|---|---|---|---|\n${rows}\n\n| Group A | Group B | Coupling | Reasoning (required if medium) |\n|---|---|---|---|\n${pairs}\n\n${deps}\n`
  const tasks = [task(1, '1.1', { files: ['- Modify: `src/shared.ts`'] }), task(2, '1.2', { files: ['- Modify: `src/shared.ts`'] }), task(3, '2.1')]
  const check = (graph) => kinds(graphFindings(plan(tasks, graph)))
  assert.deepEqual(check(g('| A | 1 | x | 1 |\n| B | 2 | x | 1 |\n| C | 3 | x | 1 |', '| A | B | strong | both |')), ['graph-same-wave'])
  assert.deepEqual(check(g('| A | 1 | x | 1 |\n| B | 2 | x | 2 |\n| C | 3 | x | 1 |', '| A | B | medium | it is shared |\n| A | C | weak | x |', 'Group B (wave 2) depends on: Group A.')), ['graph-criticality', 'graph-floor'])
  assert.deepEqual(
    check(g('| A — one | 1-2 | x | 1 |\n| B | 3 | x | 2 |\n| C | | x | 2 |', '', 'Group B (wave 2) depends on: Group A. Group C (wave 2) depends on: Group B.')),
    ['graph-depends-on-wave-2']
  )
  assert.deepEqual(check(g('| A | 1, 2 | x | 1 |', '')), ['graph-task-unassigned'])
  // D8: no regular origin plan of the final flow leaves a task outside every group; the one older
  // plan that did stated it in prose, which schedules nothing, so the finding stays an error.
  assert.deepEqual(
    check(g('| A | 1, 2 | x | 1 |', '', 'Task 3 was added at verify and run in sequence on the change branch, after all groups merged.')),
    ['graph-task-unassigned']
  )
  assert.deepEqual(kinds(graphFindings('# P\n\n### Task 1: x\n')), ['graph-missing'])
  assert.deepEqual(kinds(graphFindings('## Execution Graph\n\nThis is a single group: all write `a.ts`.\n\n### Task 1: x\n')), [])
})

// ---------------------------------------------------------------- schedule

const SCHEDULED = [
  '## Execution Graph',
  '',
  '| Group | Tasks | Files | Wave |',
  '|---|---|---|---|',
  '| A | 1 | x | 1 |',
  '| B | 2 | x | 1 |',
  '| C | 3 | x | 1 |',
  '| D | 4 | x | 2 |',
  '',
  '| Group A | Group B | Coupling | Reasoning (required if medium) |',
  '|---|---|---|---|',
  '| B | D | medium | High criticality: D calls B. |',
  '',
  'Group D (wave 2) depends on: Group A.',
  ''
].join('\n')
const four = plan([task(1, '1.1'), task(2, '1.2'), task(3, '2.1'), task(4, '2.2')], SCHEDULED)

test('schedule: the cap, the dependencies by statement and by coupling, merged and running groups', () => {
  const none = () => ({ merged: false, kept: false })
  const first = schedule(four, { state: none, cap: 2 })
  assert.equal(first.single, false)
  assert.deepEqual(first.groups.map((g) => [g.n, g.letter, g.wave, g.dependsOn, g.state]), [
    [1, 'A', 1, [], 'pending'],
    [2, 'B', 1, [], 'pending'],
    [3, 'C', 1, [], 'pending'],
    [4, 'D', 2, ['A', 'B'], 'pending']
  ])
  assert.deepEqual([first.startNow, first.waiting], [[1, 2], [3, 4]])
  // A merged and B still running: one slot, C takes it; D waits for B.
  const later = schedule(four, { state: (n) => ({ merged: n === 1, kept: n === 2 }), cap: 2 })
  assert.deepEqual([later.startNow, later.waiting], [[3], [4]])
  const last = schedule(four, { state: (n) => ({ merged: n <= 3, kept: false }), cap: 2 })
  assert.deepEqual([last.startNow, last.waiting], [[4], []])
})

test('schedule: one wave-1 group is the single-group case; a defective graph is refused', () => {
  const single = plan([task(1, '1.1'), task(2, '1.2'), task(3, '2.1')], '## Execution Graph\n\n| Group | Tasks | Files | Wave |\n|---|---|---|---|\n| A | 1-3 | x | 1 |\n')
  const s = schedule(single, { state: () => ({ merged: false, kept: false }), ticked: () => false })
  assert.deepEqual([s.single, s.startNow, s.waiting], [true, [1], []])
  assert.equal(schedule(single, { state: () => ({}), ticked: () => true }).groups[0].state, 'done')
  const bad = schedule(plan([task(1, '1.1')], '## Execution Graph\n\n| Group | Tasks | Files | Wave |\n|---|---|---|---|\n| A | 1 | x | 3 |\n'), { state: () => ({}) })
  assert.deepEqual([bad.ok, bad.findings.map((f) => f.kind)], [false, ['graph-wave']])
})

// ---------------------------------------------------------------- added during apply

test('unplanned files get the owner whose files the touching commits changed most', () => {
  const text = plan()
  const commits = [
    { sha: 'c1', files: ['src/t1.ts', 'src/helper.ts'] },
    { sha: 'c2', files: ['src/t2.ts', 'src/helper.ts', 'openspec/changes/c/plan.md'] },
    { sha: 'c3', files: ['src/t2.ts', 'src/helper.ts'] },
    { sha: 'c4', files: ['docs/lonely.md'] }
  ]
  const out = unplannedFiles(text, commits, { exempt: (f) => f.startsWith('openspec/changes/c/'), status: { 'docs/lonely.md': 'Create' } })
  assert.deepEqual(out.map((f) => [f.file, f.owner, f.verb, f.commits]), [
    ['src/helper.ts', 2, 'Modify', ['c1', 'c2', 'c3']],
    ['docs/lonely.md', null, 'Create', ['c4']]
  ])
})

test('addDuringApply appends the dated bullet at the end of the Files block, once', () => {
  const text = plan()
  const out = addDuringApply(text, { task: 2, path: 'src/helper.ts', why: 'the fix round needed it', date: '2026-10-15' })
  assert.equal(out.bullet, '- Modify: `src/helper.ts` — Added during apply, 2026-10-15: the fix round needed it')
  const lines = out.text.split('\n')
  assert.equal(lines[out.line - 1], out.bullet)
  assert.equal(lines[out.line - 2], '- Modify: `src/t2.ts` — the change')
  assert.equal(lines[out.line], '')
  assert.equal(lines[out.line + 1], '**Interfaces:**')
  assert.equal(addDuringApply(out.text, { task: 2, path: 'src/helper.ts', why: 'again', date: '2026-10-15' }).added, false)
  assert.throws(() => addDuringApply(text, { task: 9, path: 'a', why: 'w', date: '2026-10-15' }), /no Task 9/)
  assert.throws(() => addDuringApply(text, { task: 1, path: 'a', why: 'w', date: '15.10.2026' }), /not YYYY-MM-DD/)
})

// ---------------------------------------------------------------- CLI against git

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function repo(planText = plan(), tasksText = TASKS) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adf-plan-')))
  git(root, 'init', '-q', '-b', 'develop')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  mkdirSync(join(root, 'src'))
  for (const n of [1, 2, 3]) writeFileSync(join(root, 'src', `t${n}.ts`), `export const t${n} = ${n}\n`)
  writeFileSync(join(root, 'src', 'old.ts'), 'export function oldThing() {}\n')
  writeFileSync(join(root, 'src', 'caller.ts'), "import { oldThing } from './old'\n")
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'checkout', '-q', '-b', 'feat/c')
  const dir = join(root, 'openspec', 'changes', 'c')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.adf.json'), '{"base":"develop"}\n')
  writeFileSync(join(dir, 'plan.md'), planText)
  writeFileSync(join(dir, 'tasks.md'), tasksText)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'propose')
  return { root, planFile: join(dir, 'plan.md') }
}

test('plan.mjs lint: a deleted file still named by the knowledge base or the debt tree is no delete-reference', async () => {
  const del = repo(plan([task(1, '1.1', { files: ['- Delete: `src/old.ts`', '- Modify: `src/caller.ts`'] }), task(2, '1.2'), task(3, '2.1')]))
  const pages = { '.claude/memory/entities/old.md': 'See `src/old.ts`.\n', 'records/debt/index.md': '| D1 | `src/old.ts` |\n', 'specs/old.md': 'Reads `src/old.ts`.\n' }
  for (const [path, text] of Object.entries(pages)) {
    mkdirSync(dirname(join(del.root, path)), { recursive: true })
    writeFileSync(join(del.root, path), text)
  }
  git(del.root, 'add', '.')
  git(del.root, 'commit', '-q', '-m', 'pages')
  const files = async () => (await run(['lint', '--change', 'c', '--root', del.root])).result.findings.filter((f) => f.kind === 'delete-reference').map((f) => f.message.split(' still names')[0].split(', and ')[1])
  // Without a registry every tracked file counts.
  assert.deepEqual((await files()).sort(), ['.claude/memory/entities/old.md', 'records/debt/index.md', 'specs/old.md'])
  // The knowledge provider's paths and the registry's debt root are archive's to update.
  initRegistry(del.root, '1.2')
  const memory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'adf-memory')
  writeRegistry(del.root, { ...readRegistry(del.root), extensions: [{ path: memory }], debt: { root: 'records/debt' } })
  assert.deepEqual(await files(), ['specs/old.md'])
})

test('plan.mjs lint: exit 0 for a clean plan, exit 1 with file:line findings, exit 2 on usage', async () => {
  const { root } = repo()
  const ok = await run(['lint', '--change', 'c', '--root', root])
  assert.deepEqual([ok.code, ok.result.ok, ok.result.testFirst], [0, true, [1, 2, 3]])
  const del = repo(plan([task(1, '1.1', { files: ['- Delete: `src/old.ts`'] }), task(2, '1.2'), task(3, '2.1')]))
  const bad = await run(['lint', '--change', 'c', '--root', del.root])
  assert.equal(bad.code, 1)
  assert.deepEqual(bad.result.findings.map((f) => [f.kind, f.file, f.task]), [['delete-reference', 'openspec/changes/c/plan.md', 1]])
  assert.equal(bad.result.findings[0].message.includes('src/caller.ts'), true)
  // Without --change the one active change under the root is used (X3); an unknown option is a usage error.
  assert.equal((await run(['lint', '--root', root])).result.ok, true)
  assert.equal((await run(['lint', '--root', root, '--bogus', 'x'])).code, 2)
  assert.equal((await run(['lint', '--change', 'nope', '--root', root])).code, 1)
})

// ---------------------------------------------------------------- needs

test('the plan-level Needs line: comma or space separated lowercase words, before the first task only', () => {
  const text = `# Plan\n\n<!-- **Needs:** commented -->\n**Needs:** database, cache queue\n**Needs:** \`database\` Big\n\n${task(1, '1.1')}\n**Needs:** inside-a-task\n`
  assert.deepEqual(parseNeeds(text), { needs: ['database', 'cache', 'queue'], invalid: [{ token: 'Big', line: 5 }], line: 4 })
  assert.deepEqual(parseNeeds(plan()), { needs: [], invalid: [], line: null })
})

test('lint warns on a need only when no provision provider is in the registry; a malformed word always', () => {
  const text = `# Plan\n\n**Needs:** database, Big\n\n${GRAPH}\n${[task(1, '1.1'), task(2, '1.2'), task(3, '2.1')].join('\n')}`
  const none = lintPlanText({ planText: text, tasksText: TASKS }).findings.filter((f) => f.kind.startsWith('needs'))
  assert.deepEqual(none.map((f) => [f.severity, f.kind, f.line]), [['warning', 'needs-word', 3], ['warning', 'needs-unprovided', 3]])
  assert.match(none[1].message, /the plan needs "database", but no provision plugin is in the registry/)
  const provided = lintPlanText({ planText: text, tasksText: TASKS, provisioned: true }).findings.filter((f) => f.kind.startsWith('needs'))
  assert.deepEqual(provided.map((f) => f.kind), ['needs-word'], 'with a provider the core judges no word')
  assert.deepEqual(errors(lintPlanText({ planText: text, tasksText: TASKS }).findings), [])
})

test('plan.mjs lint reads the registry for a provision provider; planInputs gives the planned paths and needs', async () => {
  const { root } = repo(`# Plan\n\n**Needs:** database\n\n${GRAPH}\n${[task(1, '1.1'), task(2, '1.2'), task(3, '2.1')].join('\n')}`)
  const kindsOf = async () => (await run(['lint', '--change', 'c', '--root', root])).result.findings.map((f) => f.kind)
  assert.deepEqual(await kindsOf(), ['needs-unprovided'])
  const plugin = realpathSync(mkdtempSync(join(tmpdir(), 'adf-plan-plugin-')))
  writeFileSync(join(plugin, 'adf-extension.json'), JSON.stringify({ name: 'db', contract: '1.6', provides: { provision: { script: 'p.mjs', operations: ['provision'] } } }))
  initRegistry(root, '1.6')
  writeRegistry(root, { ...readRegistry(root), extensions: [{ path: plugin, points: ['provision'] }] })
  assert.deepEqual(await kindsOf(), [])
  writeRegistry(root, { ...readRegistry(root), extensions: [{ plugin: 'adf-db@mk', points: ['provision'] }] })
  assert.deepEqual(await kindsOf(), [], 'an absent provider is still in the registry')
  assert.deepEqual(planInputs(root, 'c'), { files: ['src/t1.ts', 'src/t2.ts', 'src/t3.ts'], needs: ['database'] })
  assert.deepEqual(planInputs(root, 'missing'), { files: [], needs: [] })
})

test('plan.mjs graph --write puts the tables into plan.md; an undecided pair refuses', async () => {
  const { root, planFile } = repo(plan(undefined, '## Execution Graph\n\n<!-- template -->\n\n---\n'))
  const printed = await run(['graph', '--change', 'c', '--root', root, '--groups', 'A=1,2;B=3'])
  assert.deepEqual([printed.code, printed.result.written, printed.result.groups.map((g) => g.files)], [0, false, [['src/t1.ts', 'src/t2.ts'], ['src/t3.ts']]])
  const written = await run(['graph', '--change', 'c', '--root', root, '--groups', 'A=1,2;B=3', '--write'])
  assert.equal(written.result.written, true)
  assert.deepEqual(parseGraph(readFileSync(planFile, 'utf8')).groups.map((g) => g.tasks), [[1, 2], [3]])
  assert.equal((await run(['graph', '--change', 'c', '--root', root, '--groups', 'A=1'])).code, 1)
  assert.equal((await run(['graph', '--change', 'c', '--root', root, '--groups', 'A'])).code, 2)
})

test('plan.mjs schedule reads merged groups from merge commits and kept ones from worktrees', async () => {
  const { root } = repo(four, `${TASKS}- [ ] 2.2 fourth\n`)
  git(root, 'checkout', '-q', '-b', 'feat/c--group-1')
  writeFileSync(join(root, 'src', 't1.ts'), 'changed\n')
  git(root, 'commit', '-q', '-am', 'group 1')
  git(root, 'checkout', '-q', 'feat/c')
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'feat/c--group-1')
  git(root, 'branch', '-q', '-D', 'feat/c--group-1')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/c--group-2', join(root, '.claude', 'worktrees', 'c--group-2'))
  const out = await run(['schedule', '--change', 'c', '--root', root, '--cap', '2'])
  assert.equal(out.code, 0)
  assert.deepEqual(out.result.groups.map((g) => [g.n, g.state]), [[1, 'merged'], [2, 'running'], [3, 'pending'], [4, 'pending']])
  assert.deepEqual([out.result.startNow, out.result.waiting], [[3], [4]])
})

test('plan.mjs unplanned proposes an owner and added records the file against it', async () => {
  const { root, planFile } = repo()
  writeFileSync(join(root, 'src', 't3.ts'), 'x\n')
  writeFileSync(join(root, 'src', 'new-helper.ts'), 'x\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'fix')
  const found = await run(['unplanned', '--change', 'c', '--root', root])
  assert.deepEqual(found.result.files.map((f) => [f.file, f.owner, f.verb]), [['src/new-helper.ts', 3, 'Create']])
  const added = await run(['added', '--change', 'c', '--root', root, '--path', 'src/new-helper.ts', '--why', 'the fix needed a helper', '--date', '2026-10-15'])
  assert.deepEqual([added.code, added.result.task, added.result.bullet], [0, 3, '- Create: `src/new-helper.ts` — Added during apply, 2026-10-15: the fix needed a helper'])
  assert.match(readFileSync(planFile, 'utf8'), /Added during apply, 2026-10-15/)
  assert.deepEqual((await run(['unplanned', '--change', 'c', '--root', root])).result.files, [])
  const orphan = await run(['added', '--change', 'c', '--root', root, '--path', 'docs/none.md', '--why', 'w'])
  assert.equal(orphan.code, 1)
})

test('plan.mjs added --commit commits plan.md alone with the fixed message; nothing new commits nothing', async () => {
  const { host, commitIn, git: gitOut } = await import('./git-host.mjs')
  const { change, dir } = host({ 'plan.md': plan(), 'tasks.md': TASKS })
  commitIn(change, 'src/new-helper.ts', 'x\n', 'fix')
  writeFileSync(join(change, 'stray.txt'), 'x\n')
  const args = ['added', '--change', 'add-x', '--root', change, '--path', 'src/new-helper.ts', '--why', 'the fix needed a helper', '--task', '3', '--date', '2026-10-15', '--commit']
  const out = await run(args)
  assert.equal(out.code, 0, out.result.error)
  assert.equal(out.result.commit, gitOut(change, 'rev-parse', 'HEAD'))
  assert.equal(gitOut(change, 'log', '-1', '--format=%s'), 'docs(openspec): record work added during apply to add-x')
  assert.equal(gitOut(change, 'show', '--name-only', '--format=', 'HEAD'), 'openspec/changes/add-x/plan.md')
  assert.match(readFileSync(join(dir, 'plan.md'), 'utf8'), /Added during apply, 2026-10-15/)
  assert.equal((await run(args)).result.commit, null)
})

// ---------------------------------------------------------------- an apply round

// A fix task writing src/t1.ts, which group A (Tasks 1, 2) wrote and merged before the round.
const FIX_BODY = [
  '**Files:**',
  '- Modify: `src/t1.ts` — the fix',
  '',
  '**Interfaces:** none',
  '',
  '**Level:** integration',
  '',
  '**Behaviour and acceptance:** the failing check passes.',
  '',
  '- [ ] **Step 1: RED** — a test',
  '- [ ] **Step 2: GREEN** — the code',
  '- [ ] **Step 3: Commit** — `fix: x`'
].join('\n')
const DONE = TASKS.replaceAll('[ ]', '[x]')
const reopened = () => addRoundTask({ planText: plan(), tasksText: DONE, title: 'fix the tree check', body: FIX_BODY, round: 1 })

test('a round task conflicting with a merged group gets wave 1, and the merged group stays independent', () => {
  const { planText } = reopened()
  const { tasks } = parsePlan(planText)
  const spec = [{ letter: 'A', tasks: [1, 2] }, { letter: 'B', tasks: [3] }, { letter: 'C', tasks: [4] }]
  // Without the round's frozen base, every group is unexecuted: C waits on A.
  const naive = computeGraph(tasks, spec)
  assert.deepEqual(naive.groups.map((g) => [g.letter, g.wave, g.dependsOn]), [['A', 1, []], ['B', 1, []], ['C', 2, ['A']]])
  const frozen = { A: { wave: 1, dependsOn: [] }, B: { wave: 1, dependsOn: [] } }
  const g = computeGraph(tasks, spec, { frozen, depends: { C: ['A'] } })
  assert.deepEqual(g.groups.map((x) => [x.letter, x.wave, x.dependsOn]), [['A', 1, []], ['B', 1, []], ['C', 1, []]])
  assert.deepEqual([g.pairs, g.errors], [[], []])
  // The graph check: the floor of A/C is no error once A is frozen.
  assert.deepEqual(kinds(errors(graphFindings(planText))), ['graph-floor'])
  assert.deepEqual(errors(graphFindings(planText, undefined, { frozen: ['A', 'B'] })), [])
  // The schedule: the frozen groups are merged base, and the round's group is the single live one.
  const s = schedule(planText, { state: () => ({ merged: false, kept: false }), ticked: (id) => id !== '3.1', frozen: ['A', 'B'] })
  assert.deepEqual([s.single, s.groups.map((x) => [x.letter, x.state]), s.startNow], [true, [['A', 'done'], ['B', 'done'], ['C', 'pending']], [3]])
  assert.deepEqual(frozenGroups(plan(), { state: (n) => ({ merged: n <= 2, kept: false }), ticked: () => true }), ['A', 'B'])
  assert.deepEqual(frozenGroups(plan(), { state: (n) => ({ merged: n === 1, kept: false }), ticked: () => true }), ['A'], 'an unmerged group is not frozen')
})

test('addRoundTask appends the item, the task and the graph row; a second task joins the round', () => {
  const first = reopened()
  assert.deepEqual([first.task, first.item, first.group], [4, '3.1', 'C'])
  assert.ok(first.tasksText.endsWith('## 3. Apply round 1\n\n- [ ] 3.1 fix the tree check\n'), first.tasksText)
  assert.ok(first.planText.includes('### Task 4: fix the tree check\n\n> Implements `tasks.md` 3.1.\n\n**Files:**'))
  assert.equal(parseGraph(first.planText).groups.at(-1).line, parseGraph(plan()).groups.at(-1).line + 1)
  assert.ok(first.planText.includes('| C | 4 | `src/t1.ts` | 1 |'))
  assert.deepEqual(errors(lintPlanText({ planText: first.planText, tasksText: first.tasksText, frozen: ['A', 'B'] }).findings), [])
  const second = addRoundTask({ planText: first.planText, tasksText: first.tasksText, title: 'and the docs', body: FIX_BODY.replace('src/t1.ts', 'src/t2.ts'), round: 1, item: 3, group: 'C' })
  assert.deepEqual([second.task, second.item, second.group], [5, '3.2', 'C'])
  assert.ok(second.planText.includes('| C | 4, 5 | `src/t1.ts`, `src/t2.ts` | 1 |'))
  assert.deepEqual(errors(lintPlanText({ planText: second.planText, tasksText: second.tasksText, frozen: ['A', 'B'] }).findings), [])
  assert.throws(() => addRoundTask({ planText: plan(), tasksText: DONE, title: 't', body: `### Task 9: x\n${FIX_BODY}`, round: 1 }), /"###" heading/)
  assert.throws(() => addRoundTask({ planText: plan(), tasksText: DONE, title: 'two\nlines', body: FIX_BODY, round: 1 }), /one non-empty line/)
})

test('plan.mjs reopen: refused without a committed FAIL; then writes both files, commits them and records the round', async () => {
  const { host, commitIn, git: gitOut } = await import('./git-host.mjs')
  const { readRecords } = await import('../lib/ledger.mjs')
  const { change, dir } = host({ 'plan.md': plan(), 'tasks.md': DONE })
  // Groups A and B were merged into the change branch.
  for (const n of [1, 2]) {
    gitOut(change, 'checkout', '-q', '-b', `feat/add-x--group-${n}`)
    commitIn(change, `src/t${n}.ts`, 'x\n')
    gitOut(change, 'checkout', '-q', 'feat/add-x')
    gitOut(change, 'merge', '-q', '--no-ff', '--no-edit', `feat/add-x--group-${n}`)
  }
  const body = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-reopen-'))), 'task.md')
  writeFileSync(body, FIX_BODY)
  const reopen = (title = 'fix the tree check', file = body) => run(['reopen', '--change', 'add-x', '--root', change, '--title', title, '--task-file', file])
  const clean = () => gitOut(change, 'status', '--porcelain')
  assert.match((await reopen()).result.error, /verify\.md does not exist; nothing written/)
  commitIn(change, 'openspec/changes/add-x/verify.md', '# Verification Report\n\nVerdict: PASS WITH WARNINGS\n')
  const warned = await reopen()
  assert.deepEqual([warned.code, clean()], [1, ''])
  assert.match(warned.result.error, /says Verdict: PASS WITH WARNINGS/)
  const FAIL = '# Verification Report\n\n## Next step\n\nFix what each failing check names, then run verify again:\n\n- `tree`: no code\n- `ext:db:schema`: drift\n\nVerdict: FAIL\n'
  const verify = commitIn(change, 'openspec/changes/add-x/verify.md', FAIL)
  const base = gitOut(change, 'rev-parse', 'HEAD')
  const out = await reopen()
  assert.equal(out.code, 0, out.result.error)
  assert.deepEqual(
    [out.result.round, out.result.opened, out.result.task, out.result.item, out.result.group, out.result.frozen, out.result.checks, out.result.base],
    [1, true, 4, '3.1', 'C', ['A', 'B'], ['tree', 'ext:db:schema'], base]
  )
  assert.equal(gitOut(change, 'log', '-1', '--format=%s'), 'docs(openspec): open apply round 1 of add-x')
  assert.equal(gitOut(change, 'show', '--name-only', '--format=', 'HEAD'), 'openspec/changes/add-x/plan.md\nopenspec/changes/add-x/tasks.md')
  assert.match(readFileSync(join(dir, 'tasks.md'), 'utf8'), /## 3\. Apply round 1\n\n- \[ \] 3\.1 fix the tree check\n$/)
  const record = readRecords(change, 'add-x').at(-1)
  assert.deepEqual(
    [record.kind, record.round, record.checks, record.task, record.group, record.base, record.verify, record.frozen],
    ['apply-round', '1', 'tree,ext:db:schema', '3.1', 'C', base, verify, 'A,B']
  )
  // The round's lint and schedule: A and B are merged base, C runs alone in the change worktree.
  assert.equal((await run(['lint', '--change', 'add-x', '--root', change])).result.ok, true)
  const s = (await run(['schedule', '--change', 'add-x', '--root', change])).result
  assert.deepEqual([s.single, s.groups.map((g) => g.state), s.startNow], [true, ['done', 'done', 'pending'], [3]])
  const { applyStatus } = await import('../lib/apply-status.mjs')
  const status = applyStatus(change, 'add-x')
  assert.deepEqual([status.single, status.remaining, status.round], [true, ['3.1'], { round: 1, base, checks: ['tree', 'ext:db:schema'], tasks: ['3.1'], group: 'C', frozen: ['A', 'B'] }])
  // A second task for the same FAIL record joins the round.
  const more = await reopen('and the docs')
  assert.deepEqual([more.result.round, more.result.opened, more.result.item, more.result.group], [1, false, '3.2', 'C'])
  // plan.mjs graph keeps the frozen groups' waves and pairs them with nothing.
  const regraph = (await run(['graph', '--change', 'add-x', '--root', change, '--groups', 'A=1,2;B=3;C=4,5'])).result
  assert.deepEqual([regraph.ok, regraph.groups.map((g) => [g.letter, g.wave, g.dependsOn]), regraph.pairs], [true, [['A', 1, []], ['B', 1, []], ['C', 1, []]], []])
  // A task the plan lint refuses writes nothing.
  writeFileSync(body, FIX_BODY.replace('**Level:** integration\n', ''))
  const head = gitOut(change, 'rev-parse', 'HEAD')
  const bad = await reopen('no level')
  assert.equal(bad.code, 1)
  assert.match(bad.result.error, /does not pass the plan lint, nothing written: missing-field: Task 6 has no \*\*Level:\*\*/)
  assert.deepEqual([gitOut(change, 'rev-parse', 'HEAD'), clean(), readRecords(change, 'add-x').filter((r) => r.kind === 'apply-round').length], [head, '', 2])
})
