// lib/sandbox.mjs: the replay sandbox builds from a fixture origin without changing it, its fakes
// log and answer, and its isolation assertion refuses every way out (a remote, a fake that does
// not resolve into bin/, the real home, a poisoned PATH, outside alternates). One opt-in check
// runs against the real origin when ADF_ORIGIN is set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { assertIsolated, createSandbox, FAKE_TOOLS } from '../lib/sandbox.mjs'

const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// A small origin: develop with two commits, a feature branch, a stash, a modified tracked file
// and an untracked file.
function fixtureOrigin() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-sandbox-origin-'))), 'origin')
  execFileSync('git', ['init', '-q', '-b', 'develop', dir])
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text)
    git(dir, 'add', file)
    git(dir, '-c', 'user.name=O', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', message)
    return git(dir, 'rev-parse', 'HEAD').trim()
  }
  const first = commit('a.txt', 'a\n', 'first')
  git(dir, 'checkout', '-q', '-b', 'feat/x')
  const feature = commit('b.txt', 'b\n', 'feature')
  git(dir, 'checkout', '-q', 'develop')
  const second = commit('a.txt', 'a2\n', 'second')
  writeFileSync(join(dir, 'a.txt'), 'stashed\n')
  git(dir, '-c', 'user.name=O', '-c', 'user.email=o@example.com', 'stash', 'push', '-q', '-m', 'kept')
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  writeFileSync(join(dir, 'untracked.txt'), 'u\n')
  return { dir, first, feature, second }
}

const snapshot = (dir) => ({
  refs: git(dir, 'for-each-ref'),
  head: readFileSync(join(dir, '.git', 'HEAD'), 'utf8'),
  config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
  status: git(dir, 'status', '--porcelain=v1', '-uall'),
  stash: git(dir, 'stash', 'list'),
  alternates: existsSync(join(dir, '.git', 'objects', 'info', 'alternates'))
})

const ORIGIN = fixtureOrigin()

function withCandidate(fn) {
  const sandbox = createSandbox({ origin: ORIGIN.dir })
  try {
    const candidate = sandbox.addCandidate('c1', { base: ORIGIN.first })
    fn(sandbox, candidate)
  } finally {
    sandbox.destroy()
  }
}

