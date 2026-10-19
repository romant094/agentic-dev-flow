// retro.mjs against real git repositories: a host on develop with a bare remote, two archived
// changes merged, `one` with its record and attempts log and `two` with its record. The roles and
// the clock are injected: the knowledge, forge and upstream providers answer as the test needs,
// and the Claude Code home is an empty directory, so nothing reads the developer's own plugins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, UsageError } from '../retro.mjs'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { fromV1, validateRecord } from '../lib/metrics.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { localMerge, MergeRefusal } from '../lib/local-merge.mjs'
import { renderRetro, retroDocument } from '../lib/retro-render.mjs'
import { STEPS, statePath } from '../lib/retro-run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'retro.mjs')
const ARCHIVE = 'openspec/changes/archive'
const DATE = '2026-10-19'
const ID = `${DATE}-window`
const NOW = new Date('2026-10-19T12:00:00Z')
const JSON_FILE = `.adf/retro/${ID}.json`
const MD_FILE = `.adf/retro/${ID}.md`
const TITLE = `docs(retro): window retrospective ${DATE}`
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'adf-retro-cli-home-')))
const NONE = {
  now: () => NOW,
  home: HOME,
  knowledgePaths: () => ({ state: 'none', paths: [] }),
  forge: () => ({ state: 'none', point: 'forge' }),
  upstream: () => ({ state: 'none', point: 'upstream' })
}

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

// A branch from develop with the files, merged with a no-fast-forward merge commit.
function merge(root, branch, files, at) {
  g(root, ['checkout', '-q', '-b', branch, 'develop'])
  write(root, files)
  g(root, ['add', '.'])
  g(root, ['commit', '-q', '-m', 'work'], at)
  g(root, ['checkout', '-q', 'develop'])
  g(root, ['merge', '-q', '--no-ff', '-m', `Merge branch '${branch}' into 'develop'`, branch], at)
}

// A schemaVersion 2 record with the groups the retro input reads.
function record(change, tokens = 100) {
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
  const out = { ...r, generator: { plugin: 'adf', version: '0.11.0', plugins: {} }, sources: { ...sources, coverage: { ...sources.coverage, generator: 'record' } } }
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(out))), [], 'the record fixture validates')
  return out
}

const ATTEMPTS = [
  { name: 'T1 impl', at: '2026-10-01T10:10:00Z', event: 'valid', result: { status: 'DONE' } },
  { name: 'T1 review', at: '2026-10-01T10:20:00Z', event: 'valid', result: { result: 'fix' } }
]

