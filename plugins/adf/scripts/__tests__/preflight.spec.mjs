// preflight.mjs against real git repositories: a host on develop with one change in its own
// worktree, and a Claude Code home with or without Superpowers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { preflight } from '../lib/preflight.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { PLUGIN_ID } from '../lib/superpowers.mjs'
import { create, gitIn } from '../lib/workspace.mjs'

const CLI = fileURLToPath(new URL('../preflight.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const env = { CLAUDE_CODE_SESSION_ID: 'session-a' }

function home({ superpowers = true } = {}) {
  const dir = tmp('adf-preflight-home-')
  if (superpowers) {
    mkdirSync(join(dir, 'plugins'))
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: dir }] } })
    )
  }
  return dir
}

const PLAN = (file) => `# Plan\n\n### Task 1: t\n\n> Implements \`tasks.md\` 1.1.\n\n**Files:**\n- Modify: \`${file}\`\n\n**Interfaces:** none.\n`

// A host whose change has every artifact up to the plan, one task open.
function host({ plan = PLAN('notes.md'), tasks = '- [ ] 1.1 a\n' } = {}) {
  const root = join(tmp('adf-preflight-'), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  writeFileSync(join(root, 'notes.md'), 'n\n')
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: ['release'] })
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  const { root: change } = create(root, { change: 'add-x', branch: 'feat/add-x', base: 'integration' })
  const dir = join(change, 'openspec', 'changes', 'add-x')
  mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
  writeFileSync(join(dir, '.adf.json'), JSON.stringify({ schema: 'adf', schemaVersion: 1, created: '2026-10-15', base: 'develop' }))
  for (const f of ['brainstorm.md', 'proposal.md', 'specs/cap/spec.md']) writeFileSync(join(dir, f), 'x\n')
  if (tasks !== null) writeFileSync(join(dir, 'tasks.md'), tasks)
  if (plan !== null) writeFileSync(join(dir, 'plan.md'), plan)
  git(change, 'add', '.')
  git(change, 'commit', '-q', '-m', 'propose')
  return { root, change, dir }
}

const check = (phase, root, extra = {}) => preflight({ phase, change: 'add-x', root, env, home: home(), ...extra })

test('apply passes in the change worktree and reports what the phase needs', async () => {
  const { root, change } = host()
  const out = await check('apply', change)
  assert.equal(out.ok, true, out.refusal)
  assert.equal(out.refusal, undefined)
  assert.equal(out.main, root)
  assert.equal(out.root, change)
  assert.equal(out.branch, 'feat/add-x')
  assert.deepEqual(out.protected, ['develop', 'release'])
  assert.equal(out.base, 'develop')
  assert.equal(out.state, 'ready')
  assert.deepEqual(out.progress, { total: 1, complete: 0, remaining: 1 })
  assert.deepEqual(out.planFindings, [])
  assert.equal(out.sdd.written, true)
  const progress = readFileSync(join(change, '.superpowers', 'sdd', 'add-x', 'progress.md'), 'utf8')
  assert.equal(progress, `# SDD ledger — plan: ${change}/openspec/changes/add-x/plan.md\n`)
  assert.equal(out.ledger.recorded, true)
  const record = JSON.parse(readFileSync(out.ledger.path, 'utf8').trim())
  assert.equal(record.kind, 'session')
  assert.equal(record.phase, 'apply')
  assert.equal(record.sessionId, 'session-a')

  const again = await check('apply', change)
  assert.equal(again.sdd.written, false, 'a resumed apply keeps the skill working memory')
  assert.equal(again.ledger.id, 'session-2')
})

test('the Superpowers gate refuses first and nothing is written', async () => {
  const { change } = host()
  const out = await preflight({ phase: 'apply', change: 'add-x', root: change, env, home: home({ superpowers: false }) })
  assert.equal(out.ok, false)
  assert.match(out.refusal, /claude plugin install/)
  assert.equal(existsSync(join(change, '.superpowers')), false)
})

test('the main checkout, a protected branch and a detached HEAD refuse', async () => {
  const { root, change } = host()
  assert.match((await check('apply', root)).refusal, /is the main checkout/)
  setBranches(change, { integration: 'develop', protected: ['feat/add-x'] })
  assert.match((await check('verify', change)).refusal, /feat\/add-x is protected/)
  setBranches(change, { integration: 'develop', protected: [] })
  git(change, 'checkout', '-q', '--detach')
  assert.match((await check('apply', change)).refusal, /HEAD is detached/)
  assert.equal(existsSync(join(change, '.superpowers')), false)
})