test('a full create, addCandidate and destroy cycle builds the layout and leaves the origin byte for byte unchanged', () => {
  const before = snapshot(ORIGIN.dir)
  const saved = { JIRA_PAT: process.env.JIRA_PAT, GITLAB_TOKEN: process.env.GITLAB_TOKEN, GLAB_HOST: process.env.GLAB_HOST }
  Object.assign(process.env, { JIRA_PAT: 'secret', GITLAB_TOKEN: 'secret', GLAB_HOST: 'gitlab.example.com' })
  let sandbox
  try {
    sandbox = createSandbox({ origin: ORIGIN.dir, id: `t-${process.pid}-cycle` })
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
  const S = sandbox.root
  try {
    assert.equal(S, join(realpathSync(tmpdir()), `adf-replay-t-${process.pid}-cycle`))
    for (const key of ['JIRA_PAT', 'GITLAB_TOKEN', 'GLAB_HOST']) assert.equal(sandbox.env[key], undefined, key)
    assert.deepEqual([sandbox.env.HOME, sandbox.env.CLAUDE_CONFIG_DIR, sandbox.env.TMPDIR], [join(S, 'home'), join(S, 'home', '.claude'), join(S, 'tmp')])
    assert.ok(sandbox.env.PATH.startsWith(`${join(S, 'bin')}${delimiter}`))
    assert.equal(sandbox.env.ADF_FAKE_JIRA, join(S, 'jira.json'))
    assert.match(sandbox.env.NODE_OPTIONS, /^--import=file:.*fake-jira-preload\.mjs$/)

    const c = sandbox.addCandidate('c1', { base: ORIGIN.first, refs: { 'feat/x': ORIGIN.feature } })
    assert.deepEqual([c.main, c.remote, c.base], [join(S, 'c1', 'main'), join(S, 'c1', 'remote.git'), ORIGIN.first])
    assert.equal(git(c.remote, 'for-each-ref', '--format=%(refname) %(objectname)'), `refs/heads/develop ${ORIGIN.first}\nrefs/heads/feat/x ${ORIGIN.feature}\n`)
    assert.equal(git(c.main, 'remote', 'get-url', 'origin').trim(), c.remote)
    assert.equal(git(c.main, 'remote', 'get-url', '--push', 'origin').trim(), c.remote)
    assert.equal(git(c.main, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'develop')
    assert.equal(git(c.main, 'rev-parse', 'HEAD', 'origin/develop').trim(), `${ORIGIN.first}\n${ORIGIN.first}`)
    assert.equal(git(c.main, 'rev-parse', '--abbrev-ref', 'develop@{upstream}').trim(), 'origin/develop')
    assert.equal(readFileSync(join(c.main, 'a.txt'), 'utf8'), 'a\n')
    assert.equal(git(c.main, 'status', '--porcelain').trim(), '')
    assert.equal(readFileSync(join(c.main, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(), join(S, 'cache', '.git', 'objects'))
    assert.equal(existsSync(join(S, 'cache', '.git', 'objects', 'info', 'alternates')), false, 'the cache borrows from nothing')
    assert.equal(assertIsolated(sandbox, c), true)

    // A commit in the candidate pushes to remote.git; the origin never sees it.
    writeFileSync(join(c.main, 'c.txt'), 'c\n')
    sandbox.git(c.main, 'add', 'c.txt')
    sandbox.git(c.main, 'commit', '-q', '-m', 'replay')
    sandbox.git(c.main, 'push', '-q', 'origin', 'develop')
    assert.equal(git(c.remote, 'rev-parse', 'develop').trim(), git(c.main, 'rev-parse', 'HEAD').trim())
    assert.equal(git(c.main, 'log', '-1', '--format=%an <%ae>').trim(), 'ADF Replay <replay@example.invalid>')
  } finally {
    sandbox.destroy()
  }
  assert.equal(existsSync(S), false)
  assert.deepEqual(snapshot(ORIGIN.dir), before)
})

test('the fakes log argv and cwd; glab keeps merge requests per candidate across calls; docker, psql and npx answer nothing', () => {
  withCandidate((sandbox, c) => {
    const run = (tool, ...args) => spawnSync(tool, args, { cwd: c.main, env: sandbox.env, encoding: 'utf8' })
    assert.equal(run('glab', '--version').stdout, 'glab version 1.50.0 (fake)\n')
    assert.equal(run('glab', 'auth', 'status').status, 0)
    assert.equal(run('glab', 'mr', 'list', '--source-branch', 'feat/K-1/x', '--output', 'json').stdout.trim(), '[]')
    const created = run('glab', 'mr', 'create', '--draft', '--source-branch', 'feat/K-1/x', '--target-branch', 'develop', '--squash-before-merge', '--remove-source-branch', '--title', 'T', '--description', '<!-- adf:x -->\nD\n<!-- /adf:x -->')
    assert.match(created.stdout, /https:\/\/gitlab\.example\.invalid\/replay\/c1\/-\/merge_requests\/1\b/)
    const listed = JSON.parse(run('glab', 'mr', 'list', '--source-branch', 'feat/K-1/x', '--output', 'json').stdout)
    assert.deepEqual(listed.map((m) => [m.iid, m.draft, m.state]), [[1, true, 'opened']])
    assert.equal(run('glab', 'mr', 'update', 'feat/K-1/x', '--ready', '--description', 'final').status, 0)
    const view = JSON.parse(run('glab', 'mr', 'view', '1', '--output', 'json').stdout)
    assert.deepEqual([view.draft, view.description, view.source_branch, view.target_branch, view.squash], [false, 'final', 'feat/K-1/x', 'develop', true])
    const unexpected = run('glab', 'api', 'projects')
    assert.deepEqual([unexpected.status, unexpected.stderr], [1, 'fake glab: unexpected api projects\n'])
    assert.equal(run('glab', 'mr', 'view', '9', '--output', 'json').status, 1)
    for (const tool of ['docker', 'psql', 'npx']) {
      const out = run(tool, 'any', '--thing')
      assert.deepEqual([out.status, out.stdout, out.stderr], [0, '', ''], tool)
      assert.deepEqual(sandbox.calls(tool), [{ argv: ['any', '--thing'], cwd: c.main }], tool)
    }
    assert.equal(sandbox.calls('glab').length, 9)
    assert.deepEqual(sandbox.calls('glab')[0], { argv: ['--version'], cwd: c.main })
  })
})

test('a fetch or push URL of origin outside the sandbox is refused', () => {
  withCandidate((sandbox, c) => {
    sandbox.git(c.main, 'remote', 'set-url', '--push', 'origin', ORIGIN.dir)
    assert.throws(() => assertIsolated(sandbox, c), /the push URL of origin is outside the sandbox/)
    sandbox.git(c.main, 'remote', 'set-url', '--push', 'origin', c.remote)
    sandbox.git(c.main, 'remote', 'set-url', 'origin', `file://${ORIGIN.dir}`)
    assert.throws(() => assertIsolated(sandbox, c), (e) => /the fetch URL of origin is outside/.test(e.message) && !/push URL/.test(e.message))
    sandbox.git(c.main, 'remote', 'set-url', 'origin', 'git@gitlab.example.com:group/repo.git')
    assert.throws(() => assertIsolated(sandbox, c), /the fetch URL of origin is outside/)
  })
})

test('a fake that does not resolve into bin/ is refused', () => {
  withCandidate((sandbox, c) => {
    rmSync(join(sandbox.bin, 'npx'))
    assert.throws(() => assertIsolated(sandbox, c), /npx resolves to .*, not into /)
  })
})

test('the real HOME is refused', () => {
  withCandidate((sandbox, c) => {
    sandbox.env.HOME = homedir()
    assert.throws(() => assertIsolated(sandbox, c), /HOME is the real home/)
  })
})

test('a poisoned PATH, with a glab elsewhere ahead of bin/, is refused', () => {
  withCandidate((sandbox, c) => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'adf-poison-')))
    writeFileSync(join(elsewhere, 'glab'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(elsewhere, 'glab'), 0o755)
    sandbox.env.PATH = `${elsewhere}${delimiter}${sandbox.env.PATH}`
    assert.throws(() => assertIsolated(sandbox, c), (e) => e.message.includes(`glab resolves to ${join(elsewhere, 'glab')}`) && FAKE_TOOLS.filter((t) => e.message.includes(`${t} resolves`)).length === 1)
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

test('alternates outside the sandbox and a caller tracker variable are refused', () => {
  withCandidate((sandbox, c) => {
    writeFileSync(join(c.main, '.git', 'objects', 'info', 'alternates'), `${join(ORIGIN.dir, '.git', 'objects')}\n`)
    sandbox.env.JIRA_PAT = 'x'
    assert.throws(() => assertIsolated(sandbox, c), (e) => /the alternates of main point outside the sandbox/.test(e.message) && /JIRA_PAT is set/.test(e.message))
  })
})

test('a temp directory whose path holds xnms is refused, and nothing is created', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'adf-xnms-')))
  const saved = process.env.TMPDIR
  process.env.TMPDIR = parent
  try {
    assert.throws(() => createSandbox({ origin: ORIGIN.dir, id: 'x' }), /contains "xnms"/)
    assert.equal(existsSync(join(parent, 'adf-replay-x')), false)
  } finally {
    saved === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = saved)
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a sandbox id is never reused, and a bad candidate name is refused', () => {
  const sandbox = createSandbox({ origin: ORIGIN.dir, id: `t-${process.pid}-reuse` })
  try {
    assert.throws(() => createSandbox({ origin: ORIGIN.dir, id: `t-${process.pid}-reuse` }), /EEXIST/)
    assert.throws(() => sandbox.addCandidate('bin', { base: ORIGIN.first }), /not a usable candidate name/)
    assert.throws(() => sandbox.addCandidate('../up', { base: ORIGIN.first }), /not a usable candidate name/)
  } finally {
    sandbox.destroy()
  }
})

const LIVE = process.env.ADF_ORIGIN
test('live: a sandbox from the real origin leaves its refs and status unchanged', { skip: !LIVE && 'ADF_ORIGIN is not set', timeout: 600_000 }, () => {
  const before = { refs: git(LIVE, 'for-each-ref'), status: git(LIVE, 'status', '--porcelain') }
  const sandbox = createSandbox({ origin: LIVE })
  try {
    const c = sandbox.addCandidate('live', { base: git(LIVE, 'rev-parse', 'refs/remotes/origin/develop').trim() })
    assert.equal(assertIsolated(sandbox, c), true)
  } finally {
    sandbox.destroy()
  }
  assert.deepEqual({ refs: git(LIVE, 'for-each-ref'), status: git(LIVE, 'status', '--porcelain') }, before)
})
