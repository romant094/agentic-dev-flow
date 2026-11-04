import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readToml } from '../lib/toml.mjs'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-home', 'config.toml')

test('toml reads quoted table names and booleans', () => {
  const toml = readToml(readFileSync(fixture, 'utf8'))
  assert.equal(toml['plugins.superpowers@claude-plugins-official'].enabled, true)
  assert.equal(toml['plugins.adf@agentic-dev-flow'].enabled, false)
  assert.equal(toml.features.hooks, true)
  assert.equal(toml['marketplaces.claude-plugins-official'].source_type, 'git')
  assert.equal(toml['projects./abs/path'].trust_level, 'trusted')
  assert.equal(toml['desktop.appearanceDarkChromeTheme'].contrast, 60)
  assert.equal(toml['desktop.appearanceDarkChromeTheme'].opaqueWindows, false)
  assert.equal(toml['mcp_servers.node_repl.env'].NODE_PATH, '/x')
  assert.equal(toml[''].model, 'gpt-5')
})

test('unknown shapes are skipped', () => {
  const toml = readToml(readFileSync(fixture, 'utf8'))
  assert.equal(toml[''].notify, undefined)
  assert.equal(toml[''].approvals, undefined)
  assert.equal(toml['mcp_servers.node_repl'].args, undefined)
  assert.equal(toml['array.of.tables'], undefined)
  // The multi-line array's `["nested"]` line is not read as a table header.
  assert.equal(toml['nested'], undefined)
  assert.deepEqual(readToml('not toml at all\n= = =\n[unclosed'), { '': {} })
})
