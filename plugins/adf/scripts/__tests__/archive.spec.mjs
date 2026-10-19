// archive.mjs against real git repositories: a host on develop whose main spec `widgets` the
// change add-x modifies, in its own worktree, reviewed PASS, with a ledger whose every item is
// placed. The roles and the clock are injected: the knowledge and forge providers answer as the
// test needs, and the move is dated 2026-10-19.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, UsageError } from '../archive.mjs'
import { run as ingestRun } from '../ingest.mjs'
import { deltaScenarios, handEditedProse, statePath, STEPS, unplaced } from '../lib/archive.mjs'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { appendRecord } from '../lib/ledger.mjs'
import { initRegistry, setDebtRoot } from '../lib/registry.mjs'
import { writeSpecsBase } from '../lib/specs.mjs'
import { create } from '../lib/workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'archive.mjs')
const FIX = join(here, 'fixtures', 'spec-merge', 'modify-remove-add')
const MAIN_SPEC = readFileSync(join(FIX, 'main.md'), 'utf8')
const DELTA = readFileSync(join(FIX, 'delta.md'), 'utf8')
const NOW = new Date('2026-10-19T10:00:00Z')
const TARGET = 'openspec/changes/archive/2026-10-19-add-x'
const NONE = { now: () => NOW, knowledge: () => ({ state: 'none', point: 'knowledge' }), forge: () => ({ state: 'none', point: 'forge' }) }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

