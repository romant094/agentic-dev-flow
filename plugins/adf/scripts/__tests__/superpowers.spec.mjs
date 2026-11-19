import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSuperpowers, claudeHome, isAvailable, mergeSettings, PLUGIN_ID } from '../lib/superpowers.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'superpowers.mjs')
const root = '/work/host'
const file = (records) => ({ version: 2, plugins: { [PLUGIN_ID]: records } })
const user = file([{ scope: 'user', installPath: '/plugins/superpowers/6.4.1' }])
const always = () => true
const never = () => false
const check = (installedPlugins, settings = {}, exists = always) =>
  isAvailable({ installedPlugins, settings, exists, root })

test('available when installed, present on disk, and not disabled', () => {
  assert.deepEqual(check(user), { ok: true, reason: null })
})

test('unavailable when explicitly disabled', () => {
  const result = check(user, { enabledPlugins: { [PLUGIN_ID]: false } })
  assert.equal(result.ok, false)
  assert.match(result.reason, /disabled/)
})

test('unavailable when no record has an install path on disk', () => {
  assert.match(check(user, {}, never).reason, /install path/)
})

test('available when one of several records exists on disk', () => {
  const many = file([
    { scope: 'user', installPath: '/gone' },
    { scope: 'user', installPath: '/here' }
  ])
  assert.equal(check(many, {}, (p) => p === '/here').ok, true)
})

test('unavailable when there is no record or no file', () => {
  assert.match(check(file([])).reason, /not installed/)
  assert.match(check({ version: 2, plugins: {} }).reason, /not installed/)
  assert.match(check(null, null).reason, /not installed/)
})

test('a project-scope record counts only for its own project', () => {
  const other = file([{ scope: 'project', projectPath: '/work/other', installPath: '/p' }])
  assert.match(check(other).reason, /not installed/)
  const own = file([{ scope: 'project', projectPath: root, installPath: '/p' }])
  assert.equal(check(own).ok, true)
  const local = file([{ scope: 'local', projectPath: `${root}/`, installPath: '/p' }])
  assert.equal(check(local).ok, true)
})

test('version is never consulted', () => {
  const old = file([{ scope: 'user', installPath: '/p', version: '0.0.1' }])
  assert.equal(check(old).ok, true)
})

test('settings merge user, project, local; the later layer wins', () => {
  const on = { enabledPlugins: { [PLUGIN_ID]: true } }
  const off = { enabledPlugins: { [PLUGIN_ID]: false } }
  assert.equal(mergeSettings(on, off).enabledPlugins[PLUGIN_ID], false)
  assert.equal(mergeSettings(on, off, on).enabledPlugins[PLUGIN_ID], true)
  assert.equal(mergeSettings(null, undefined, off).enabledPlugins[PLUGIN_ID], false)
})

test('the Claude Code home follows CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg')
  assert.match(claudeHome({}), /\.claude$/)
})

test('the CLI prints JSON and exits 1 with the install command', () => {
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const host = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const run = () => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [cli, '--root', host, '--home', home], { encoding: 'utf8' })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }

  const missing = run()
  assert.equal(missing.code, 1)
  assert.match(missing.out.install, /claude plugin install superpowers@claude-plugins-official/)

  mkdirSync(join(home, 'plugins'))
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify(file([{ scope: 'user', installPath: home }])))
  assert.deepEqual(run(), { code: 0, out: { ok: true, reason: null } })

  mkdirSync(join(host, '.claude'))
  writeFileSync(join(host, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }))
  assert.match(run().out.reason, /disabled/)
})

// A git repository with one worktree, both real paths.
function repoWithWorktree() {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'adf-main-')))
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'develop')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init')
  const tree = join(realpathSync(tmpdir()), `adf-sp-tree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  git('worktree', 'add', '-q', tree)
  return { main, tree }
}

test('in Claude Code the gate counts the main directory\'s project install from a worktree, and reads its settings', () => {
  const { main, tree } = repoWithWorktree()
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  mkdirSync(join(home, 'plugins'))
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify(file([{ scope: 'project', projectPath: main, installPath: home }])))
  assert.deepEqual(checkSuperpowers(tree, { runtime: 'claude-code', home }), { ok: true, reason: null })
  mkdirSync(join(main, '.claude'))
  writeFileSync(join(main, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }))
  assert.match(checkSuperpowers(tree, { runtime: 'claude-code', home }).reason, /disabled/)
})

test('in Claude Code the gate passes for a trusted project with no install record and the plugin in the cache', () => {
  const { main, tree } = repoWithWorktree()
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  mkdirSync(join(home, 'plugins'))
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
  mkdirSync(join(main, '.claude'))
  writeFileSync(join(main, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } }))
  const missing = checkSuperpowers(tree, { runtime: 'claude-code', home })
  assert.equal(missing.ok, false)
  assert.equal(missing.install, 'claude plugin install superpowers@claude-plugins-official')
  // The official marketplace lists Superpowers by a git source, with no version.
  const market = join(home, 'plugins', 'marketplaces', 'claude-plugins-official', '.claude-plugin')
  mkdirSync(market, { recursive: true })
  writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'superpowers', source: { source: 'url', url: 'https://github.com/obra/superpowers.git' } }] }))
  mkdirSync(join(home, 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '7.0.2'), { recursive: true })
  assert.deepEqual(checkSuperpowers(tree, { runtime: 'claude-code', home }), { ok: true, reason: null })
})

test('superpowers gate passes in codex with superpowers@claude-plugins-official enabled and cached', () => {
  const home = mkdtempSync(join(tmpdir(), 'adf-codex-'))
  const host = mkdtempSync(join(tmpdir(), 'adf-host-'))
  const run = () => {
    try {
      return { code: 0, out: JSON.parse(execFileSync('node', [cli, '--root', host, '--home', home], { encoding: 'utf8', env: { ...process.env, ADF_RUNTIME: 'codex' } })) }
    } catch (error) {
      return { code: error.status, out: JSON.parse(error.stdout) }
    }
  }
  const missing = run()
  assert.equal(missing.code, 1)
  assert.equal(missing.out.install, `codex plugin add ${PLUGIN_ID}`)

  writeFileSync(join(home, 'config.toml'), `[plugins."${PLUGIN_ID}"]\nenabled = true\n`)
  assert.match(run().out.reason, /not installed/)

  mkdirSync(join(home, 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '6.1.1'), { recursive: true })
  assert.deepEqual(run(), { code: 0, out: { ok: true, reason: null } })

  mkdirSync(join(host, '.codex'))
  writeFileSync(join(host, '.codex', 'config.toml'), `[plugins."${PLUGIN_ID}"]\nenabled = false\n`)
  assert.match(run().out.reason, /disabled/)
})
