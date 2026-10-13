import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeHome, isAvailable, mergeSettings, PLUGIN_ID } from '../lib/superpowers.mjs'

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