function commit(dir, files, message) {
  put(dir, files)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function reviewRecord(sha, { verdict = 'PASS', change = 'add-x', findings = [['F1', 'MEDIUM', 'recorded, non-blocking']] } = {}) {
  return [
    '# AI Code Review Record',
    '',
    `**Change**: \`${change}\``,
    '**Reviewed at**: `2026-10-19 09:00`',
    `**Reviewed commit**: \`${sha}\``,
    `**Verdict**: ${verdict}`,
    '',
    '**Rounds**: `1`',
    '',
    '**Counts**: CRITICAL `0` | HIGH `0` | MEDIUM `1` | LOW `0`',
    '',
    '## Findings',
    '',
    '| # | Round | Severity | Where | Title | Disposition |',
    '|---|---|---|---|---|---|',
    ...findings.map(([id, severity, disposition]) => `| ${id} | 1 | ${severity} | \`src/x.txt:1\` | a title | ${disposition} |`),
    ''
  ].join('\n')
}

const VERIFY = '# Verify\n\n## Apply test record\n\n**Result:** PASS, 12 tests\n\n## Checks run with the developer\n\nnone\n\n## Exercised and not exercised\n\nThe store path ran.\n\nVerdict: PASS\n'

// The host, the change worktree, and the reviewed commit. `delta` maps capability -> delta text;
// `ledger` writes the ledger; `debt` sets the registry's debt root; `specsBase` writes the
// change's specs-base.json, as propose does; `verify` is verify.md's text.
function archiveHost({ delta = { widgets: DELTA }, tasks = '- [x] 1.1 store widgets dry\n', verdict = 'PASS', ledger = placedLedger, debt = null, extra = {}, meta = {}, omit = [], specsBase = true, verify = VERIFY } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-archive-')))
  const root = join(top, 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  put(root, { 'a.txt': 'a\n', 'openspec/specs/widgets/spec.md': MAIN_SPEC, ...extra })
  initRegistry(root, '1.3')
  setBranches(root, { integration: 'develop', protected: [] })
  if (debt) setDebtRoot(root, debt)
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  const wt = create(root, { change: 'add-x', branch: 'feat/add-x', base: 'integration' }).root
  const dir = 'openspec/changes/add-x'
  const files = {
      [`${dir}/.adf.json`]: `${JSON.stringify({ schema: 'adf', schemaVersion: 1, created: '2026-10-15', base: 'develop', ...meta })}\n`,
      [`${dir}/brainstorm.md`]: '# Brainstorm\n',
      [`${dir}/proposal.md`]: '# add-x\n\n## Why\n\nWidgets rot in a wet store.\n\n## What Changes\n\n- dry store\n',
      [`${dir}/design.md`]: '# Design\n',
      ...Object.fromEntries(Object.entries(delta).map(([c, t]) => [`${dir}/specs/${c}/spec.md`, t])),
      [`${dir}/tasks.md`]: tasks,
      [`${dir}/plan.md`]: '# Plan\n',
      [`${dir}/verify.md`]: verify,
      'src/x.txt': 'dry\n'
  }
  for (const name of omit) delete files[`${dir}/${name}`]
  put(wt, files)
  if (specsBase) assert.equal(writeSpecsBase(wt, 'add-x').ok, true)
  const reviewed = commit(wt, {}, 'feat: store widgets dry')
  commit(wt, { [`${dir}/review.md`]: reviewRecord(reviewed, { verdict }) }, 'docs(openspec): review add-x')
  ledger?.(wt)
  return { root, wt, reviewed, dir }
}

// A deviation the flow forced, its debt placed as flow debt, and the recorded finding F1 placed.
function placedLedger(wt) {
  const add = (kind, fields) => appendRecord(wt, 'add-x', kind, fields, { env: {} })
  add('deviation', { rule: 'one worktree per group', reason: 'nested worktrees' })
  add('debt', { what: 'nested group worktrees', reason: 'forced deviation-1' })
  add('resolve', { debt: 'debt-1', as: 'flow-debt', where: 'flow-1' })
  add('resolve', { finding: 'F1', as: 'accepted', where: 'the developer keeps it' })
}

const ARGS = { 'merge-local': ['--yes'] }
const rootOf = (h) => (existsSync(h.wt) ? h.wt : h.root)
const call = (h, args, deps = NONE) => run([...args, '--change', 'add-x', '--root', rootOf(h)], { deps })
const readState = (h) => JSON.parse(readFileSync(statePath(h.root, 'add-x'), 'utf8'))

// Runs `next` and that step until none is left or a step fails.
function drive(h, deps = NONE, args = ARGS) {
  const out = []
  for (let i = 0; i < STEPS.length + 2; i++) {
    const { next } = call(h, ['next'], deps)
    if (!next) break
    const result = call(h, [next, ...(args[next] ?? [])], deps)
    out.push(result)
    if (!result.ok) break
  }
  return out
}

test('a full archive with no forge and no knowledge base: merged, moved, committed, merged locally, removed', () => {
  const h = archiveHost()
  const steps = drive(h)
  assert.deepEqual(steps.map((s) => `${s.step}:${s.state}`), STEPS.map((s) => `${s}:${['ingest', 'mr'].includes(s) ? 'skipped' : 'done'}`))
  const [check, , merge, move, specs, ingest, memory, mr, local, removed] = steps
  assert.equal(check.detail.verdict, 'PASS')
  assert.equal(check.detail.commit, h.reviewed)
  assert.deepEqual(check.detail.warnings, [])
  assert.deepEqual(merge.detail.written, ['openspec/specs/widgets/spec.md'])
  assert.deepEqual(merge.detail.totals, { added: 1, modified: 1, removed: 1, renamed: 0 })
  assert.deepEqual(move.detail, { from: 'openspec/changes/add-x', target: TARGET, ledger: 'copied' })
  assert.deepEqual(specs.detail.files.filter((f) => !f.startsWith(`${TARGET}/`) && !f.startsWith('openspec/changes/add-x/')), ['openspec/specs/widgets/spec.md'])
  assert.ok(specs.detail.files.includes(`${TARGET}/ledger.jsonl`))
  assert.equal(git(h.root, 'log', '-1', '--format=%s', specs.detail.commit), 'docs(specs): archive add-x')
  assert.match(ingest.detail.report, /no knowledge plugin is enabled, so no log entry was written and archive skipped the ingest/)
  assert.deepEqual(memory.detail, { commit: null, files: [] })
  assert.equal(mr.detail.forge, 'none')
  assert.equal(local.detail.merged, true)
  assert.deepEqual({ state: removed.detail.state, branch: removed.detail.branch }, { state: 'removed', branch: 'feat/add-x' })
  assert.equal(existsSync(h.wt), false)
  assert.equal(git(h.root, 'branch', '--show-current'), 'develop')
  assert.equal(git(h.root, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'a --no-ff merge commit')
  assert.match(readFileSync(join(h.root, 'openspec/specs/widgets/spec.md'), 'utf8'), /### Requirement: Track/)
  assert.ok(existsSync(join(h.root, TARGET, 'ledger.jsonl')))
  assert.equal(git(h.root, 'branch', '--list', 'feat/add-x'), 'feat/add-x', 'the branch is kept')
  const report = call(h, ['report'])
  assert.equal(report.complete, true)
  assert.match(report.report, /^## Archive complete: add-x/)
  assert.match(report.report, /- merge: done — added 1, modified 1, removed 1, renamed 0/)
  assert.match(report.report, /- remove: done — worktree .* removed; branch feat\/add-x kept/)
  // Every step again reports done and changes nothing.
  const head = git(h.root, 'rev-parse', 'HEAD')
  const before = readState(h)
  for (const step of STEPS) assert.equal(call(h, [step, ...(ARGS[step] ?? [])]).already, true, step)
  assert.deepEqual(readState(h), before)
  assert.equal(git(h.root, 'rev-parse', 'HEAD'), head)
})

test('a failure injected at each step is recorded, and a re-run resumes from that step alone', () => {
  for (const step of STEPS) {
    const h = archiveHost()
    let fired = false
    const deps = {
      ...NONE,
      fault: (s) => {
        if (s === step && !fired) {
          fired = true
          throw new Error(`injected at ${s}`)
        }
      }
    }
    const first = drive(h, deps)
    const failed = first.at(-1)
    assert.deepEqual([failed.step, failed.state, failed.ok], [step, 'failed', false], step)
    assert.match(failed.refusal, new RegExp(`injected at ${step}`))
    assert.equal(call(h, ['next'], deps).next, step)
    assert.equal(call(h, ['report'], deps).complete, false)
    assert.match(call(h, ['report'], deps).report, new RegExp(`- ${step}: failed — injected at ${step}`))
    const at = STEPS.indexOf(step)
    if (at + 1 < STEPS.length) assert.throws(() => call(h, [STEPS[at + 1]], deps), new RegExp(`waits for ${step}`))
    if (at > 0) {
      const before = readState(h)
      const head = git(rootOf(h), 'rev-parse', 'HEAD')
      assert.equal(call(h, [STEPS[at - 1], ...(ARGS[STEPS[at - 1]] ?? [])], deps).already, true)
      assert.deepEqual(readState(h), before)
      assert.equal(git(rootOf(h), 'rev-parse', 'HEAD'), head)
    }
    const rest = drive(h, deps)
    assert.deepEqual(rest.map((r) => r.step), STEPS.slice(at), step)
    assert.ok(rest.every((r) => r.ok), step)
    assert.equal(call(h, ['report'], deps).complete, true, step)
  }
})

test('check refuses a BLOCKED record: PASS is the only route', () => {
  const h = archiveHost({ verdict: 'BLOCKED' })
  const out = call(h, ['check'])
  assert.equal(out.ok, false)
  assert.equal(out.state, 'failed')
  assert.equal(out.detail.verdict, 'BLOCKED')
  assert.match(out.refusal, /says BLOCKED; archive proceeds on PASS only/)
  assert.equal(call(h, ['next']).next, 'check')
  const cli = spawnSync(process.execPath, [CLI, 'check', '--change', 'add-x', '--root', h.wt], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.equal(JSON.parse(cli.stdout).state, 'failed')
})

test('check refuses code committed after the reviewed commit, naming the change root and the repository root', () => {
  const h = archiveHost()
  commit(h.wt, { 'src/late.txt': 'late\n' }, 'feat: late')
  const out = call(h, ['check'])
  assert.equal(out.ok, false)
  assert.match(out.refusal, /after the reviewed commit .* change files other than openspec\/changes\/add-x\/review\.md/)
  assert.ok(out.refusal.includes(`change root ${h.wt}`) && out.refusal.includes(`repository root ${h.wt}`), out.refusal)
  assert.deepEqual(out.detail.roots, { change: h.wt, repository: h.wt })
})

test('a commit touching only the record passes the staleness scan', () => {
  const h = archiveHost()
  writeFileSync(join(h.wt, h.dir, 'review.md'), `${readFileSync(join(h.wt, h.dir, 'review.md'), 'utf8')}\n`)
  git(h.wt, 'commit', '-q', '-am', 'docs: touch the record')
  assert.equal(call(h, ['check']).ok, true)
})

test('check warns of unchecked tasks and of an artifact not done, but not of one the change skipped', () => {
  const h = archiveHost({ tasks: '- [x] 1.1 a\n- [ ] 1.2 b\n', omit: ['design.md'] })
  const out = call(h, ['check'])
  assert.equal(out.ok, true, out.refusal)
  assert.deepEqual(out.detail.warnings, ['artifact design is ready', '1 task(s) unchecked in tasks.md: 1.2 b'])
  const skipped = archiveHost({ omit: ['design.md'], meta: { skipped: ['design'] } })
  assert.deepEqual(call(skipped, ['check']).detail.warnings, [])
})

test('a missing or uncommitted record, and a reviewed commit not in the history, refuse', () => {
  const h = archiveHost()
  writeFileSync(join(h.wt, h.dir, 'review.md'), reviewRecord('0123456789abcdef0123456789abcdef01234567'))
  assert.match(call(h, ['check']).refusal, /has uncommitted changes/)
  git(h.wt, 'commit', '-q', '-am', 'docs: a record of an unknown commit')
  assert.match(call(h, ['check']).refusal, /the reviewed commit 0123456789abcdef0123456789abcdef01234567 is not in this repository/)
  git(h.wt, 'rm', '-q', `${h.dir}/review.md`)
  git(h.wt, 'commit', '-q', '-m', 'docs: drop the record')
  assert.match(call(h, ['check']).refusal, /review\.md is missing; run \/adf:review add-x/)
})

test('placements lists the unresolved debt, the unplaced findings and the uncited deviations, then passes once all are placed', () => {
  const h = archiveHost({ ledger: null, debt: 'docs/debt' })
  const add = (kind, fields) => appendRecord(h.wt, 'add-x', kind, fields, { env: {} })
  add('deviation', { rule: 'r1', reason: 'forced' })
  add('deviation', { rule: 'r2', reason: 'a judgement' })
  add('deviation', { rule: 'r3', reason: 'none' })
  add('debt', { what: 'w', reason: 'forced deviation-1' })
  add('ruling', { finding: 'deviation-2', decision: 'it stands' })
  add('debt', { what: 'deviation-30 is another', reason: 'r' })
  assert.equal(call(h, ['check']).ok, true)
  const first = call(h, ['placements'])
  assert.equal(first.ok, false)
  assert.deepEqual(first.detail.unplaced.map((i) => `${i.kind} ${i.id}`), ['debt debt-1', 'debt debt-2', 'finding F1', 'deviation deviation-3'])
  assert.match(first.refusal, /4 item\(s\) are not placed: debt-1, debt-2, F1, deviation-3/)
  assert.match(first.detail.unplaced[2].command, /ledger\.mjs resolve --change add-x --finding F1 /)
  add('resolve', { debt: 'debt-1', as: 'flow-debt', where: 'flow-1' })
  add('resolve', { debt: 'debt-2', as: 'tech-debt', where: 'data-1' })
  add('resolve', { finding: 'F1', as: 'follow-up', where: 'add-y' })
  add('ruling', { finding: 'deviation-3', decision: 'kept' })
  put(h.wt, { 'docs/debt/index.md': '# Technical Debt\n', 'docs/debt/data/index.md': '| ID |\n' })
  const second = call(h, ['placements'])
  assert.equal(second.ok, true, second.refusal)
  assert.deepEqual(second.detail.debtFiles, ['docs/debt/data/index.md', 'docs/debt/index.md'])
})

test('unplaced matches a deviation id whole, never as the prefix of another', () => {
  const records = [
    { id: 'deviation-1', kind: 'deviation', rule: 'r', reason: 'x' },
    { id: 'debt-1', kind: 'debt', what: 'see deviation-12', reason: 'r' },
    { id: 'resolve-1', kind: 'resolve', debt: 'debt-1', as: 'accepted', where: 'w' }
  ]
  assert.deepEqual(unplaced(records, [], 'c').map((i) => i.id), ['deviation-1'])
  assert.deepEqual(unplaced([...records, { id: 'debt-2', kind: 'debt', what: 'w', reason: 'forced deviation-1' }, { id: 'resolve-2', kind: 'resolve', debt: 'debt-2', as: 'accepted', where: 'w' }], [], 'c'), [])
  assert.deepEqual(unplaced([], [{ id: 'F1', kind: 'fixed' }, { id: 'F2', kind: 'dismissed' }, { id: 'F3', kind: 'accepted' }], 'c').map((i) => i.id), ['F3'])
})

const NEW_CAP = '## ADDED Requirements\n\n### Requirement: Label\nThe system SHALL label every widget.\n\n#### Scenario: Labelled\n- **WHEN** a widget is built\n- **THEN** it carries a label\n'

test('merge refuses a new capability\'s placeholder Purpose until --purpose gives it, and writes nothing before', () => {
  const h = archiveHost({ delta: { widgets: DELTA, labels: NEW_CAP } })
  drive(h, NONE, {})
  const refused = call(h, ['merge'])
  assert.equal(refused.state, 'failed')
  assert.match(refused.refusal, /the new capability labels needs its Purpose: write it from proposal\.md and pass --purpose <capability>=<file>/)
  assert.equal(git(h.wt, 'status', '--porcelain'), '')
  const purpose = join(h.wt, '..', 'purpose.md')
  writeFileSync(purpose, 'Labels name every widget so the store can find it again without opening a box.\n')
  assert.match(call(h, ['merge', '--purpose', `widgets=${purpose}`]).refusal, /--purpose names widgets, which is not a new capability/)
  const out = call(h, ['merge', '--purpose', `labels=${purpose}`])
  assert.equal(out.ok, true, out.refusal)
  assert.deepEqual(out.detail.written, ['openspec/specs/labels/spec.md', 'openspec/specs/widgets/spec.md'])
  assert.deepEqual(out.detail.purposes, ['labels'])
  assert.match(readFileSync(join(h.wt, 'openspec/specs/labels/spec.md'), 'utf8'), /Labels name every widget/)
  assert.throws(() => run(['merge', '--change', 'add-x', '--purpose', 'labels'], { deps: NONE }), UsageError)
})

test('merge stops on a conflict with its texts for the spec-merge dispatch, and applies the joined resolution files', () => {
  const h = archiveHost()
  commit(h.root, { 'openspec/specs/widgets/spec.md': MAIN_SPEC.replace('The system SHALL store widgets.', 'The system SHALL store widgets on shelves.') }, 'develop moves')
  call(h, ['check'])
  call(h, ['placements'])
  const out = call(h, ['merge'])
  assert.equal(out.state, 'failed')
  assert.match(out.refusal, /conflicts in widgets: dispatch spec-merge for each/)
  const [dispatch] = out.detail.conflicts
  assert.equal(dispatch.name, 'spec-merge widgets')
  assert.equal(dispatch.conflicts[0].requirement, 'Store')
  assert.match(readFileSync(dispatch.conflicts[0].current, 'utf8'), /on shelves/)
  assert.equal(git(h.wt, 'status', '--porcelain'), '')
  const text = '### Requirement: Store\nThe system SHALL store widgets on dry shelves.\n\n#### Scenario: Stored\n- **WHEN** a widget is built\n- **THEN** it is stored\n'
  const a = join(h.wt, '..', 'a.json')
  const b = join(h.wt, '..', 'b.json')
  writeFileSync(a, JSON.stringify([{ capability: 'widgets', requirement: 'Store', text, reason: 'both edits kept' }]))
  writeFileSync(b, '[]')
  const merged = call(h, ['merge', '--resolutions', a, '--resolutions', b])
  assert.equal(merged.ok, true, merged.refusal)
  assert.deepEqual(merged.detail.resolved, ['widgets: Store'])
  assert.match(readFileSync(join(h.wt, 'openspec/specs/widgets/spec.md'), 'utf8'), /on dry shelves/)
})

test('commit-specs refuses an uncommitted file it did not write and commits only its own paths', () => {
  const h = archiveHost()
  for (const step of STEPS.slice(0, 4)) assert.equal(call(h, [step]).ok, true, step)
  put(h.wt, { 'openspec/changes/add-y/notes.md': 'another change\n', 'src/wip.txt': 'not archive scope\n' })
  const out = call(h, ['commit-specs'])
  assert.equal(out.ok, false)
  assert.match(out.refusal, /uncommitted files archive did not write: openspec\/changes\/add-y\/notes\.md;/)
  rmSync(join(h.wt, 'openspec/changes/add-y'), { recursive: true })
  const done = call(h, ['commit-specs'])
  assert.equal(done.ok, true, done.refusal)
  assert.equal(done.detail.files.includes('src/wip.txt'), false)
  assert.equal(git(h.wt, 'status', '--porcelain'), '?? src/wip.txt')
})

test('ingest writes the log through the knowledge role and commit-memory commits the pages, the log and the debt files only', () => {
  const MEM = '.claude/memory'
  const h = archiveHost({
    debt: 'docs/debt',
    extra: { [`${MEM}/index.md`]: '# Index\n', [`${MEM}/log.md`]: '# Log\n', [`${MEM}/entities/x.md`]: '# X\n\nThe parser lives in src/old.txt.\n' }
  })
  const context = { state: 'done', plugin: 'memory', index: `${MEM}/index.md`, instructions: { ingest: '/p/ingest.md' }, paths: [`${MEM}/**`], log: [`${MEM}/log.md`, `${MEM}/log-archive/**`] }
  const logged = []
  const deps = {
    ...NONE,
    knowledge: () => context,
    knowledgeLog: (input) => {
      logged.push(input)
      writeFileSync(join(h.wt, MEM, 'log.md'), `# Log\n\n## [2026-10-19 10:00] ingest | ${input.title} | T\n- ${input.bullets[0]}\n`)
      return { state: 'done', path: `${MEM}/log.md`, entry: `## [2026-10-19 10:00] ingest | ${input.title} | T\n`, rotated: [] }
    }
  }
  call(h, ['check'], deps)
  put(h.wt, { 'docs/debt/index.md': '# Technical Debt\n' })
  assert.deepEqual(call(h, ['placements'], deps).detail.debtFiles, ['docs/debt/index.md'])
  for (const step of ['merge', 'move', 'commit-specs']) assert.equal(call(h, [step], deps).ok, true, step)
  assert.equal(git(h.wt, 'status', '--porcelain', '--untracked-files=all'), '?? docs/debt/index.md', 'the debt files wait for the memory commit')
  assert.match(call(h, ['ingest'], deps).refusal, /ingest needs --reply: run ingest\.mjs stale --change add-x/)
  const stale = ingestRun(['stale', '--change', 'add-x', '--root', h.wt], { knowledge: () => context })
  assert.equal(stale.state, 'done')
  put(h.wt, { [`${MEM}/entities/widgets.md`]: '# Widgets\n\nWidgets are stored dry.\n' })
  const reply = join(h.wt, '..', 'reply.json')
  writeFileSync(reply, JSON.stringify({ nothingLearned: false, pages: [{ path: `${MEM}/entities/widgets.md`, why: 'the dry store' }], stale: [], invariant: 'a widget is stored dry', likelyMistake: 'storing it wet', log: { title: 'Dry widget store', bullets: ['widgets are stored dry'] } }))
  put(h.wt, { 'docs/stray.md': 'not in scope\n', [`${MEM}/entities/stray.md`]: '# Stray\n' })
  const refused = call(h, ['ingest', '--reply', reply], deps)
  assert.equal(refused.state, 'failed')
  assert.match(refused.refusal, /\.claude\/memory\/entities\/stray\.md changed, but the reply does not list it/)
  rmSync(join(h.wt, MEM, 'entities', 'stray.md'))
  const ingest = call(h, ['ingest', '--reply', reply], deps)
  assert.equal(ingest.ok, true, ingest.refusal)
  assert.deepEqual(ingest.detail.paths, [`${MEM}/entities/widgets.md`, `${MEM}/log.md`])
  assert.deepEqual(logged, [{ type: 'ingest', title: 'Dry widget store', bullets: ['widgets are stored dry'] }])
  assert.equal(call(h, ['ingest', '--reply', reply], deps).already, true)
  assert.equal(logged.length, 1, 'a done ingest writes no second log entry')
  put(h.wt, { [`${MEM}/concepts/late.md`]: '# Late\n' })
  assert.match(call(h, ['commit-memory'], deps).refusal, /uncommitted files archive did not write: \.claude\/memory\/concepts\/late\.md;/)
  rmSync(join(h.wt, MEM, 'concepts'), { recursive: true })
  const memory = call(h, ['commit-memory'], deps)
  assert.equal(memory.ok, true, memory.refusal)
  assert.deepEqual(memory.detail.files, ['.claude/memory/entities/widgets.md', '.claude/memory/log.md', 'docs/debt/index.md'])
  assert.equal(git(h.wt, 'log', '-1', '--format=%s'), 'docs(memory): ingest what add-x taught')
  assert.equal(git(h.wt, 'status', '--porcelain'), '?? docs/stray.md')
})

test('mr-input gathers the tasks, the Why, the scenarios and the run evidence', () => {
  const h = archiveHost()
  const out = call(h, ['mr-input'])
  assert.deepEqual(out.tasks, { done: ['1.1 store widgets dry'], open: [] })
  assert.equal(out.why, 'Widgets rot in a wet store.')
  assert.deepEqual(out.scenarios.map((s) => `${s.requirement}/${s.scenario}`), ['Track/Tracked', 'Store/Stored', 'Store/Kept dry'])
  assert.deepEqual(out.scenarios[0], { capability: 'widgets', requirement: 'Track', scenario: 'Tracked', given: [], when: ['a widget moves'], then: ['its place is recorded'] })
  assert.equal(out.evidence.verdict, 'PASS')
  assert.equal(out.evidence.sections[0].text, '**Result:** PASS, 12 tests')
  assert.equal(out.bodyFile, join(h.root, '.superpowers', 'sdd', 'add-x', 'archive', 'merge-request.md'))
  assert.deepEqual(deltaScenarios('## ADDED Requirements\n\n### Requirement: R\nx\n\n#### Scenario: S\n- **GIVEN** g\n- **WHEN** w\n- **AND** w2\n- **THEN** t\n- **AND** t2\n', 'c')[0], { capability: 'c', requirement: 'R', scenario: 'S', given: ['g'], when: ['w', 'w2'], then: ['t', 't2'] })
})

test('mr finalizes through the forge role; degraded keeps the fallback and re-runs; done skips the local merge', () => {
  const h = archiveHost()
  let answer = { state: 'degraded', plugin: 'gitlab', hint: 'glab is not logged in', inputFile: '/tmp/finalize.json', fallback: ['node forge.mjs finalize --input-file /tmp/finalize.json'] }
  const calls = []
  const deps = { ...NONE, forge: (op, input) => (calls.push({ op, input }), answer) }
  for (const step of STEPS.slice(0, 7)) assert.equal(call(h, [step], deps).ok, true, step)
  const body = join(h.root, '.superpowers', 'sdd', 'add-x', 'archive', 'merge-request.md')
  const before = readState(h)
  const held = call(h, ['mr'], deps)
  assert.deepEqual([held.ok, held.state, held.bodyFile, held.next], [true, 'pending', body, 'mr'])
  assert.match(held.waiting, /run archive\.mjs mr-input --change add-x, write the body from it to .*merge-request\.md, then archive\.mjs mr --change add-x --body /)
  assert.deepEqual(readState(h), before, 'a held mr records nothing')
  assert.equal(call(h, ['next'], deps).next, 'mr')
  writeFileSync(body, '## What\n\n- dry\n\n## Why\n\nrot\n\n## QA\n\n1. store one\n')
  const degraded = call(h, ['mr', '--body', body, '--summary', 'widgets: store dry'], deps)
  assert.equal(degraded.state, 'degraded')
  assert.equal(degraded.ok, true)
  assert.deepEqual(degraded.detail.fallback, ['node forge.mjs finalize --input-file /tmp/finalize.json'])
  const finalize = calls.find((c) => c.op === 'finalize').input
  assert.deepEqual({ ...finalize, body: undefined }, { body: undefined, change: 'add-x', branch: 'feat/add-x', base: 'develop', protected: ['develop'], title: 'feat(widgets): store dry' })
  const report = call(h, ['report'], deps)
  assert.equal(report.complete, false)
  assert.match(report.report, /The merge request is not ready/)
  answer = { state: 'done', plugin: 'gitlab', url: 'https://g/mr/1' }
  const done = call(h, ['mr', '--body', body, '--summary', 'widgets: store dry'], deps)
  assert.equal(done.state, 'done')
  assert.equal(done.detail.url, 'https://g/mr/1')
  const local = call(h, ['merge-local'], deps)
  assert.equal(local.state, 'skipped')
})

test('a refused finalize fails the step', () => {
  const h = archiveHost()
  const deps = { ...NONE, forge: (op) => (op === 'check' ? { state: 'done', plugin: 'gitlab' } : { state: 'refused', plugin: 'gitlab', error: 'Description rejected' }) }
  for (const step of STEPS.slice(0, 7)) call(h, [step], deps)
  const body = join(h.wt, '..', 'body.md')
  writeFileSync(body, 'x\n')
  const out = call(h, ['mr', '--body', body, '--title', 'feat: x'], deps)
  assert.equal(out.state, 'failed')
  assert.match(out.refusal, /Merge request: refused; Description rejected/)
})

test('merge-local waits for the yes, refuses a main checkout off its base or dirty with the commands, and --no records the choice', () => {
  const h = archiveHost()
  for (const step of STEPS.slice(0, 8)) assert.equal(call(h, [step]).ok, true, step)
  const waiting = call(h, ['merge-local'])
  assert.equal(waiting.state, 'pending')
  assert.deepEqual(waiting.commands, [`git -C ${h.root} checkout develop`, `git -C ${h.root} merge --no-ff feat/add-x`])
  assert.equal(call(h, ['next']).next, 'merge-local')
  git(h.root, 'checkout', '-q', '-b', 'other')
  const off = call(h, ['merge-local', '--yes'])
  assert.equal(off.state, 'failed')
  assert.match(off.refusal, /has other checked out, not develop; nothing was merged\. Run: git -C .* checkout develop && git -C .* merge --no-ff feat\/add-x/)
  git(h.root, 'checkout', '-q', 'develop')
  writeFileSync(join(h.root, 'a.txt'), 'dirty\n')
  assert.match(call(h, ['merge-local', '--yes']).refusal, /has uncommitted changes; nothing was merged/)
  git(h.root, 'checkout', '-q', '--', 'a.txt')
  const declined = call(h, ['merge-local', '--no'])
  assert.equal(declined.state, 'skipped')
  assert.equal(declined.detail.declined, true)
  assert.equal(git(h.root, 'rev-list', '--count', 'develop'), '1', 'nothing merged')
  assert.equal(call(h, ['remove']).detail.state, 'removed')
})

test('check refuses a stale or missing spec base entry, and warns of a change with no specs-base.json', () => {
  const stale = archiveHost()
  const file = join(stale.wt, stale.dir, 'specs-base.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const [requirement] = Object.keys(data.capabilities.widgets)
  data.capabilities.widgets[requirement].delta = '0'.repeat(64)
  commit(stale.wt, { [`${stale.dir}/specs-base.json`]: `${JSON.stringify(data, null, 2)}\n` }, 'docs: a base for another delta')
  commit(stale.wt, { [`${stale.dir}/review.md`]: reviewRecord(git(stale.wt, 'rev-parse', 'HEAD')) }, 'docs(openspec): review add-x again')
  const refused = call(stale, ['check'])
  assert.equal(refused.state, 'failed')
  assert.match(refused.refusal, new RegExp(`a base taken for another delta text for widgets "${requirement}".*the merge must not use a base the delta was not written against`))
  assert.deepEqual(refused.detail.specsBase.stale, [{ capability: 'widgets', requirement }])
  delete data.capabilities.widgets[requirement]
  commit(stale.wt, { [`${stale.dir}/specs-base.json`]: `${JSON.stringify(data, null, 2)}\n` }, 'docs: drop a base')
  commit(stale.wt, { [`${stale.dir}/review.md`]: reviewRecord(git(stale.wt, 'rev-parse', 'HEAD')) }, 'docs(openspec): review add-x again')
  assert.deepEqual(call(stale, ['check']).detail.specsBase.missing, [{ capability: 'widgets', requirement }])
  const none = archiveHost({ specsBase: false })
  const out = call(none, ['check'])
  assert.equal(out.ok, true, out.refusal)
  assert.deepEqual(out.detail.warnings, ['no openspec/changes/add-x/specs-base.json: the change was made before the spec base snapshot, so the merge\'s three-way check falls back to the merge base, which a rebase moves'])
})

test('the report names the capabilities verify.md lists as hand-edited and says the corpus lint is due', () => {
  assert.deepEqual(handEditedProse('**Hand-edited capability prose:** none\n'), [])
  assert.deepEqual(handEditedProse('**Hand-edited capability prose:** not stated in the c4 section\n'), [])
  assert.deepEqual(handEditedProse('# Verify\n'), [])
  assert.deepEqual(handEditedProse('**Hand-edited capability prose:**\n\n- widgets: Purpose reworded\n- labels: scope\n\n**Removal accounting:** none\n'), ['widgets: Purpose reworded', 'labels: scope'])
  const h = archiveHost({ verify: VERIFY.replace('## Apply test record', '**Hand-edited capability prose:** widgets: the Purpose names the dry store\n\n## Apply test record') })
  assert.deepEqual(call(h, ['check']).detail.handEdited, ['widgets: the Purpose names the dry store'])
  const out = call(h, ['report'])
  assert.deepEqual(out.handEdited, ['widgets: the Purpose names the dry store'])
  assert.match(out.report, /Corpus lint due: verify\.md lists hand-edited capability prose \(widgets: the Purpose names the dry store\); run the spec corpus lint/)
  assert.doesNotMatch(call(archiveHost(), ['report']).report, /Corpus lint/)
})

test('a failed git read refuses the guard that reads it, and an empty branch read never passes as a branch', () => {
  const h = archiveHost()
  const rel = git(h.wt, 'rev-parse', '--git-path', 'index')
  const index = rel.startsWith('/') ? rel : join(h.wt, rel)
  writeFileSync(index, 'not an index\n')
  const out = call(h, ['check'])
  assert.equal(out.state, 'failed')
  assert.match(out.refusal, /^git failed to read the status of the review record \(.*\); check that .* is a git working tree and run again$/s)
  rmSync(index)
  git(h.wt, 'reset', '-q')
  assert.equal(call(h, ['check']).ok, true)
  for (const step of STEPS.slice(1, 7)) assert.equal(call(h, [step]).ok, true, step)
  git(h.wt, 'checkout', '-q', '--detach')
  const body = join(h.wt, '..', 'body.md')
  writeFileSync(body, 'x\n')
  const deps = { ...NONE, forge: () => ({ state: 'done', plugin: 'gitlab' }) }
  const detached = call(h, ['mr', '--body', body, '--title', 'feat: x'], deps)
  assert.equal(detached.state, 'failed')
  assert.match(detached.refusal, /HEAD is detached; check out the change branch in the worktree/)
})

test('the CLI: usage errors exit 2, a step out of order exits 1, a pass exits 0', () => {
  const h = archiveHost()
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: h.wt })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  assert.equal(cli('check').code, 2)
  assert.equal(cli('check', '--change', 'add-x', '--yes').code, 2)
  assert.equal(cli('merge-local', '--change', 'add-x', '--yes', '--no').code, 2)
  const early = cli('merge', '--change', 'add-x')
  assert.equal(early.code, 1)
  assert.match(early.out.error, /merge waits for check, placements; run archive\.mjs next/)
  const next = cli('next', '--change', 'add-x')
  assert.deepEqual([next.code, next.out.next, next.out.state], [0, 'check', 'pending'])
  assert.equal(cli('check', '--change', 'add-x').code, 0)
  assert.equal(cli('state', '--change', 'add-x').out.steps.check.state, 'done')
  assert.match(cli('check', '--change', 'Add X').out.error, /not kebab-case/)
})
