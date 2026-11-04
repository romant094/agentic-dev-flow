// The generated Codex manifests of scripts/manifests.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncManifests } from '../../../../scripts/manifests.mjs'

const claude = {
  name: 'demo',
  description: 'A demo plugin',
  version: '1.2.3',
  author: { name: 'Someone' },
  license: 'MIT',
  keywords: ['a', 'b'],
  dependencies: [{ name: 'x' }],
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'manifests-'))
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'm', plugins: [{ name: 'demo', version: '1.2.3', source: './plugins/demo' }] }),
  )
  mkdirSync(join(root, 'plugins', 'demo', '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'), JSON.stringify(claude))
  return root
}
const read = (root, ...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'))

test('root plugin.json carries the schema, name, version and description of .claude-plugin/plugin.json', () => {
  const root = fixture()
  try {
    syncManifests({ root })
    const plugin = read(root, 'plugins', 'demo', 'plugin.json')
    assert.match(plugin.$schema, /^https:\/\/agent-plugins\.org\/schemas\//)
    assert.equal(plugin.name, 'demo')
    assert.equal(plugin.version, '1.2.3')
    assert.equal(plugin.description, 'A demo plugin')
    assert.deepEqual(plugin.author, { name: 'Someone' })
    assert.equal(plugin.license, 'MIT')
    assert.deepEqual(plugin.keywords, ['a', 'b'])
    assert.equal('homepage' in plugin, false)
    assert.equal('dependencies' in plugin, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extensions."com.openai".interface.displayName is the plugin name', () => {
  const root = fixture()
  try {
    syncManifests({ root })
    const { interface: ui } = read(root, 'plugins', 'demo', 'plugin.json').extensions['com.openai']
    assert.deepEqual(ui, { displayName: 'demo', shortDescription: 'A demo plugin' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Codex marketplace lists every plugin of .claude-plugin/marketplace.json', () => {
  const root = fixture()
  try {
    syncManifests({ root })
    const market = read(root, '.agents', 'plugins', 'marketplace.json')
    assert.equal(market.name, 'agentic-dev-flow')
    assert.equal(market.interface.displayName, 'Agentic Dev Flow')
    assert.deepEqual(market.plugins, [
      {
        name: 'demo',
        version: '1.2.3',
        description: 'A demo plugin',
        source: { source: 'local', path: './plugins/demo' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check reports a hand-edited version and writes nothing', () => {
  const root = fixture()
  try {
    syncManifests({ root })
    assert.deepEqual(syncManifests({ root, check: true }).differ, [])
    const file = join(root, 'plugins', 'demo', 'plugin.json')
    writeFileSync(file, JSON.stringify({ ...read(root, 'plugins', 'demo', 'plugin.json'), version: '9.9.9' }))
    const result = syncManifests({ root, check: true })
    assert.equal(result.ok, false)
    assert.deepEqual(result.differ, ['plugins/demo/plugin.json'])
    assert.equal(read(root, 'plugins', 'demo', 'plugin.json').version, '9.9.9')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Codex loads no hooks for a plugin whose manifest is a root plugin.json (the agent-plugins.org
// format); it loads hooks/hooks.json only for a `.codex-plugin/plugin.json` or `.claude-plugin/` one.
function withHooks(root, { skills = false } = {}) {
  mkdirSync(join(root, 'plugins', 'demo', 'hooks'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'demo', 'hooks', 'hooks.json'), '{"hooks":{}}')
  if (skills) mkdirSync(join(root, 'plugins', 'demo', 'skills'))
}

test('a plugin with hooks/hooks.json gets .codex-plugin/plugin.json and no root plugin.json', () => {
  const root = fixture()
  try {
    withHooks(root, { skills: true })
    writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), '{}')
    syncManifests({ root })
    assert.equal(existsSync(join(root, 'plugins', 'demo', 'plugin.json')), false)
    assert.deepEqual(read(root, 'plugins', 'demo', '.codex-plugin', 'plugin.json'), {
      name: 'demo',
      version: '1.2.3',
      description: 'A demo plugin',
      author: { name: 'Someone' },
      license: 'MIT',
      keywords: ['a', 'b'],
      skills: './skills/',
      interface: { displayName: 'demo', shortDescription: 'A demo plugin' },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hook plugin without a skills directory declares no skills, and never declares hooks', () => {
  const root = fixture()
  try {
    withHooks(root)
    syncManifests({ root })
    const manifest = read(root, 'plugins', 'demo', '.codex-plugin', 'plugin.json')
    assert.equal('skills' in manifest, false)
    assert.equal('hooks' in manifest, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a plugin without hooks keeps its root plugin.json and has no .codex-plugin', () => {
  const root = fixture()
  try {
    syncManifests({ root })
    assert.equal(existsSync(join(root, 'plugins', 'demo', 'plugin.json')), true)
    assert.equal(existsSync(join(root, 'plugins', 'demo', '.codex-plugin')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check flags a leftover root plugin.json on a hook plugin and a stale .codex-plugin on another', () => {
  const root = fixture()
  try {
    withHooks(root)
    syncManifests({ root })
    writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), '{}')
    assert.deepEqual(syncManifests({ root, check: true }).differ, ['plugins/demo/plugin.json'])
    syncManifests({ root })
    rmSync(join(root, 'plugins', 'demo', 'hooks'), { recursive: true })
    const result = syncManifests({ root, check: true })
    assert.equal(result.ok, false)
    assert.deepEqual(result.differ.sort(), ['plugins/demo/.codex-plugin/plugin.json', 'plugins/demo/plugin.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
