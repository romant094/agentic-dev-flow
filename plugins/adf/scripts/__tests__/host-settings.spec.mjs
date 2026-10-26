import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareInHost, marketplaceSource, PLUGIN_KEY } from '../lib/host-settings.mjs'

const github = { source: 'github', repo: 'owner/agentic-dev-flow' }
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const settingsOf = (root) => JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'))

test('declares the plugin and the marketplace in a host without settings', () => {
  const root = temp('adf-host-')
  const result = declareInHost(root, { source: github })
  assert.deepEqual(result.added, [`enabledPlugins.${PLUGIN_KEY}`, 'extraKnownMarketplaces.agentic-dev-flow'])
  const settings = settingsOf(root)
  assert.equal(settings.enabledPlugins[PLUGIN_KEY], true)
  assert.deepEqual(settings.extraKnownMarketplaces['agentic-dev-flow'], { source: github })
})

test('keeps other keys, the indent and an explicit false', () => {
  const root = temp('adf-host-')
  mkdirSync(join(root, '.claude'))
  const before = { permissions: { deny: ['x'] }, enabledPlugins: { [PLUGIN_KEY]: false } }
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(before, null, 2))
  const result = declareInHost(root, { source: github })
  assert.deepEqual(result.added, ['extraKnownMarketplaces.agentic-dev-flow'])
  assert.match(result.notes[0], /disabled/)
  const text = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
  assert.match(text, /^\{\n {2}"permissions"/)
  assert.equal(settingsOf(root).enabledPlugins[PLUGIN_KEY], false)
  assert.deepEqual(settingsOf(root).permissions, { deny: ['x'] })
})

test('a local-directory marketplace is never written into the host', () => {
  const home = temp('adf-home-')
  mkdirSync(join(home, 'plugins'))
  const known = { 'agentic-dev-flow': { source: { source: 'directory', path: '/Users/me/adf' } } }
  writeFileSync(join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify(known))
  assert.equal(marketplaceSource(home), null)

  known['agentic-dev-flow'].source = github
  writeFileSync(join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify(known))
  assert.deepEqual(marketplaceSource(home), github)

  const root = temp('adf-host-')
  const result = declareInHost(root, { source: null })
  assert.match(result.notes[0], /local directory/)
  assert.equal(settingsOf(root).extraKnownMarketplaces['agentic-dev-flow'], undefined)
})
