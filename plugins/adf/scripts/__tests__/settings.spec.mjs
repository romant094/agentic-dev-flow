// lib/settings.mjs: the project's settings file, checked against schema/settings.schema.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unknownKeywords } from '../lib/json-schema.mjs'
import { DEFAULTS, getSetting, INITIAL, KEYS, readSettings, renderSettings, setSetting, SETTINGS_FILE, settingsErrors, settingsSchema, writeSettings } from '../lib/settings.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'adf-settings-'))
const put = (root, text) => {
  mkdirSync(dirname(join(root, SETTINGS_FILE)), { recursive: true })
  writeFileSync(join(root, SETTINGS_FILE), text)
}

test('the schema uses only the keywords the validator implements, and names every key with a description', () => {
  const schema = settingsSchema()
  assert.deepEqual(unknownKeywords(schema), [])
  assert.deepEqual(Object.keys(schema.properties), KEYS)
  for (const key of KEYS) assert.ok(schema.properties[key].description.length > 40, key)
  assert.deepEqual(settingsErrors(INITIAL), [])
  assert.deepEqual(settingsErrors({}), [])
})

test('a missing file reads as the defaults; a key the file lacks takes its default', () => {
  const root = tmp()
  assert.deepEqual(readSettings(root), DEFAULTS)
  assert.equal(getSetting(root, 'testFirstShares'), null)
  put(root, JSON.stringify({ wholeSuiteCommand: 'npm test' }))
  assert.equal(getSetting(root, 'wholeSuiteCommand'), 'npm test')
  assert.deepEqual(getSetting(root, 'worktreeCopies'), [])
})

test('testFirstShares keeps absent and empty apart', () => {
  const root = tmp()
  put(root, JSON.stringify({ testFirstShares: [] }))
  assert.deepEqual(getSetting(root, 'testFirstShares'), [])
  put(root, JSON.stringify({ testFirstShares: null }))
  assert.equal(getSetting(root, 'testFirstShares'), null)
})

test('a file that is not JSON, or fails the schema, throws with the file and each error', () => {
  const root = tmp()
  put(root, '{ nope')
  assert.throws(() => readSettings(root), /settings\.json is not valid JSON/)
  put(root, JSON.stringify({ wholeSuiteCommand: 3, other: true }))
  assert.throws(() => readSettings(root), /fails its schema: .*wholeSuiteCommand: expected string or null.*other is not allowed/)
  put(root, JSON.stringify({ formatCommand: 'a\nb', worktreeCopies: ['../x'] }))
  assert.throws(() => readSettings(root), /formatCommand: must be one line.*"\.\.\/x" is not a path inside the project/)
  put(root, JSON.stringify({ worktreePreparation: [{ command: 'npm run build', inputs: [] }] }))
  assert.throws(() => readSettings(root), /inputs: must hold at least 1 item/)
})

test('setSetting writes one key, checked first, and keeps the others in key order', () => {
  const root = tmp()
  writeSettings(root, INITIAL)
  setSetting(root, 'formatCommand', '  npx biome format --write {files}  ')
  setSetting(root, 'worktreeCopies', ['.env'])
  const text = readFileSync(join(root, SETTINGS_FILE), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)), KEYS)
  assert.ok(text.endsWith('}\n'))
  assert.equal(getSetting(root, 'formatCommand'), 'npx biome format --write {files}')
  assert.deepEqual(getSetting(root, 'worktreeCopies'), ['.env'])
  assert.throws(() => setSetting(root, 'worktreeCopies', ['/etc/passwd']), /not a path inside the project/)
  assert.throws(() => setSetting(root, 'nope', 1), /unknown settings key "nope"/)
  assert.deepEqual(getSetting(root, 'worktreeCopies'), ['.env'])
  assert.equal(setSetting(root, 'formatCommand', '').value, null)
})

test('renderSettings shows each key, its value and what it means', () => {
  const text = renderSettings({ ...DEFAULTS, packages: ['apps/server'], wholeSuiteCommand: 'npm test' })
  assert.match(text, /^# Project settings \(.*settings\.json\)/)
  assert.match(text, /- `packages`: \["apps\/server"\]\. The project's packages/)
  assert.match(text, /- `wholeSuiteCommand`: "npm test"\. The one command/)
  assert.match(text, /- `testFirstShares`: not set\./)
  assert.match(text, /- `checks`: none\./)
})
