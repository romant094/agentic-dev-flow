import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, latestTag, projectRef, remoteTags, installedVersion } from '../lib/update.mjs'

const ID = 'adf@agentic-dev-flow'

function project(source) {
  const root = mkdtempSync(join(tmpdir(), 'adf-update-'))
  if (source !== undefined) {
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'agentic-dev-flow': { source } } }))
  }
  return root
}

test('compareVersions orders 0.9.0 < 0.10.0', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('latestTag ignores non-version tags', () => {
  assert.equal(latestTag(['v0.9.0', 'v0.10.0', 'v0.10.0-rc1', 'nightly', 'v1']), 'v0.10.0')
  assert.equal(latestTag(['nightly']), null)
})

test('an unpinned ref is reported, never compared', () => {
  assert.deepEqual(projectRef(project({ source: 'git', ref: 'develop' })), { ref: 'develop', pinned: false })
  assert.deepEqual(projectRef(project({ source: 'git', ref: 'v0.5.0' })), { ref: 'v0.5.0', pinned: true })
  assert.deepEqual(projectRef(project({ source: 'git' })), { ref: null, pinned: false })
  assert.deepEqual(projectRef(project()), { ref: null, pinned: false })
})

test('remoteTags drops peeled lines', () => {
  const out = 'a1\trefs/tags/v0.1.0\nb2\trefs/tags/v0.1.0^{}\nc3\trefs/tags/v0.2.0\n'
  let seen
  const tags = remoteTags('https://x/y.git', { git: (args) => ((seen = args), out) })
  assert.deepEqual(tags, ['v0.1.0', 'v0.2.0'])
  assert.deepEqual(seen, ['ls-remote', '--tags', 'https://x/y.git'])
})

test('installedVersion follows the record installedPath uses, or the cache fallback', () => {
  const root = project()
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  mkdirSync(join(home, 'plugins'))
  const records = [
    { scope: 'user', installPath: '/user', version: '0.1.0' },
    { scope: 'project', projectPath: root, installPath: '/project', version: '0.2.0' }
  ]
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: records } }))
  // Neither path exists on disk, so nothing is installed.
  assert.equal(installedVersion(ID, root, { home }), null)
  const real = mkdtempSync(join(tmpdir(), 'adf-inst-'))
  records[1].installPath = real
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: records } }))
  assert.equal(installedVersion(ID, root, { home }), '0.2.0')

  const bare = mkdtempSync(join(tmpdir(), 'adf-home-'))
  mkdirSync(join(bare, 'plugins', 'marketplaces', 'agentic-dev-flow', '.claude-plugin'), { recursive: true })
  mkdirSync(join(bare, 'plugins', 'cache', 'agentic-dev-flow', 'adf', '0.3.0'), { recursive: true })
  writeFileSync(join(bare, 'plugins', 'marketplaces', 'agentic-dev-flow', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'adf', version: '0.3.0' }] }))
  writeFileSync(join(bare, 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: true } }))
  assert.equal(installedVersion(ID, root, { home: bare }), '0.3.0')
})
