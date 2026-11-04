import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installedPath, mainCheckout, PLUGIN_ID, selectInstall } from '../lib/installed.mjs'

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

// A Codex home: the user's config.toml, a marketplace clone listing tool 1.2.3, a cached version.
function codexHome({ config = '[plugins."tool@market"]\nenabled = true\n', cached = ['1.2.3'], listed = '1.2.3' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-codex-'))
  writeFileSync(join(dir, 'config.toml'), config)
  if (listed) {
    const clone = join(dir, '.tmp', 'marketplaces', 'market', '.agents', 'plugins')
    mkdirSync(clone, { recursive: true })
    writeFileSync(join(clone, 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'tool', source: './plugins/tool' }] }))
    const manifest = join(dir, '.tmp', 'marketplaces', 'market', 'plugins', 'tool', '.claude-plugin')
    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, 'plugin.json'), JSON.stringify({ name: 'tool', version: listed }))
  }
  for (const v of cached) mkdirSync(join(dir, 'plugins', 'cache', 'market', 'tool', v), { recursive: true })
  return dir
}

test('codex: an enabled plugin resolves to its cache directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const h = codexHome({ cached: ['1.2.3', '0.9.0'] })
  const found = selectInstall(ID, root, { runtime: 'codex', home: h })
  assert.deepEqual(found, { path: join(h, 'plugins', 'cache', 'market', 'tool', '1.2.3'), version: '1.2.3' })
  // With no marketplace clone, the single cached version is the install.
  const single = codexHome({ listed: null })
  assert.equal(installedPath(ID, root, { runtime: 'codex', home: single }), join(single, 'plugins', 'cache', 'market', 'tool', '1.2.3'))
  // Two cached versions and nothing to choose by: not installed.
  assert.throws(() => installedPath(ID, root, { runtime: 'codex', home: codexHome({ listed: null, cached: ['1', '2'] }) }), /not installed/)
})

test('codex: enabled = false is disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const h = codexHome({ config: '[plugins."tool@market"]\nenabled = false\n' })
  assert.throws(() => installedPath(ID, root, { runtime: 'codex', home: h }), (e) => /installed but disabled/.test(e.message) && e.absent.reason === 'disabled')
})

test('codex: the project config overrides the user config', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const h = codexHome()
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'config.toml'), '[plugins."tool@market"]\nenabled = false\n')
  assert.throws(() => installedPath(ID, root, { runtime: 'codex', home: h }), /installed but disabled/)
  const off = codexHome({ config: '[plugins."tool@market"]\nenabled = false\n' })
  writeFileSync(join(root, '.codex', 'config.toml'), '[plugins."tool@market"]\nenabled = true\n')
  assert.match(installedPath(ID, root, { runtime: 'codex', home: off }), /1\.2\.3$/)
})

test('codex: the refusal names codex plugin add', () => {
  const root = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const h = codexHome({ config: '' })
  assert.throws(() => installedPath(ID, root, { runtime: 'codex', home: h }), (e) => /run: codex plugin add tool@market$/.test(e.message) && e.absent.reason === 'not-installed')
  // Enabled but absent from the cache is not installed either.
  assert.throws(() => installedPath(ID, root, { runtime: 'codex', home: codexHome({ cached: [] }) }), /codex plugin add tool@market/)
})
