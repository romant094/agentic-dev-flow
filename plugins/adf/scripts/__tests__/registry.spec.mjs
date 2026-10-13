import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REGISTRY_PATH,
  parseVersion,
  isCompatible,
  validateDeclaration,
  validateRegistry,
  readRegistry,
  initRegistry,
  addExtension,
  removeExtension,
  checkRegistry,
} from '../lib/registry.mjs'

const CORE = '1.0'

function host() {
  return mkdtempSync(join(tmpdir(), 'adf-host-'))
}

function plugin(root, name, declaration) {
  const dir = join(root, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify(declaration))
  return dir
}

test('parseVersion reads major.minor and refuses anything else', () => {
  assert.deepEqual(parseVersion('1.2'), { major: 1, minor: 2 })
  assert.equal(parseVersion('1'), null)
  assert.equal(parseVersion('1.2.3'), null)
  assert.equal(parseVersion('v1.2'), null)
})

test('isCompatible needs the same major and a minor the core already has', () => {
  assert.equal(isCompatible('1.0', '1.0'), true)
  assert.equal(isCompatible('1.3', '1.1'), true)
  assert.equal(isCompatible('1.0', '1.1'), false)
  assert.equal(isCompatible('2.0', '1.0'), false)
})

test('validateDeclaration accepts a plugin that provides nothing yet', () => {
  assert.deepEqual(validateDeclaration({ name: 'sample', contract: '1.0', provides: {} }, []), [])
})

test('validateDeclaration names every defect', () => {
  const errors = validateDeclaration({ name: 'Bad Name', contract: '1', provides: [] }, [])
  assert.equal(errors.length, 3)
})

test('validateDeclaration refuses a point the contract does not define', () => {
  const errors = validateDeclaration(
    { name: 'sample', contract: '1.0', provides: { forge: { kind: 'role', operations: {} } } },
    [],
  )
  assert.match(errors[0], /forge/)
})

test('validateRegistry refuses a duplicate path and a malformed entry', () => {
  const errors = validateRegistry({
    contract: '1.0',
    extensions: [{ path: 'a' }, { path: 'a' }, { config: {} }],
  })
  assert.equal(errors.length, 2)
})

test('readRegistry returns null when the project has no registry', () => {
  assert.equal(readRegistry(host()), null)
})

test('initRegistry creates the registry once and leaves an existing one untouched', () => {
  const root = host()
  assert.equal(initRegistry(root, CORE).created, true)
  const file = join(root, REGISTRY_PATH)
  const before = readFileSync(file, 'utf8')
  assert.equal(initRegistry(root, CORE).created, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.deepEqual(JSON.parse(before), { contract: CORE, extensions: [] })
})

test('addExtension records a compatible plugin with its config', () => {
  const root = host()
  initRegistry(root, CORE)
  plugin(root, 'sample', { name: 'sample', contract: '1.0', provides: {} })
  const result = addExtension(root, 'plugins/sample', { config: { a: 1 }, coreContract: CORE, points: [] })
  assert.equal(result.name, 'sample')
  assert.deepEqual(readRegistry(root).extensions, [{ path: 'plugins/sample', config: { a: 1 } }])
})

test('addExtension refuses an incompatible plugin and writes nothing', () => {
  const root = host()
  initRegistry(root, CORE)
  plugin(root, 'future', { name: 'future', contract: '2.0', provides: {} })
  assert.throws(
    () => addExtension(root, 'plugins/future', { coreContract: CORE, points: [] }),
    /future.*2\.0.*1\.0/,
  )
  assert.deepEqual(readRegistry(root).extensions, [])
})

test('addExtension refuses a second plugin with the same name', () => {
  const root = host()
  initRegistry(root, CORE)
  plugin(root, 'sample', { name: 'sample', contract: '1.0', provides: {} })
  addExtension(root, 'plugins/sample', { coreContract: CORE, points: [] })
  assert.throws(() => addExtension(root, './plugins/sample/', { coreContract: CORE, points: [] }), /already/)
})

test('addExtension needs an initialized project', () => {
  const root = host()
  plugin(root, 'sample', { name: 'sample', contract: '1.0', provides: {} })
  assert.throws(() => addExtension(root, 'plugins/sample', { coreContract: CORE, points: [] }), /adf:init/)
})

test('removeExtension takes the plugin out by name', () => {
  const root = host()
  initRegistry(root, CORE)
  plugin(root, 'sample', { name: 'sample', contract: '1.0', provides: {} })
  addExtension(root, 'plugins/sample', { coreContract: CORE, points: [] })
  assert.equal(removeExtension(root, 'sample').path, 'plugins/sample')
  assert.deepEqual(readRegistry(root).extensions, [])
  assert.throws(() => removeExtension(root, 'sample'), /not enabled/)
})

test('checkRegistry reports a plugin whose directory disappeared', () => {
  const root = host()
  initRegistry(root, CORE)
  writeFileSync(
    join(root, REGISTRY_PATH),
    JSON.stringify({ contract: CORE, extensions: [{ path: 'plugins/gone' }] }),
  )
  const report = checkRegistry(root, { coreContract: CORE, points: [] })
  assert.equal(report.ok, false)
  assert.match(report.errors[0], /plugins\/gone/)
  assert.equal(existsSync(join(root, 'plugins/gone')), false)
})

test('checkRegistry reports a registry written for another contract major', () => {
  const root = host()
  initRegistry(root, '2.0')
  const report = checkRegistry(root, { coreContract: CORE, points: [] })
  assert.equal(report.ok, false)
  assert.match(report.errors[0], /2\.0/)
})
