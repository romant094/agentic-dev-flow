// lib/settings.mjs and settings.mjs: the project's settings file, checked against
// schema/settings.schema.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unknownKeywords } from '../lib/json-schema.mjs'
import { DEFAULTS, getSetting, INITIAL, isSetMessage, KEYS, readSettings, renderSettings, setMessage, setSetting, SETTINGS_FILE, settingsErrors, settingsSchema, writeSettings } from '../lib/settings.mjs'
import { run as cli, UsageError } from '../settings.mjs'
import { git, host } from './git-host.mjs'

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

// ---------------------------------------------------------------- settings.mjs, the CLI

test('settings.mjs set records one value from JSON, get shows it with its instructions, show renders all', () => {
  const root = tmp()
  assert.deepEqual(cli(['set', '--key', 'affectedTestsCommand', '--value', '"npx vitest related --run {files}"', '--root', root]), { file: join(root, SETTINGS_FILE), key: 'affectedTestsCommand', value: 'npx vitest related --run {files}' })
  cli(['set', '--key', 'worktreeCopies', '--value', '[".env"]', '--root', root])
  const got = cli(['get', '--key', 'worktreeCopies', '--root', root])
  assert.deepEqual(got.value, ['.env'])
  assert.match(got.description, /^The untracked files every worktree/)
  const shown = cli(['show', '--root', root])
  assert.equal(shown.settings.affectedTestsCommand, 'npx vitest related --run {files}')
  assert.match(shown.text, /- `worktreeCopies`: \[".env"\]\./)
  assert.equal(cli(['set', '--key', 'formatCommand', '--value', 'null', '--root', root]).value, null)
})

test('settings.mjs refuses an unknown key, a value that is not JSON or fails the schema, and writes nothing', () => {
  const root = tmp()
  assert.throws(() => cli(['set', '--key', 'nope', '--value', '1', '--root', root]), (e) => e instanceof UsageError && /unknown key "nope"/.test(e.message))
  assert.throws(() => cli(['set', '--key', 'checks', '--value', 'npm test', '--root', root]), (e) => e instanceof UsageError && /--value must be JSON/.test(e.message))
  assert.throws(() => cli(['set', '--key', 'checks', '--value', '"npm test"', '--root', root]), /\$\.checks: expected array/)
  assert.throws(() => cli(['get', '--root', root]), /--key is required/)
  assert.throws(() => cli(['show', '--key', 'checks', '--root', root]), /--key does not belong to show/)
  assert.equal(existsSync(join(root, SETTINGS_FILE)), false)
})

test('settings.mjs set --commit commits the settings alone with its fixed message', () => {
  const { change } = host()
  writeFileSync(join(change, 'stray.txt'), 'not mine\n')
  const out = cli(['set', '--key', 'wholeSuiteCommand', '--value', '"npm test"', '--root', change, '--commit'])
  assert.equal(out.commit, git(change, 'rev-parse', 'HEAD'))
  assert.equal(git(change, 'log', '-1', '--format=%s'), setMessage('wholeSuiteCommand'))
  assert.equal(isSetMessage(setMessage('wholeSuiteCommand')), true)
  assert.equal(isSetMessage('docs(openspec): record x'), false)
  assert.equal(git(change, 'show', '--name-only', '--format=', 'HEAD'), SETTINGS_FILE)
  assert.equal(git(change, 'status', '--porcelain', '--', 'stray.txt'), '?? stray.txt')
})
