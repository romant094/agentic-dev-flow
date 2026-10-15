// End to end through the CLI, against a copy of the fixture host and the fixture plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'extensions.mjs')
const fixtures = join(here, '..', '..', '..', '..', 'test', 'fixtures')

function host() {
  const root = mkdtempSync(join(tmpdir(), 'adf-e2e-'))
  cpSync(join(fixtures, 'host'), root, { recursive: true })
  cpSync(join(fixtures, 'plugins'), join(root, 'plugins'), { recursive: true })
  return root
}

// An empty Claude Code home: no marketplace known, so init declares the plugin only.
const home = mkdtempSync(join(tmpdir(), 'adf-home-'))

function adf(root, ...args) {
  try {
    const argv = [cli, ...args, '--root', root, '--home', home]
    return { code: 0, out: JSON.parse(execFileSync('node', argv, { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

test('init, add, check, remove on a fresh host', () => {
  const root = host()
  assert.equal(adf(root, 'check').code, 1)
  const init = adf(root, 'init').out
  assert.equal(init.created, true)
  assert.equal(init.contract, '1.2')
  assert.deepEqual(init.settings.added, ['enabledPlugins.adf@agentic-dev-flow'])
  assert.deepEqual(init.planningGuide, { path: 'openspec/planning.md', created: true })
  assert.equal(init.branches, null)
  // init runs the gate and the check itself (I1) and renders the report (I2).
  assert.equal(init.superpowers.ok, false)
  assert.deepEqual(init.check.errors, ['no branches are set; run /adf:init'])
  assert.match(init.report, /Branch policy: not set/)
  assert.match(init.report, /Superpowers: not available/)
  assert.equal(adf(root, 'check').code, 1)
  const set = adf(root, 'branches', '--integration', 'develop', '--protected', 'main, develop').out
  assert.deepEqual({ integration: set.integration, protected: set.protected }, { integration: 'develop', protected: ['develop', 'main'] })
  assert.deepEqual(set.check, { ok: true, errors: [], plugins: [] })
  assert.match(set.report, /^Branch policy: integration develop; protected develop, main\n/)
  const again = adf(root, 'init').out
  assert.equal(again.created, false)
  assert.deepEqual(again.settings.added, [])
  assert.equal(again.planningGuide.created, false)
  assert.deepEqual(again.branches.protected, ['develop', 'main'])

  const added = adf(root, 'add', 'plugins/sample', '--config', '{"greeting":"hi"}')
  assert.equal(added.code, 0)
  const { check, report, ...enabled } = added.out
  assert.deepEqual(enabled, { name: 'sample', points: [], hostFiles: { copied: [], kept: [] } })
  assert.deepEqual(check.plugins, [{ name: 'sample', path: 'plugins/sample', points: [] }])
  assert.match(report, /^Enabled: sample \(no points\)\n[\s\S]*Registry check: ok/)

  const checked = adf(root, 'check')
  assert.equal(checked.code, 0)
  assert.deepEqual(checked.out.plugins, [{ name: 'sample', path: 'plugins/sample', points: [] }])

  const registry = JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions, [{ path: 'plugins/sample', config: { greeting: 'hi' } }])

  const removed = adf(root, 'remove', 'sample')
  assert.equal(removed.code, 0)
  assert.match(removed.out.report, /^Removed: plugins\/sample\nEnabled plugins: none\nRegistry check: ok/)
  assert.deepEqual(adf(root, 'check').out.plugins, [])
})

test('a refusal is JSON with exit code 1', () => {
  const root = host()
  const result = adf(root, 'add', 'plugins/sample')
  assert.equal(result.code, 1)
  assert.match(result.out.error, /adf:init/)
})

// A forge plugin installed by Claude Code into its cache, recorded for this host only.
function installedForge(root, name = 'forge-a') {
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  const records = {}
  for (const n of [name, 'forge-b']) {
    const dir = join(home, 'plugins', 'cache', 'mk', n, '1.0.0')
    mkdirSync(join(dir, 'templates'), { recursive: true })
    writeFileSync(join(dir, 'templates', 'mr.md'), `## What\n`)
    writeFileSync(
      join(dir, 'adf-extension.json'),
      JSON.stringify({
        name: n,
        contract: '1.2',
        provides: { forge: { script: 'scripts/forge.mjs', operations: ['check', 'open', 'push', 'finalize'] } },
        hostFiles: [{ from: 'templates/mr.md', to: '.forge/mr.md' }]
      })
    )
    records[`${n}@mk`] = [{ scope: 'project', projectPath: root, installPath: dir }]
  }
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: records }))
  return home
}

function adfAt(root, home, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root, '--home', home], { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

test('an installed plugin is enabled by id, its host files copied once, and a role has one provider', () => {
  const root = host()
  const forgeHome = installedForge(root)
  adfAt(root, forgeHome, 'init')
  adfAt(root, forgeHome, 'branches', '--integration', 'develop')
  const added = adfAt(root, forgeHome, 'add', 'forge-a@mk')
  assert.equal(added.code, 0)
  assert.deepEqual({ ...added.out, check: undefined, report: undefined }, { name: 'forge-a', points: ['forge'], hostFiles: { copied: ['.forge/mr.md'], kept: [] }, check: undefined, report: undefined })
  assert.equal(added.out.check.ok, true)
  assert.equal(existsSync(join(root, '.forge', 'mr.md')), true)
  const registry = JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions, [{ plugin: 'forge-a@mk' }])
  assert.deepEqual(adfAt(root, forgeHome, 'check').out.plugins, [{ name: 'forge-a', plugin: 'forge-a@mk', points: ['forge'] }])
  assert.match(adfAt(root, forgeHome, 'add', 'forge-b@mk').out.error, /role forge is already provided by forge-a/)
  assert.match(adfAt(root, forgeHome, 'add', 'missing@mk').out.error, /not installed for this project/)
  assert.equal(adfAt(root, forgeHome, 'remove', 'forge-a').code, 0)
  assert.deepEqual(adfAt(root, forgeHome, 'add', 'forge-a@mk').out.hostFiles, { copied: [], kept: ['.forge/mr.md'] })
})