test('a failed or empty git read refuses; an empty branch never passes the protected guard', async () => {
  const { change } = host()
  const real = gitIn(change)
  const failing = (...args) => {
    if (args[0] === 'branch') throw Object.assign(new Error('fatal'), { stderr: 'fatal: bad object HEAD' })
    return real(...args)
  }
  const failed = await check('apply', change, { git: failing })
  assert.equal(failed.ok, false)
  assert.match(failed.refusal, /failed to read the current branch/)
  assert.equal(failed.branch, null)
  const empty = await check('verify', change, { git: (...args) => (args[0] === 'branch' ? '' : real(...args)) })
  assert.match(empty.refusal, /HEAD is detached/)
  const noTop = await check('apply', change, { git: (...args) => (args[1] === '--show-toplevel' ? (() => { throw new Error('x') })() : real(...args)) })
  assert.match(noTop.refusal, /failed to read the top level/)
})

test('apply refuses without a plan, with every task done, on a plan finding and on a foreign SDD ledger', async () => {
  const noPlan = await check('apply', host({ plan: null }).change)
  assert.equal(noPlan.state, 'blocked')
  assert.match(noPlan.refusal, /Missing artifacts: plan.*\/adf:propose add-x/)

  const done = await check('apply', host({ tasks: '- [x] 1.1 a\n' }).change)
  assert.equal(done.state, 'all_done')
  assert.match(done.refusal, /\/adf:verify/)

  const finding = await check('apply', host({ plan: PLAN('missing.md') }).change)
  assert.equal(finding.ok, false)
  assert.equal(finding.planFindings.length, 1)
  assert.equal(finding.planFindings[0].kind, 'path-missing')
  assert.equal(finding.ledger, null, 'a refused phase records no session')

  const { change } = host()
  mkdirSync(join(change, '.superpowers', 'sdd', 'plan'), { recursive: true })
  writeFileSync(join(change, '.superpowers', 'sdd', 'plan', 'progress.md'), '# SDD ledger — plan: /x/openspec/changes/other/plan.md\n')
  const foreign = await check('apply', change)
  assert.equal(foreign.sdd.ok, false)
  assert.match(foreign.refusal, /^STOP: .*other/)
})

test('a progress.md of another plan in the change workspace refuses', async () => {
  const { change } = host()
  mkdirSync(join(change, '.superpowers', 'sdd', 'add-x'), { recursive: true })
  writeFileSync(join(change, '.superpowers', 'sdd', 'add-x', 'progress.md'), '# SDD ledger — plan: /x/openspec/changes/other/plan.md\n')
  const out = await check('apply', change)
  assert.equal(out.ok, false)
  assert.equal(out.sdd.foreign.plan, '/x/openspec/changes/other/plan.md')
})

test('verify passes with its dependencies done and refuses without the plan', async () => {
  const { change } = host()
  const out = await check('verify', change)
  assert.equal(out.ok, true, out.refusal)
  assert.equal(out.state, 'ready')
  assert.equal(out.sdd, null)
  assert.equal(out.planFindings, undefined)
  assert.equal(JSON.parse(readFileSync(out.ledger.path, 'utf8').trim()).phase, 'verify')
  const blocked = await check('verify', host({ plan: null }).change)
  assert.equal(blocked.state, 'blocked')
  assert.match(blocked.refusal, /verify needs plan/)
})

