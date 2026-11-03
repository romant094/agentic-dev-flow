import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installedPath, mainCheckout, PLUGIN_ID } from '../lib/installed.mjs'

const ID = 'tool@market'
const always = () => true

function home(records, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-installed-'))
  mkdirSync(join(dir, 'plugins'))
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: records } }))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
  return dir
}

test('a plugin id is name@marketplace', () => {
  assert.match(ID, PLUGIN_ID)
  assert.doesNotMatch('tool', PLUGIN_ID)
})

test('the main checkout of a worktree is the repository it was added from; outside git it is the root', () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'adf-main-')))
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'develop')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
  const tree = join(realpathSync(tmpdir()), `adf-tree-${process.pid}-${Date.now()}`)
  git('worktree', 'add', '-q', tree)
  assert.equal(realpathSync(mainCheckout(tree)), main)
  const plain = mkdtempSync(join(tmpdir(), 'adf-plain-'))
  assert.equal(mainCheckout(plain), resolve(plain))
})

test('the most specific install of this project wins, and one for another project does not count', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const records = [
    { scope: 'user', installPath: '/user' },
    { scope: 'project', projectPath: root, installPath: '/project' },
    { scope: 'local', projectPath: '/elsewhere', installPath: '/other' }
  ]
  assert.equal(installedPath(ID, root, { home: home(records), exists: always }), '/project')
  assert.equal(installedPath(ID, root, { home: home(records), exists: (p) => p === '/user' }), '/user')
})

test('a disabled or absent plugin is refused with the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const user = [{ scope: 'user', installPath: '/user' }]
  assert.throws(() => installedPath(ID, root, { home: home(user, { enabledPlugins: { [ID]: false } }), exists: always }), /installed but disabled/)
  assert.throws(() => installedPath(ID, root, { home: home(user), exists: () => false }), /not installed for this project; run: claude plugin install tool@market/)
})

function worktreeOf(main) {
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'develop')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
  const tree = join(realpathSync(tmpdir()), `adf-tree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  git('worktree', 'add', '-q', tree)
  return tree
}

test('a project record for the current worktree counts', () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'adf-main-')))
  const tree = worktreeOf(main)
  const records = [{ scope: 'project', projectPath: tree, installPath: '/worktree-install' }]
  assert.equal(installedPath(ID, tree, { home: home(records), exists: always }), '/worktree-install')
})

test('a plugin enabled in project settings and present in the cache counts with no record', () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'adf-main-')))
  const tree = worktreeOf(main)
  mkdirSync(join(main, '.claude'))
  writeFileSync(join(main, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: true } }))
  const h = home([])
  const market = join(h, 'plugins', 'marketplaces', 'market', '.claude-plugin')
  mkdirSync(market, { recursive: true })
  writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'tool', version: '1.2.3' }] }))
  const cached = join(h, 'plugins', 'cache', 'market', 'tool', '1.2.3')
  mkdirSync(cached, { recursive: true })
  assert.equal(installedPath(ID, tree, { home: h }), cached)
})

test('the refusal names the main directory', () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'adf-main-')))
  const tree = worktreeOf(main)
  assert.throws(() => installedPath(ID, tree, { home: home([]), exists: () => false }), (e) => e.message.includes(`run it from ${main}`))
})
