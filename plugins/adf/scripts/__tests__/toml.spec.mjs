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

test('a multi-line string is skipped to its closing delimiter', () => {
  const text = '[plugins."a@b"]\nenabled = true\nnote = """\nenabled = false\n[x]\n"""\nafter = 1\nlit = \'\'\'\n[y]\n\'\'\'\none = """inline"""\n[z]\nk = 2\n'
  const toml = readToml(text)
  assert.equal(toml['plugins.a@b'].enabled, true)
  assert.equal(toml['plugins.a@b'].after, 1)
  assert.equal(toml.x, undefined)
  assert.equal(toml.y, undefined)
  assert.equal(toml.z.k, 2)
})

test('a bracket in a comment does not swallow the array that follows', () => {
  const toml = readToml('k = [ # a [ note\n  "a",\n]\n[z]\nv = 1\n')
  assert.equal(toml.z.v, 1)
})