test('review reads the verify record: committed, its Verdict line not FAIL, and no code commit after it', async () => {
  const { change, dir } = host()
  const commitAll = (message) => {
    git(change, 'add', '.')
    git(change, 'commit', '-q', '-m', message)
  }
  assert.match((await check('review', change)).refusal, /review needs verify done first; run \/adf:verify add-x/)
  writeFileSync(join(dir, 'verify.md'), '# Verification Report\n\nno verdict here\n')
  assert.match((await check('review', change)).refusal, /verify\.md has no Verdict: line/)
  writeFileSync(join(dir, 'verify.md'), '# Verification Report\n\nVerdict: PASS\n')
  assert.match((await check('review', change)).refusal, /verify\.md is not committed/)
  writeFileSync(join(dir, 'verify.md'), '# Verification Report\n\nVerdict: PASS\n\nVerdict: FAIL\n')
  commitAll('verify')
  const failed = await check('review', change)
  assert.deepEqual([failed.ok, failed.verify], [false, { verdict: 'FAIL' }])
  assert.match(failed.refusal, /says Verdict: FAIL/)
  writeFileSync(join(dir, 'verify.md'), '# Verification Report\n\nVerdict: PASS WITH WARNINGS\n')
  commitAll('verify again')
  const recorded = git(change, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'notes.md'), 'a later note in the change directory\n')
  commitAll('notes')
  const out = await check('review', change)
  assert.equal(out.ok, true, out.refusal)
  assert.deepEqual(out.verify, { verdict: 'PASS WITH WARNINGS', commit: recorded })
  assert.equal(JSON.parse(readFileSync(out.ledger.path, 'utf8').trim()).phase, 'review')
  writeFileSync(join(change, 'a.txt'), 'changed code\n')
  commitAll('code after verify')
  const stale = await check('review', change)
  assert.match(stale.refusal, new RegExp(`commit\\(s\\) ${git(change, 'rev-parse', '--short=7', 'HEAD')} after the verify record touch files outside openspec/changes/add-x/: .*run /adf:verify add-x again`))
  assert.match((await check('review', host().root)).refusal, /main checkout/)
})

test('a missing session id still passes and says why nothing was recorded', async () => {
  const { change } = host()
  const out = await preflight({ phase: 'verify', change: 'add-x', root: change, env: {}, home: home() })
  assert.equal(out.ok, true)
  assert.equal(out.ledger.recorded, false)
  assert.match(out.ledger.error, /CLAUDE_CODE_SESSION_ID/)
})

test('a placeholder name, an unknown change and a missing root refuse', async () => {
  const { change } = host()
  assert.match((await preflight({ phase: 'apply', change: '<name>', root: change, env, home: home() })).refusal, /not kebab-case/)
  assert.match((await preflight({ phase: 'apply', change: 'add-y', root: change, env, home: home() })).refusal, /holds no change "add-y"/)
  assert.match((await check('apply', join(change, 'nowhere'))).refusal, /does not exist/)
})

test('propose passes in the main checkout and reports the branch policy inputs', async () => {
  const { root, change } = host()
  const out = await preflight({ phase: 'propose', change: 'add-y', root, env, home: home() })
  assert.equal(out.ok, true, out.refusal)
  assert.equal(out.main, root)
  assert.equal(out.branch, 'develop')
  assert.deepEqual(out.protected, ['develop', 'release'])
  assert.deepEqual(out.workspace, {
    integration: 'develop',
    bases: ['integration'],
    type: 'feat',
    branch: 'feat/add-y',
    path: join(root, '.claude', 'worktrees', 'add-y'),
    exists: false,
    dirty: []
  })
  assert.equal(out.ledger, null)
  const inFlight = await preflight({ phase: 'propose', change: 'add-x', root, env, home: home() })
  assert.equal(inFlight.ok, true)
  assert.equal(inFlight.workspace.exists, true)

  assert.match((await preflight({ phase: 'propose', change: 'add-y', root: change, env, home: home() })).refusal, /is not the main checkout/)
  writeFileSync(join(root, 'a.txt'), 'dirty\n')
  const dirty = await preflight({ phase: 'propose', change: 'add-y', root, env, home: home() })
  assert.equal(dirty.ok, false)
  assert.deepEqual(dirty.workspace.dirty, [' M a.txt'])
  assert.match(dirty.refusal, /uncommitted changes/)
})

test('propose refuses a host with no branch policy', async () => {
  const root = tmp('adf-preflight-bare-')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  const out = await preflight({ phase: 'propose', change: 'add-y', root, env, home: home() })
  assert.equal(out.ok, false)
  assert.match(out.refusal, /run \/adf:init/)
})

