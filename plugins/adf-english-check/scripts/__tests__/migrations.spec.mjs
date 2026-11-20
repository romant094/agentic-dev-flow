// The plugin's config migrations: migrations/0.8.2.mjs rewrites the openspec/ globs of a host's
// config to adf/, run by the core's migrateConfig as /adf:update runs it.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import migrate from '../migrations/0.8.2.mjs'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/english.mjs'
import { migrateConfig } from '../../../adf/scripts/lib/migrate.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OLD = { include: ['openspec/changes/**', 'openspec/specs/**', 'docs/**'], exclude: ['openspec/changes/**/plan.md'], extensions: ['md'] }

test('0.8.2.mjs moves every openspec/ glob to adf/ and keeps the rest', () => {
  assert.deepEqual(migrate(OLD), { include: ['adf/changes/**', 'adf/specs/**', 'docs/**'], exclude: ['adf/changes/**/plan.md'], extensions: ['md'] })
  assert.deepEqual(migrate({ include: ['openspec/x/**', 'adf/x/**'] }), { include: ['adf/x/**'] })
  assert.deepEqual(migrate({}), {})
  // The old defaults, written out in a config, become the new defaults.
  assert.deepEqual(migrate({ include: ['openspec/changes/**', 'openspec/specs/**'], exclude: ['openspec/changes/**/plan.md'] }), { include: DEFAULT_CONFIG.include, exclude: DEFAULT_CONFIG.exclude })
  assert.deepEqual(resolveConfig({}).include, ['adf/changes/**', 'adf/specs/**'])
})

test('/adf:update runs it through the declaration when the plugin moves past 0.8.1, and only then', async () => {
  const declaration = JSON.parse(readFileSync(join(PLUGIN, 'adf-extension.json'), 'utf8'))
  const moved = await migrateConfig({ config: OLD }, declaration, PLUGIN, { from: '0.8.1', to: '0.9.0' })
  assert.deepEqual(moved.ran, ['0.8.2'])
  assert.deepEqual(moved.config.include, ['adf/changes/**', 'adf/specs/**', 'docs/**'])
  const again = await migrateConfig({ config: moved.config }, declaration, PLUGIN, { from: '0.9.0', to: '0.9.1' })
  assert.deepEqual(again.ran, [])
})
