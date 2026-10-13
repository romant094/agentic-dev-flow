// End to end through the CLI, against a copy of the fixture host and the fixture plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
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
  assert.equal(init.contract, '1.0')
  assert.deepEqual(init.settings.added, ['enabledPlugins.adf@agentic-dev-flow'])
  const again = adf(root, 'init').out
  assert.equal(again.created, false)
  assert.deepEqual(again.settings.added, [])

  const added = adf(root, 'add', 'plugins/sample', '--config', '{"greeting":"hi"}')
  assert.equal(added.code, 0)
  assert.deepEqual(added.out, { name: 'sample', points: [] })

  const checked = adf(root, 'check')
  assert.equal(checked.code, 0)
  assert.deepEqual(checked.out.plugins, [{ name: 'sample', path: 'plugins/sample', points: [] }])

  const registry = JSON.parse(readFileSync(join(root, '.claude', 'adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions, [{ path: 'plugins/sample', config: { greeting: 'hi' } }])

  assert.equal(adf(root, 'remove', 'sample').code, 0)
  assert.deepEqual(adf(root, 'check').out.plugins, [])
})

test('a refusal is JSON with exit code 1', () => {
  const root = host()
  const result = adf(root, 'add', 'plugins/sample')
  assert.equal(result.code, 1)
  assert.match(result.out.error, /adf:init/)
})