// The host checkout on develop, pushed to a bare remote, with `one` and `two` archived and merged.
// `one` also writes three lines into the knowledge base, docs/kb/.
function host() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-retro-cli-')))
  const remote = join(top, 'remote.git')
  const root = join(top, 'host')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', remote])
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  g(root, ['config', 'user.email', 't@example.com'])
  g(root, ['config', 'user.name', 'T'])
  initRegistry(root, '1.4')
  setBranches(root, { integration: 'develop', protected: [] })
  ignoreLocalDirs(root)
  write(root, { 'src/a.txt': 'a\n' })
  g(root, ['add', '.'])
  g(root, ['commit', '-q', '-m', 'init'], '2026-09-01T10:00:00Z')
  merge(
    root,
    'feat/one',
    {
      [`${ARCHIVE}/2026-10-01-one/tasks.md`]: '- [x] 1.1 a\n- [x] 1.2 b\n',
      [`${ARCHIVE}/2026-10-01-one/metrics.json`]: `${JSON.stringify(record('one', 300))}\n`,
      [`${ARCHIVE}/2026-10-01-one/attempts.jsonl`]: `${ATTEMPTS.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'src/one.txt': 'one\n',
      'docs/kb/one.md': 'a\nb\nc\n'
    },
    '2026-10-02T10:00:00Z'
  )
  merge(root, 'feat/two', { [`${ARCHIVE}/2026-10-05-two/tasks.md`]: '- [x] 1.1 a\n', [`${ARCHIVE}/2026-10-05-two/metrics.json`]: `${JSON.stringify(record('two'))}\n`, 'src/two.txt': 'two\n' }, '2026-10-06T10:00:00Z')
  g(root, ['remote', 'add', 'origin', remote])
  g(root, ['push', '-q', '-u', 'origin', 'develop'])
  return { top, remote, root, wt: join(root, '.claude', 'worktrees', `retro-${ID}`) }
}

const call = (h, args, deps = NONE) => run([...args, '--root', h.root], { cwd: h.root, deps })

// A reply that passes every check: one finding on `one`, every waiting item decided.
function validReply(inp) {
  return {
    role: 'retro',
    nothingFound: false,
    findings: [
      {
        id: 'R1',
        title: 'An implementation reported done before its review passed',
        class: 'premature-done',
        changes: ['one'],
        evidence: ['changes.one.signals.prematureDone'],
        cost: 'changes.one.values.cost.tokens',
        caughtWhere: 'the task test run',
        plugin: 'adf',
        body: 'T1 was reported done and its review sent it back.'
      }
    ],
    decisions: inp.waiting.map((w) => ({ item: w.id, decision: 'wait', basis: [`aggregates.${w.metrics[0]}.n`], reason: 'Two changes cannot tell a trend from noise.' })),
    removalCandidate: { name: 'none', reason: 'Every layer fired in this window.', basis: [] },
    improvements: [{ what: 'Run the task tests before DONE', file: 'schema/prompts/implementer.md', expectedEffect: 'fewer review rounds', saving: 'changes.one.values.cost.tokens' }]
  }
}

function writeReply(win, reply) {
  const file = win.detail.dispatch.replyFile
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(reply))
  return file
}

const inputOf = (win) => JSON.parse(readFileSync(win.detail.inputFile, 'utf8'))

// start, window, a valid reply, render and record: the retrospective committed on its branch.
function recorded(h, deps = NONE) {
  const steps = [call(h, ['start', '--date', DATE], deps), call(h, ['window'], deps)]
  const win = steps[1]
  steps.push(call(h, ['reply', '--file', writeReply(win, validReply(inputOf(win)))], deps), call(h, ['render'], deps), call(h, ['record'], deps))
  for (const s of steps) assert.equal(s.ok, true, `${s.step}: ${s.refusal ?? ''}`)
  return { win, steps }
}

test('a window retrospective with a forge: own worktree, checked reply, rendered report, one commit, a non-draft MR with no CI, never merged', () => {
  const h = host()
  const calls = []
  const deps = { ...NONE, knowledgePaths: () => ({ state: 'done', paths: ['docs/kb/**'] }), forge: (op, input) => (calls.push({ op, input }), { state: 'done', plugin: 'gitlab', url: 'https://forge/mr/7', number: 7 }) }
  const developBefore = g(h.root, ['rev-parse', 'develop'])

  const start = call(h, ['start', '--date', DATE], deps)
  assert.deepEqual([start.ok, start.id, start.date, start.step, start.state, start.mode, start.next], [true, ID, DATE, 'start', 'done', 'window', 'window'])
  assert.equal(start.detail.fetch.fetched, true)
  assert.equal(start.detail.worktree, h.wt)
  assert.deepEqual([start.detail.branch, start.detail.base, start.detail.baseRef], [`chore/retro/${ID}`, 'develop', 'origin/develop'])
  assert.equal(g(h.wt, ['branch', '--show-current']), `chore/retro/${ID}`)
  assert.equal(g(h.root, ['branch', '--show-current']), 'develop', 'the main checkout is never switched')
  assert.ok(existsSync(statePath(h.root, ID)), 'the state is in the main checkout')

  const win = call(h, ['window'], deps)
  assert.equal(win.ok, true, win.refusal)
  assert.deepEqual(win.detail.changes, ['one', 'two'])
  assert.deepEqual(win.detail.knowledge, { state: 'done', excluded: ['docs/kb/**'] })
  const sidecar = JSON.parse(readFileSync(win.detail.sidecar, 'utf8'))
  assert.equal(sidecar.changes[0].git.diffLines, 1, "the knowledge base's three lines are not the change's work")
  assert.equal(sidecar.ref, 'origin/develop')
  const plan = win.detail.dispatch
  assert.deepEqual([plan.name, plan.agent, plan.worktree, plan.attempt], [`retro ${ID}`, 'adf:architecture', h.wt, 1])
  assert.equal(plan.inputFile, join(h.wt, '.superpowers', 'retro', ID, 'input.json'))
  const prompt = readFileSync(plan.promptFile, 'utf8')
  assert.match(prompt, new RegExp(`^You are dispatched as \`retro ${ID}\`, at the architecture capability level`))
  assert.ok(prompt.includes(plan.inputFile) && prompt.includes(plan.replyFile))
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/)

  const reply = call(h, ['reply', '--file', writeReply(win, validReply(inputOf(win)))], deps)
  assert.deepEqual([reply.ok, reply.state, reply.detail.next], [true, 'done', 'proceed'])
  assert.deepEqual(reply.detail.result.findings[0].cost, { key: 'changes.one.values.cost.tokens', value: 300 })

  const render = call(h, ['render'], deps)
  assert.deepEqual(render.detail.files, [JSON_FILE, MD_FILE])
  const doc = JSON.parse(readFileSync(join(h.wt, JSON_FILE), 'utf8'))
  assert.deepEqual(doc.cutoff, sidecar.cutoff, 'the committed sidecar anchors the next window')
  assert.deepEqual(doc.findings.map((f) => [f.id, f.version]), [['R1', JSON.parse(readFileSync(join(here, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version]])
  assert.equal(doc.nothingFound, false)
  assert.equal(doc.removalCandidate.kind, 'none')
  const md = readFileSync(join(h.wt, MD_FILE), 'utf8')
  assert.match(md, /^# Window retrospective 2026-10-19\n/)
  assert.match(md, /- Records: 2 of 2 changes/)
  assert.match(md, /### R1: An implementation reported done before its review passed/)
  assert.match(md, /- Cost: `changes\.one\.values\.cost\.tokens` = 300/)
  assert.match(md, /1\. Run the task tests before DONE: `schema\/prompts\/implementer\.md`\. Expected effect: fewer review rounds\. Saving: `changes\.one\.values\.cost\.tokens` = 300\./)
  assert.match(md, /\| one \| 2026-10-02 \| 2 \| 1 \| 0 \| record \|/)

  const rec = call(h, ['record'], deps)
  assert.equal(rec.ok, true, rec.refusal)
  assert.equal(g(h.wt, ['log', '-1', '--format=%s']), TITLE)
  assert.deepEqual(g(h.wt, ['show', '--name-only', '--format=', 'HEAD']).split('\n'), [JSON_FILE, MD_FILE])
  assert.equal(g(h.wt, ['status', '--porcelain']), '', 'the input, replies and prompt stay out of the tree')

  const pub = call(h, ['publish'], deps)
  assert.deepEqual([pub.ok, pub.state, pub.next], [true, 'done', 'file'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].op, 'open')
  assert.deepEqual(calls[0].input, { ci: false, change: `retro-${ID}`, branch: `chore/retro/${ID}`, base: 'develop', protected: ['develop'], title: TITLE, draft: false })
  assert.equal(pub.detail.report, 'Merge request: https://forge/mr/7 (opened, ready to merge)')
  assert.deepEqual([pub.detail.url, pub.detail.ci, pub.detail.draft], ['https://forge/mr/7', false, false])
  assert.equal(g(h.root, ['rev-parse', 'develop']), developBefore, 'never merged with a forge')

  const again = call(h, ['publish'], deps)
  assert.deepEqual([again.already, again.state], [true, 'done'])
  assert.equal(calls.length, 1, 'a done publish opens nothing again')
  assert.equal(call(h, ['start', '--date', DATE], deps).already, true)
  const state = call(h, ['state'], deps)
  assert.deepEqual([state.id, state.date, state.mode, state.next], [ID, DATE, 'window', 'file'])
})

test('without a forge, publish holds for the developer, and --yes merges locally with nothing pushed', () => {
  const h = host()
  recorded(h)
  const developBefore = g(h.root, ['rev-parse', 'develop'])
  const held = call(h, ['publish'])
  assert.deepEqual([held.ok, held.state, held.pending, held.forge, held.next], [true, 'pending', true, 'none', 'publish'])
  assert.match(held.report, /no forge plugin is enabled/)
  assert.deepEqual(held.commands, [`git -C ${h.root} checkout develop`, `git -C ${h.root} merge --no-ff chore/retro/${ID}`])
  assert.equal(g(h.root, ['rev-parse', 'develop']), developBefore, 'nothing merged without the yes')
  assert.equal(JSON.parse(readFileSync(statePath(h.root, ID), 'utf8')).steps.publish.state, 'pending')

  const merged = call(h, ['publish', '--yes'])
  assert.deepEqual([merged.ok, merged.state, merged.detail.forge, merged.detail.merged], [true, 'done', 'none', true])
  assert.equal(g(h.root, ['rev-list', '--parents', '-1', 'develop']).split(' ').length, 3, 'a --no-ff merge commit')
  assert.ok(existsSync(join(h.root, JSON_FILE)))
  assert.equal(g(h.root, ['rev-parse', 'origin/develop']), developBefore, 'nothing pushed')
  assert.equal(g(h.root, ['rev-parse', '--verify', `chore/retro/${ID}`]).length, 40, 'the branch is kept')
  assert.equal(call(h, ['publish', '--yes']).already, true)
})

test('file: with an upstream provider, what would be filed until the yes, then filed; findings named by id', () => {
  const h = host()
  const calls = []
  const deps = { ...NONE, upstream: (op, input) => (calls.push({ op, input }), op === 'check' ? { state: 'done', plugin: 'adf-maintainer', tool: 'ready' } : { state: 'done', plugin: 'adf-maintainer', issues: [{ finding: 'R1', number: 12, url: 'https://t/12' }] }) }
  recorded(h, deps)
  // file needs the committed sidecar, not its merge: publish has not run.
  const held = call(h, ['file'], deps)
  assert.deepEqual([held.ok, held.state, held.pending], [true, 'pending', true])
  assert.deepEqual(held.would, { report: JSON_FILE, findings: ['R1'] })
  assert.deepEqual(calls.map((c) => c.op), ['check'], 'nothing filed without the yes')

  const unknown = call(h, ['file', '--yes', '--findings', 'R9'], deps)
  assert.equal(unknown.ok, false)
  assert.match(unknown.refusal, /R9 is not a finding of this retrospective; its findings: R1/)

  const filed = call(h, ['file', '--yes', '--findings', 'R1'], deps)
  assert.deepEqual([filed.ok, filed.state], [true, 'done'])
  assert.deepEqual(calls.at(-1), { op: 'file', input: { report: JSON_FILE, findings: ['R1'] } })
  assert.equal(filed.detail.text, 'Upstream: filed R1 as https://t/12')
  assert.equal(call(h, ['file', '--yes'], deps).already, true)
})

test('file with no upstream provider: skipped, the findings stay in the sidecar', () => {
  const h = host()
  recorded(h)
  const out = call(h, ['file'])
  assert.deepEqual([out.ok, out.state, out.detail.upstream], [true, 'skipped', 'none'])
  assert.equal(out.detail.text, 'Upstream: none; no upstream plugin is enabled, so nothing was filed and the findings stay in the retrospective sidecar.')
  assert.deepEqual(JSON.parse(readFileSync(join(h.wt, JSON_FILE), 'utf8')).findings.map((f) => f.id), ['R1'])
})

test('a failure injected at a step is recorded, the steps after it wait, and a re-run resumes from it', () => {
  const h = host()
  let failing = true
  const deps = { ...NONE, fault: (step) => {
    if (step === 'record' && failing) {
      failing = false
      throw new Error('injected')
    }
  } }
  const { steps } = (() => {
    const out = [call(h, ['start', '--date', DATE], deps), call(h, ['window'], deps)]
    out.push(call(h, ['reply', '--file', writeReply(out[1], validReply(inputOf(out[1])))], deps), call(h, ['render'], deps))
    return { steps: out }
  })()
  assert.ok(steps.every((s) => s.ok))
  const failed = call(h, ['record'], deps)
  assert.deepEqual([failed.ok, failed.state, failed.refusal, failed.next], [false, 'failed', 'injected', 'record'])
  assert.throws(() => call(h, ['publish'], deps), /publish waits for record; run retro\.mjs record --id 2026-10-19-window first/)
  assert.equal(call(h, ['state'], deps).next, 'record')
  const resumed = call(h, ['record'], deps)
  assert.deepEqual([resumed.ok, resumed.state, resumed.next], [true, 'done', 'publish'])
  assert.equal(g(h.wt, ['log', '-1', '--format=%s']), TITLE)
  assert.equal(call(h, ['render'], deps).already, true, 'a done step is not run again')
  assert.deepEqual(Object.keys(call(h, ['state'], deps).steps), STEPS)
})

test('a commit made by a run that failed before saving its state is adopted, not made twice', () => {
  const h = host()
  const out = [call(h, ['start', '--date', DATE]), call(h, ['window'])]
  out.push(call(h, ['reply', '--file', writeReply(out[1], validReply(inputOf(out[1])))]), call(h, ['render']))
  g(h.wt, ['add', JSON_FILE, MD_FILE])
  g(h.wt, ['commit', '-q', '-m', TITLE])
  const head = g(h.wt, ['rev-parse', 'HEAD'])
  const rec = call(h, ['record'])
  assert.deepEqual([rec.ok, rec.detail.commit, rec.detail.adopted], [true, head, true])
  assert.equal(g(h.wt, ['rev-parse', 'HEAD']), head)
})

test('an invalid reply is retried once; a second stops the retrospective and nothing after it runs', () => {
  const h = host()
  call(h, ['start', '--date', DATE])
  const win = call(h, ['window'])
  const inp = inputOf(win)
  const bad = writeReply(win, { ...validReply(inp), decisions: [] })
  const first = call(h, ['reply', '--file', bad])
  assert.deepEqual([first.ok, first.state, first.detail.next, first.detail.mode], [false, 'failed', 'retry', 'resume'])
  assert.match(first.refusal, /retry once, the agent resumed/)
  // The retry is a dispatch of its own, recorded by reply, so the metrics count both.
  assert.deepEqual([first.detail.dispatch.name, first.detail.dispatch.attempt, first.detail.dispatch.mode], [`retro ${ID}`, 2, 'resume'])
  assert.equal(first.detail.dispatch.promptFile, win.detail.dispatch.promptFile)
  assert.equal(first.detail.dispatch.replyFile, join(h.wt, '.superpowers', 'retro', ID, 'replies', `retro-${ID}-2.json`))
  const log = () => readFileSync(join(h.wt, '.superpowers', 'retro', ID, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event)
  assert.deepEqual(log(), ['dispatch', 'invalid', 'dispatch'])
  assert.ok(first.detail.errors.some((e) => /is not answered/.test(e)))
  const second = call(h, ['reply', '--file', join(h.root, 'missing.json')])
  assert.deepEqual([second.ok, second.detail.next, second.detail.dispatch], [false, 'stop', undefined])
  assert.match(second.refusal, /the retrospective stops/)
  assert.deepEqual(log(), ['dispatch', 'invalid', 'dispatch', 'invalid'], 'a stop records no further dispatch')
  const good = writeReply(win, validReply(inp))
  const third = call(h, ['reply', '--file', good])
  assert.deepEqual([third.ok, third.detail.next], [false, 'stop'])
  assert.match(third.refusal, /stopped after 2 invalid replies/)
  assert.throws(() => call(h, ['render']), /render waits for reply/)
})

test('wrong mode arguments are usage errors, exit 2; retros of several modes share a date, each by its id', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'adf-retro-cli-usage-')))
  for (const args of [
    ['start', '--mode', 'change'],
    ['start', '--from', '2026-10-01'],
    ['start', '--mode', 'window', '--change', 'one'],
    ['start', '--change', 'one', '--from', '2026-10-01', '--to', '2026-10-02'],
    ['start', '--from', '2026-10-05', '--to', '2026-10-01'],
    ['start', '--mode', 'weekly'],
    ['start', '--date', '2026-13-01'],
    ['window', '--change', 'one'],
    ['window', '--date', DATE],
    ['window', '--id', '2026-10-19'],
    ['state', '--id', '2026-13-01-window'],
    ['reply'],
    ['file', '--findings', 'one'],
    ['merge']
  ]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`)
    assert.equal(JSON.parse(r.stdout).ok, false)
  }
  assert.throws(() => run(['start', '--mode', 'period', '--from', '2026-10-01']), UsageError)

  const h = host()
  const later = { ...NONE, now: () => new Date('2026-10-19T13:00:00Z') }
  const change = call(h, ['start', '--date', DATE, '--change', 'one'])
  assert.deepEqual([change.ok, change.id, change.mode, change.detail.branch], [true, `${DATE}-one`, 'change', `chore/retro/${DATE}-one`])
  assert.equal(change.detail.worktree, join(h.root, '.claude', 'worktrees', `retro-${DATE}-one`))
  const window = call(h, ['start', '--date', DATE], later)
  assert.deepEqual([window.ok, window.id, window.detail.branch], [true, ID, `chore/retro/${ID}`])
  assert.equal(call(h, ['state'], later).id, ID, 'without --id, the newest started')
  const period = call(h, ['start', '--date', DATE, '--from', '2026-10-01', '--to', '2026-10-03'])
  assert.equal(period.id, `${DATE}-period`)
  assert.throws(() => call(h, ['start', '--date', DATE, '--from', '2026-10-01', '--to', '2026-10-09']), /started as \{"mode":"period","from":"2026-10-01","to":"2026-10-03"\}.*one retrospective per id/)
  assert.throws(() => call(h, ['start', '--date', DATE, '--change', 'window']), /would share the id of a window retrospective/)
  assert.throws(() => call(h, ['window', '--id', `${DATE}-two`]), /no retrospective 2026-10-19-two is started/)

  const win = call(h, ['window', '--id', `${DATE}-one`])
  assert.deepEqual([win.ok, win.id, win.detail.changes, win.detail.dispatch.name], [true, `${DATE}-one`, ['one'], `retro ${DATE}-one`])
  call(h, ['reply', '--id', `${DATE}-one`, '--file', writeReply(win, validReply(inputOf(win)))])
  const render = call(h, ['render', '--id', `${DATE}-one`])
  assert.deepEqual(render.detail.files, [`.adf/retro/${DATE}-one.json`, `.adf/retro/${DATE}-one.md`])
  const rec = call(h, ['record', '--id', `${DATE}-one`])
  assert.equal(rec.ok, true, rec.refusal)
  assert.equal(g(change.detail.worktree, ['log', '-1', '--format=%s']), `docs(retro): change retrospective ${DATE} of one`)
  assert.equal(call(h, ['state', '--id', ID]).steps.window.state, 'pending', 'the window retrospective of the date is its own')
})

test('the next window starts at this retrospective once its merge request merged, read after a fetch', () => {
  const h = host()
  recorded(h)
  call(h, ['publish'], { ...NONE, forge: () => ({ state: 'done', plugin: 'gitlab', url: 'u' }) })
  // The forge's side: the branch pushed and the merge request merged, in another clone.
  g(h.wt, ['push', '-q', 'origin', `chore/retro/${ID}`])
  const unmerged = call(h, ['since'])
  assert.deepEqual([unmerged.count, unmerged.previous], [2, null], 'an unmerged retrospective does not move the window')
  const forge = join(h.top, 'forge')
  execFileSync('git', ['clone', '-q', '-b', 'develop', h.remote, forge])
  g(forge, ['config', 'user.email', 'f@example.com'])
  g(forge, ['config', 'user.name', 'F'])
  g(forge, ['merge', '-q', '--no-ff', '-m', `Merge branch 'chore/retro/${ID}' into 'develop'`, `origin/chore/retro/${ID}`])
  g(forge, ['push', '-q', 'origin', 'develop'])

  const after = call(h, ['since'])
  assert.equal(after.fetch.fetched, true)
  assert.deepEqual([after.ref, after.count, after.previous.date, after.lintDue], ['origin/develop', 0, DATE, false])

  merge(forge, 'feat/three', { [`${ARCHIVE}/2026-10-20-three/tasks.md`]: '- [x] 1.1 a\n', 'src/three.txt': 'three\n' }, '2026-10-20T10:00:00Z')
  g(forge, ['push', '-q', 'origin', 'develop'])
  const next = '2026-10-26'
  const deps = { ...NONE, now: () => new Date('2026-10-26T12:00:00Z') }
  assert.equal(call(h, ['start', '--date', next], deps).ok, true)
  const win = call(h, ['window', '--id', `${next}-window`], deps)
  assert.deepEqual(win.detail.changes, ['three'])
  const sidecar = JSON.parse(readFileSync(win.detail.sidecar, 'utf8'))
  assert.equal(sidecar.previous.date, DATE)
  assert.deepEqual(sidecar.scope, { since: sidecar.previous.cutoff.mergeSha })
  assert.equal(call(h, ['state'], deps).id, `${next}-window`, 'without --id, the newest retrospective')
})

test('remove: after file, the retro worktree goes from the main checkout, never forced, its branch kept', () => {
  const h = host()
  recorded(h)
  call(h, ['publish', '--yes'])
  assert.throws(() => call(h, ['remove']), /remove waits for file; run retro\.mjs file --id 2026-10-19-window first/)
  assert.equal(call(h, ['file']).state, 'skipped')
  write(h.wt, { [MD_FILE]: 'edited\n' })
  const dirty = call(h, ['remove'])
  assert.deepEqual([dirty.ok, dirty.state], [false, 'failed'])
  assert.match(dirty.refusal, /has uncommitted changes; commit or move them, then remove again \(never --force\)/)
  assert.ok(existsSync(h.wt), 'a dirty worktree is kept')
  g(h.wt, ['checkout', '-q', '--', MD_FILE])
  const removed = call(h, ['remove'])
  assert.deepEqual([removed.ok, removed.state, removed.next, removed.detail.state], [true, 'done', null, 'removed'])
  assert.equal(removed.detail.report, `Worktree ${h.wt} removed; branch chore/retro/${ID} kept.`)
  assert.equal(existsSync(h.wt), false)
  assert.equal(g(h.root, ['rev-parse', '--verify', `chore/retro/${ID}`]).length, 40, 'the branch is kept')
  assert.equal(call(h, ['remove']).already, true)
})

test('renderRetro: every figure from the sidecar or a resolved key; nothing found, a named candidate, a period, the delta', () => {
  const sidecar = {
    date: DATE,
    mode: 'period',
    ref: 'develop',
    fetchedAt: null,
    asOf: '2026-10-19T12:00:00.000Z',
    scope: { from: '2026-10-01', to: '2026-10-15' },
    previous: null,
    cutoff: null,
    coverage: { records: 0, changes: 1 },
    changes: [{ change: 'a|b', mergedAt: '2026-10-02T10:00:00Z', tasks: null, git: { diffLines: null, fixesAfter: 0 }, record: { none: 'no metrics.json' } }],
    delta: { improved: [{ metric: 'cost.tokens', stat: 'mean', previous: 200, current: 100 }], worsened: [], unchanged: [], notCompared: [{ metric: 'x' }] }
  }
  const computed = {
    nothingFound: true,
    findings: [],
    decisions: [{ item: 'lite-path', decision: 'wait', basis: [{ key: 'aggregates.cost.tokens.n', value: 0 }], reason: 'No data.' }],
    removalCandidate: { name: 'sweep', kind: 'layer', reason: 'Quiet for long.', basis: [{ key: 'coverage.records', value: 0 }] },
    improvements: []
  }
  const md = renderRetro(sidecar, computed)
  assert.match(md, /^# Period retrospective 2026-10-19\n/)
  assert.match(md, /- Ref: `develop`, not fetched; fix commits counted up to 2026-10-19T12:00:00\.000Z/)
  assert.match(md, /- Scope: the changes merged from 2026-10-01 to 2026-10-15/)
  assert.doesNotMatch(md, /Next window/, 'only a window names where the next one starts')
  assert.match(md, /\| a\\\|b \| 2026-10-02 \| n\/a \| n\/a \| 0 \| none: no metrics\.json \|/)
  assert.match(md, /## Findings\n\nNothing found\.\n/)
  assert.match(md, /\| lite-path \| wait \| `aggregates\.cost\.tokens\.n` = 0 \| No data\. \|/)
  assert.match(md, /\*\*sweep\*\* \(layer\): Quiet for long\.\n\nBasis: `coverage\.records` = 0/)
  assert.match(md, /## Improvements\n\nnone\n/)
  assert.match(md, /Improved 1, worsened 0, unchanged 0, not compared 1\.\n\n\*\*Improved:\*\*\n\n- `cost\.tokens` mean: 200 to 100/)
  const doc = retroDocument(sidecar, computed)
  assert.deepEqual([doc.mode, doc.nothingFound, doc.removalCandidate.name], ['period', true, 'sweep'])
})

test('localMerge refuses a main checkout on another branch or with uncommitted changes, and merges nothing', () => {
  const h = host()
  g(h.root, ['checkout', '-q', '-b', 'side', 'develop'])
  write(h.root, { 'src/side.txt': 's\n' })
  g(h.root, ['add', '.'])
  g(h.root, ['commit', '-q', '-m', 'side'])
  const before = g(h.root, ['rev-parse', 'develop'])
  assert.deepEqual(localMerge(h.root, { branch: 'side', base: 'develop' }).hold, true, 'no yes, no merge')
  assert.throws(() => localMerge(h.root, { branch: 'side', base: 'develop', yes: true }), (e) => e instanceof MergeRefusal && /has side checked out, not develop/.test(e.message) && e.extra.commands.length === 2)
  g(h.root, ['checkout', '-q', 'develop'])
  write(h.root, { 'src/a.txt': 'changed\n' })
  assert.throws(() => localMerge(h.root, { branch: 'side', base: 'develop', yes: true }), /has uncommitted changes; nothing was merged/)
  assert.equal(g(h.root, ['rev-parse', 'develop']), before)
  g(h.root, ['checkout', '-q', '--', 'src/a.txt'])
  assert.equal(localMerge(h.root, { branch: 'side', base: 'develop', yes: true }).merged, true)
  assert.equal(localMerge(h.root, { branch: 'side', base: 'develop' }).already, true)
})