test('the CLI prints one JSON object and exits 0, 1 on a refusal, 2 on a usage error', () => {
  const { root, change } = host()
  const h = home()
  const call = (...args) => {
    const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  const ok = call('--phase', 'verify', '--change', 'add-x', '--root', change, '--home', h)
  assert.equal(ok.code, 0)
  assert.equal(ok.out.ok, true)
  const refused = call('--phase', 'apply', '--change', 'add-x', '--root', root, '--home', h)
  assert.equal(refused.code, 1)
  assert.match(refused.out.refusal, /main checkout/)
  for (const args of [['--phase', 'release', '--change', 'add-x'], ['--phase', 'apply'], ['--phase', 'apply', '--change'], ['--change', 'add-x', 'extra']]) {
    const usage = call(...args)
    assert.equal(usage.code, 2, args.join(' '))
    assert.ok(usage.out.usage)
  }
})

test('archive needs the review artifact and a tree clean outside the change, unless an archive is under way', async () => {
  const { root, change, dir } = host()
  const blocked = await check('archive', change)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.state, 'blocked')
  assert.match(blocked.refusal, /archive needs review done first; run \/adf:review add-x/)
  for (const f of ['verify.md', 'review.md']) writeFileSync(join(dir, f), 'x\n')
  git(change, 'add', '.')
  git(change, 'commit', '-q', '-m', 'review')
  writeFileSync(join(dir, 'notes.md'), 'inside the change\n')
  const ok = await check('archive', change)
  assert.equal(ok.ok, true, ok.refusal)
  assert.equal(ok.state, 'ready')
  assert.deepEqual(ok.archive, { started: false, next: 'check' })
  assert.equal(JSON.parse(readFileSync(ok.ledger.path, 'utf8').trim().split('\n').at(-1)).phase, 'archive')
  writeFileSync(join(change, 'stray.txt'), 'outside\n')
  writeFileSync(join(change, 'a.txt'), 'edited\n')
  const dirty = await check('archive', change)
  assert.equal(dirty.ok, false)
  assert.match(dirty.refusal, /uncommitted files outside openspec\/changes\/add-x\/: a\.txt, stray\.txt; archive commits only what it writes/)
  const state = join(root, '.superpowers', 'sdd', 'add-x', 'archive', 'state.json')
  mkdirSync(join(state, '..'), { recursive: true })
  writeFileSync(state, JSON.stringify({ steps: { check: { state: 'done' }, placements: { state: 'failed' } } }))
  const resumed = await check('archive', change)
  assert.equal(resumed.ok, true, resumed.refusal)
  assert.deepEqual(resumed.archive, { started: true, next: 'placements' })
})

test('archive passes for a change already moved to the archive, and refuses a change that is nowhere', async () => {
  const { change, dir } = host()
  mkdirSync(join(change, 'openspec', 'changes', 'archive'))
  git(change, 'mv', dir, join(change, 'openspec', 'changes', 'archive', '2026-10-19-add-x'))
  git(change, 'commit', '-q', '-m', 'archive')
  const out = await check('archive', change)
  assert.equal(out.ok, true, out.refusal)
  assert.equal(out.archived, 'openspec/changes/archive/2026-10-19-add-x')
  assert.equal(out.state, 'archived')
  assert.equal(out.base, 'develop')
  const missing = await preflight({ phase: 'archive', change: 'add-y', root: change, env, home: home() })
  assert.match(missing.refusal, /holds no change "add-y"/)
})

test('sdd.mjs init writes the identity line once and refuses a placeholder name', () => {
  const root = tmp('adf-sdd-init-')
  const SDD = fileURLToPath(new URL('../sdd.mjs', import.meta.url))
  const call = (...args) => {
    const r = spawnSync('node', [SDD, ...args], { encoding: 'utf8' })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  const first = call('init', '--change', 'add-x', '--root', root)
  assert.equal(first.code, 0)
  assert.deepEqual(first.out, { ok: true, change: 'add-x', foreign: null, progress: '.superpowers/sdd/add-x/progress.md', written: true })
  assert.equal(readFileSync(join(root, first.out.progress), 'utf8'), `# SDD ledger — plan: ${root}/openspec/changes/add-x/plan.md\n`)
  assert.equal(call('init', '--change', 'add-x', '--root', root).out.written, false)
  assert.equal(call('init', '--change', '<name>', '--root', root).code, 2)
  assert.equal(existsSync(join(root, '.superpowers', 'sdd', '<name>')), false)
  assert.deepEqual(call('--change', 'add-x', '--root', root).out, { ok: true, change: 'add-x', foreign: null }, 'the plain check is unchanged')
})
