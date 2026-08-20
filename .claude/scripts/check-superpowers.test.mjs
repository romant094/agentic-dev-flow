import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAvailable, mergeSettings, PLUGIN_ID } from './check-superpowers.mjs'

const file = (records) => ({ version: 2, plugins: { [PLUGIN_ID]: records } })
const installed = file([{ scope: 'user', installPath: '/plugins/superpowers/6.2.0' }])
const always = () => true
const never = () => false

test('available when installed, present on disk, and not disabled', () => {
  assert.deepEqual(isAvailable({ installedPlugins: installed, settings: {}, exists: always }), {
    ok: true,
    reason: null
  })
})

test('available when explicitly enabled', () => {
  const settings = { enabledPlugins: { [PLUGIN_ID]: true } }
  assert.equal(isAvailable({ installedPlugins: installed, settings, exists: always }).ok, true)
})

test('unavailable when explicitly disabled', () => {
  const settings = { enabledPlugins: { [PLUGIN_ID]: false } }
  const result = isAvailable({ installedPlugins: installed, settings, exists: always })
  assert.equal(result.ok, false)
  assert.match(result.reason, /disabled/)
})

test('unavailable when no record has an install path on disk', () => {
  const result = isAvailable({ installedPlugins: installed, settings: {}, exists: never })
  assert.equal(result.ok, false)
  assert.match(result.reason, /install path/)
})

test('available when one of several records exists on disk', () => {
  const many = file([
    { scope: 'project', installPath: '/gone' },
    { scope: 'user', installPath: '/here' }
  ])
  const exists = (p) => p === '/here'
  assert.equal(isAvailable({ installedPlugins: many, settings: {}, exists }).ok, true)
})

test('unavailable when the id has an empty record array', () => {
  const result = isAvailable({ installedPlugins: file([]), settings: {}, exists: always })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not installed/)
})

test('unavailable when there is no entry at all', () => {
  const empty = { version: 2, plugins: {} }
  const result = isAvailable({ installedPlugins: empty, settings: {}, exists: always })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not installed/)
})

test('unavailable when installed_plugins.json is absent', () => {
  const result = isAvailable({ installedPlugins: null, settings: null, exists: always })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not installed/)
})

test('version is never consulted', () => {
  const old = file([{ scope: 'user', installPath: '/p', version: '0.0.1' }])
  assert.equal(isAvailable({ installedPlugins: old, settings: {}, exists: always }).ok, true)
})

test('a project-level disabled fact beats a user-level enabled one', () => {
  const userSettings = { enabledPlugins: { [PLUGIN_ID]: true } }
  const projectSettings = { enabledPlugins: { [PLUGIN_ID]: false } }
  const settings = mergeSettings(userSettings, projectSettings)
  const result = isAvailable({ installedPlugins: installed, settings, exists: always })
  assert.equal(result.ok, false)
  assert.match(result.reason, /disabled/)
})

// Environment-dependent on purpose: the relative path assumes the suite runs from the
// repository root, and the clean exit assumes Superpowers is installed and enabled —
// which this project requires and declares in .claude/settings.json. Tolerating either
// exit code would assert nothing about availability. Revisit if a CI job ever runs this
// suite from another directory or on a machine without the plugin.
test('the CLI runs when invoked directly and stays silent when imported', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('node', ['.claude/scripts/check-superpowers.mjs'], { encoding: 'utf8' })
  assert.equal(out, '')

  const before = process.exitCode
  await import('./check-superpowers.mjs')
  assert.equal(process.exitCode, before)
})
