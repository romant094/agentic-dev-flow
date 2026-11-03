import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
