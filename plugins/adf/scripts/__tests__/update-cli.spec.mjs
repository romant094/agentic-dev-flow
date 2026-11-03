import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../update.mjs'

const ID = 'adf@agentic-dev-flow'
const URL = 'https://example.com/adf.git'
const TAGS = 'a\trefs/tags/v0.9.0\nb\trefs/tags/v0.10.0\n'

function setup({ ref, user, installedProject, userUrl = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-uc-'))
  const home = mkdtempSync(join(tmpdir(), 'adf-uch-'))
  mkdirSync(join(root, '.claude'))
  if (ref !== undefined) {
    const source = { source: 'git', url: URL, ...(ref ? { ref } : {}) }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'agentic-dev-flow': { source } } }))
  }
  mkdirSync(join(home, 'plugins'))
  const records = []
  if (user) {
    const path = mkdtempSync(join(tmpdir(), 'adf-ui-'))
    records.push({ scope: 'user', installPath: path, version: user })
  }
  if (installedProject) {
    const path = mkdtempSync(join(tmpdir(), 'adf-pi-'))
    records.push({ scope: 'project', projectPath: root, installPath: path, version: installedProject })
  }
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: records } }))
  if (userUrl) writeFileSync(join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'agentic-dev-flow': { source: { source: 'git', url: URL } } }))
  return { root, home }
}

const git = (out) => () => out

test('check reports behind when ref < latest', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.equal(r.scope, 'project')
  assert.equal(r.latest, 'v0.10.0')
  assert.equal(r.behind, true)
  assert.equal(r.pull, false)
  assert.deepEqual(r.inFlight, [])
})

test('check sets pull when installed < ref', () => {
  const { root, home } = setup({ ref: 'v0.10.0', installedProject: '0.9.0' })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.equal(r.pull, true)
  assert.equal(r.behind, false)
})

test('check lists the changes in flight and their worktrees', () => {
  const { root, home } = setup({ ref: 'v0.10.0', installedProject: '0.10.0' })
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })
  mkdirSync(join(root, 'openspec', 'changes', 'alpha'))
  mkdirSync(join(root, 'openspec', 'changes', 'beta'))
  mkdirSync(join(root, '.claude', 'worktrees', 'beta'), { recursive: true })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.deepEqual(r.inFlight.map((c) => c.change).sort(), ['alpha', 'beta'])
  assert.equal(r.inFlight.find((c) => c.change === 'alpha').worktree, null)
  assert.match(r.inFlight.find((c) => c.change === 'beta').worktree, /worktrees[\\/]beta$/)
})

test('user scope is checked only outside a pinned project', () => {
  const user = setup({ user: '0.9.0' })
  const u = run(['check', '--root', user.root, '--home', user.home], { git: git(TAGS) })
  assert.equal(u.scope, 'user')
  assert.equal(u.installed, '0.9.0')
  assert.equal(u.behind, true)
  assert.equal(u.pull, false)
  const pinned = setup({ ref: 'v0.10.0', user: '0.9.0', installedProject: '0.10.0' })
  const p = run(['check', '--root', pinned.root, '--home', pinned.home], { git: git(TAGS) })
  assert.equal(p.scope, 'project')
  assert.equal(p.behind, false)
  const unpinned = setup({ ref: 'develop', user: '0.9.0' })
  const n = run(['check', '--root', unpinned.root, '--home', unpinned.home], { git: git(TAGS) })
  assert.equal(n.scope, 'project')
  assert.deepEqual([n.behind, n.pull], [false, false])
  assert.equal(run(['check', '--root', setup().root, '--home', setup().home]).scope, 'none')
})

test('notice prints the system message when behind or pull', () => {
  const a = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', a.root, '--home', a.home], { git: git(TAGS) }), {
    systemMessage: 'ADF v0.10.0 is available; this project is on v0.9.0. Run /adf:update.'
  })
  const b = setup({ ref: 'v0.10.0', installedProject: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', b.root, '--home', b.home], { git: git(TAGS) }), {
    systemMessage: 'This project pins ADF v0.10.0; v0.9.0 is installed. Run /adf:update to install it.'
  })
  const c = setup({ ref: 'v0.10.0', installedProject: '0.10.0' })
  assert.equal(run(['notice', '--root', c.root, '--home', c.home], { git: git(TAGS) }), null)
})

test('notice is silent when ls-remote fails', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const now = Date.now()
  let calls = 0
  const failing = () => {
    calls++
    throw new Error('network down')
  }
  assert.equal(run(['notice', '--root', root, '--home', home], { git: failing, now }), null)
  assert.equal(calls, 1)
  const cache = JSON.parse(readFileSync(join(home, 'adf', 'update-check.json'), 'utf8'))
  assert.deepEqual(cache[URL], { checkedAt: now, latest: null })
  assert.equal(run(['notice', '--root', root, '--home', home], { git: failing, now: now + 3600_000 }), null)
  assert.equal(calls, 1)
})

test('notice for a user-scope install names the installed version', () => {
  const { root, home } = setup({ user: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', root, '--home', home], { git: git(TAGS) }), {
    systemMessage: 'ADF v0.10.0 is available; v0.9.0 is installed. Run /adf:update.'
  })
})

test('notice reads the cache within a day', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const now = Date.now()
  let calls = 0
  const counting = () => (calls++, TAGS)
  run(['notice', '--root', root, '--home', home], { git: counting, now })
  assert.equal(calls, 1)
  const cache = JSON.parse(readFileSync(join(home, 'adf', 'update-check.json'), 'utf8'))
  assert.deepEqual(cache[URL], { checkedAt: now, latest: 'v0.10.0' })
  const again = run(['notice', '--root', root, '--home', home], { git: counting, now: now + 3600_000 })
  assert.equal(calls, 1)
  assert.match(again.systemMessage, /v0\.10\.0 is available/)
  run(['notice', '--root', root, '--home', home], { git: counting, now: now + 25 * 3600_000 })
  assert.equal(calls, 2)
})

test('notice is silent with scope none and writes no cache', () => {
  const { root, home } = setup()
  assert.equal(run(['notice', '--root', root, '--home', home], { git: git(TAGS) }), null)
  assert.equal(existsSync(join(home, 'adf', 'update-check.json')), false)
})

test('usage errors', () => {
  assert.throws(() => run(['bogus']), /usage/)
  assert.throws(() => run(['check', '--nope', 'x']), /unknown option/)
  assert.throws(() => run(['check', '--root']), /needs a value/)
})
