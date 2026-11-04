import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { pluginRoot } from '../lib/plugin-root.mjs'

function plugin(dir) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'adf', version: '1.2.3' }))
  return pathToFileURL(join(dir, 'scripts', 'lib', 'plugin-root.mjs')).href
}

test('a cached root has no warning', () => {
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const root = join(home, 'plugins', 'cache', 'market', 'adf', '1.2.3')
  const result = pluginRoot({ home, scriptUrl: plugin(root) })
  assert.deepEqual(result, { root, version: '1.2.3', cached: true, warning: null })
})

test('a root outside the cache warns and names it', () => {
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const root = join(mkdtempSync(join(tmpdir(), 'adf-clone-')), 'plugins', 'adf')
  const result = pluginRoot({ home, scriptUrl: plugin(root) })
  assert.equal(result.cached, false)
  assert.equal(result.version, '1.2.3')
  assert.equal(result.warning, `the adf scripts run from ${root}, not from an installed release`)
})

test('a cached root counts when the home is a symlink and the script path is resolved', () => {
  const real = mkdtempSync(join(tmpdir(), 'adf-real-home-'))
  const home = join(mkdtempSync(join(tmpdir(), 'adf-link-')), '.claude')
  symlinkSync(real, home)
  const root = join(real, 'plugins', 'cache', 'market', 'adf', '1.2.3')
  const result = pluginRoot({ home, scriptUrl: plugin(root) })
  assert.equal(result.cached, true)
  assert.equal(result.warning, null)
})

test('without a home, the Codex cache counts for a script under CODEX_HOME', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'adf-codex-home-'))
  const root = join(codexHome, 'plugins', 'cache', 'market', 'adf', '1.2.3')
  const result = pluginRoot({ scriptUrl: plugin(root), env: { CODEX_HOME: codexHome } })
  assert.equal(result.cached, true)
  assert.equal(result.warning, null)
})
