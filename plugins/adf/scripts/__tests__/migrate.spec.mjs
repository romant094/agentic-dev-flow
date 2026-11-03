import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateConfig } from '../lib/migrate.mjs'
import { validateDeclaration } from '../lib/registry.mjs'

function plugin(scripts) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-migrate-'))
  mkdirSync(join(dir, 'm'))
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, 'm', name), body)
  return dir
}
const step = (version) => ({ version, script: `m/${version}.mjs` })
const append = (tag) => `export default (c) => ({ ...c, trail: [...(c.trail ?? []), '${tag}'] })`

test('steps run in order between from and to', async () => {
  const dir = plugin({ '0.2.0.mjs': append('a'), '0.3.0.mjs': append('b'), '0.4.0.mjs': append('c') })
  const declaration = { name: 'p', migrations: [step('0.4.0'), step('0.2.0'), step('0.3.0')] }
  const entry = { plugin: 'p@agentic-dev-flow', config: { keep: 1 } }
  const out = await migrateConfig(entry, declaration, dir, { from: '0.1.0', to: '0.4.0' })
  assert.deepEqual(out, { config: { keep: 1, trail: ['a', 'b', 'c'] }, ran: ['0.2.0', '0.3.0', '0.4.0'] })
  assert.deepEqual(entry.config, { keep: 1 })
})

test('a step outside the range does not run', async () => {
  const dir = plugin({ '0.2.0.mjs': append('a'), '0.3.0.mjs': append('b'), '0.4.0.mjs': append('c') })
  const declaration = { name: 'p', migrations: [step('0.2.0'), step('0.3.0'), step('0.4.0')] }
  const out = await migrateConfig({ config: {} }, declaration, dir, { from: '0.2.0', to: '0.3.0' })
  assert.deepEqual(out.ran, ['0.3.0'])
  const none = await migrateConfig({ config: { x: 1 } }, declaration, dir, { from: null, to: '0.4.0' })
  assert.deepEqual(none, { config: { x: 1 }, ran: [] })
})

test('a missing script or a non-function export throws naming the plugin and version', async () => {
  const dir = plugin({ '0.2.0.mjs': 'export default 5' })
  await assert.rejects(migrateConfig({}, { name: 'p', migrations: [step('0.2.0')] }, dir, { from: '0.1.0', to: '0.2.0' }), /p.*0\.2\.0/)
  await assert.rejects(migrateConfig({}, { name: 'p', migrations: [step('0.3.0')] }, dir, { from: '0.1.0', to: '0.3.0' }), /p.*0\.3\.0/)
})

test('a declaration with a malformed migrations entry is refused', () => {
  const base = { name: 'sample', contract: '1.9', provides: {} }
  assert.deepEqual(validateDeclaration({ ...base, migrations: [{ version: '0.2.0', script: 'm/a.mjs' }] }, []), [])
  for (const migrations of ['x', [{ version: '1.0', script: 'm/a.mjs' }], [{ version: '0.2.0', script: '../a.mjs' }], [{ version: '0.2.0' }]]) {
    assert.match(validateDeclaration({ ...base, migrations }, [])[0], /migrations/)
  }
})

test('a step that returns anything but a plain object is refused naming the plugin and version', async () => {
  for (const body of ['export default () => undefined', 'export default () => null', 'export default () => [1]', 'export default () => 5', 'export default () => new Map()']) {
    const dir = plugin({ '0.2.0.mjs': body })
    await assert.rejects(migrateConfig({ config: {} }, { name: 'p', migrations: [step('0.2.0')] }, dir, { from: '0.1.0', to: '0.2.0' }), /^Error: p: migration 0\.2\.0 .*not a plain config object/)
  }
  const dir = plugin({ '0.2.0.mjs': 'export default async (c) => Object.assign(Object.create(null), c, { x: 1 })' })
  assert.deepEqual({ ...(await migrateConfig({ config: {} }, { name: 'p', migrations: [step('0.2.0')] }, dir, { from: '0.1.0', to: '0.2.0' })).config }, { x: 1 })
})
