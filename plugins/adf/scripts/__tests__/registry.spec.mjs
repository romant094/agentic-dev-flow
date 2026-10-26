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
  validateDebtSettings,
  readDebtRoot,
  setDebtRoot,
  validateMetricsSettings,
  registryPlugins,
  enabledPlugins,
  addReport,
} from '../lib/registry.mjs'
import { execFileSync } from 'node:child_process'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { pricesUrl } from '../lib/prices.mjs'
import { DEFAULT_PRICES_URL } from '../lib/transcripts.mjs'

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
  assert.equal(isCompatible('1.3', '1.2'), true)
  assert.equal(isCompatible('1.0', '1.2'), false)
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
  assert.deepEqual(readRegistry(root).extensions, [{ path: 'plugins/sample', points: [], config: { a: 1 } }])
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

const FORGE = { forge: { kind: 'role', operations: ['check', 'open', 'push', 'finalize'] } }

test('a registry entry whose plugin is not installed or disabled is absent: no throw, only a warning', () => {
  const root = host()
  const home = mkdtempSync(join(tmpdir(), 'adf-home-'))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@mk': false } }))
  initRegistry(root, CORE)
  const points = { ...FORGE, knowledge: { kind: 'role', operations: ['context', 'log', 'check'] } }
  const core = { coreContract: CORE, points, home }
  plugin(root, 'f', { name: 'f', contract: '1.0', provides: { forge: { script: 's.mjs', operations: ['check', 'open', 'push', 'finalize'] } } })
  writeFileSync(join(root, REGISTRY_PATH), JSON.stringify({ contract: CORE, extensions: [{ plugin: 'adf-memory@agentic-dev-flow', points: ['knowledge'] }, { plugin: 'off@mk' }, { path: 'plugins/f', points: ['forge'] }] }))
  const found = registryPlugins(root, core)
  assert.deepEqual(found.plugins.map((p) => p.declaration.name), ['f'])
  assert.deepEqual(found.absent, [
    { id: 'adf-memory@agentic-dev-flow', reason: 'not-installed', points: ['knowledge'] },
    { id: 'off@mk', reason: 'disabled', points: [] }
  ])
  assert.deepEqual(enabledPlugins(root, core).map((p) => p.declaration.name), ['f'])
  const check = checkRegistry(root, core)
  assert.equal(check.errors.some((e) => e.includes('adf-memory@agentic-dev-flow')), false)
  assert.deepEqual(check.warnings, [
    'adf-memory@agentic-dev-flow is in the registry but not installed; its points are skipped (run: claude plugin install adf-memory@agentic-dev-flow --scope project)',
    'off@mk is in the registry but disabled; its points are skipped (run: claude plugin enable off@mk)'
  ])
  assert.deepEqual(check.plugins.map((p) => p.name), ['f'])
  plugin(root, 'g', { name: 'g', contract: '1.0', provides: { knowledge: { script: 's.mjs', operations: ['context', 'log', 'check'] } } })
  const added = addExtension(root, 'plugins/g', core)
  assert.deepEqual(readRegistry(root).extensions.at(-1), { path: 'plugins/g', points: ['knowledge'] })
  assert.match(addReport(added, checkRegistry(root, core)), /\nWarning: adf-memory@agentic-dev-flow is in the registry but not installed/)
})

test('validateDeclaration needs a script inside the plugin and every operation of the point', () => {
  const ok = { name: 'gl', contract: '1.2', provides: { forge: { script: 'scripts/forge.mjs', operations: ['check', 'open', 'push', 'finalize'] } } }
  assert.deepEqual(validateDeclaration(ok, FORGE), [])
  const bad = { name: 'gl', contract: '1.2', provides: { forge: { script: '../x.mjs', operations: ['check'] } }, hostFiles: [{ from: 'a', to: '/etc/x' }] }
  assert.deepEqual(validateDeclaration(bad, FORGE), [
    'forge: script must be a path inside the plugin',
    'forge: operations open, push, finalize are missing',
    'hostFiles must be a list of { from, to } paths inside the plugin and the host'
  ])
})

test('validateRegistry takes points as an optional list of point names', () => {
  assert.deepEqual(validateRegistry({ contract: '1.0', extensions: [{ path: 'a', points: ['forge'] }, { path: 'b' }] }), [])
  assert.deepEqual(validateRegistry({ contract: '1.0', extensions: [{ path: 'a', points: 'forge' }] }), ['extensions[0].points must be a list of point names'])
})

test('validateRegistry needs exactly one of plugin or path per entry', () => {
  const errors = validateRegistry({ contract: '1.2', extensions: [{ plugin: 'a@b', path: 'x' }, { plugin: 'Not An Id' }, { plugin: 'a@b' }] })
  assert.equal(errors.length, 2)
})

test('validateDebtSettings takes debt.root as a path inside the project and nothing else', () => {
  assert.deepEqual(validateDebtSettings({ root: 'docs/tech-debt' }), [])
  assert.deepEqual(validateDebtSettings({}), [])
  assert.deepEqual(validateDebtSettings([]), ['debt must be an object'])
  assert.deepEqual(validateDebtSettings({ root: '../out', status: 'x' }), [
    'debt.status is not a debt setting (root)',
    'debt.root must be a path relative to the project root'
  ])
  assert.deepEqual(validateRegistry({ contract: '1.0', extensions: [], debt: { root: '/abs' } }), ['debt.root must be a path relative to the project root'])
})

test('validateMetricsSettings takes metrics.pricesUrl as an optional http(s) URL and nothing else', () => {
  assert.deepEqual(validateMetricsSettings({ pricesUrl: 'https://example.com/pricing.md' }), [])
  assert.deepEqual(validateMetricsSettings({}), [])
  assert.deepEqual(validateMetricsSettings(null), ['metrics must be an object'])
  assert.deepEqual(validateMetricsSettings({ pricesUrl: 'pricing.md', cost: true }), [
    'metrics.cost is not a metrics setting (pricesUrl)',
    'metrics.pricesUrl must be an http or https URL'
  ])
  assert.deepEqual(validateRegistry({ contract: '1.0', extensions: [], metrics: { pricesUrl: 42 } }), ['metrics.pricesUrl must be an http or https URL'])
  assert.deepEqual(validateRegistry({ contract: '1.0', extensions: [], metrics: { pricesUrl: 'http://prices.example/x' } }), [])
})

test('init asks for no metrics.pricesUrl: the default stands, and .adf/prices/ and .adf/retro/ stay out of .gitignore', () => {
  const root = host()
  execFileSync('git', ['init', '-q', root])
  initRegistry(root, CORE)
  assert.equal(readRegistry(root).metrics, undefined)
  assert.equal(pricesUrl(root), DEFAULT_PRICES_URL)
  ignoreLocalDirs(root)
  execFileSync('git', ['check-ignore', '-q', '.superpowers/sdd/x'], { cwd: root, stdio: 'ignore' })
  for (const path of ['.adf/retro/2026-10-19-window.json', '.adf/prices/2026-10-19.json']) {
    const probe = () => execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
    assert.throws(probe, undefined, `${path} is committed, never ignored`)
  }
})

test('init ignores .adf/, the extension plugins\' local work directory, once, and keeps the core\'s committed directories', () => {
  const root = host()
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, '.gitignore'), 'node_modules/')
  assert.deepEqual(ignoreLocalDirs(root).added, ['.claude/worktrees/', '.superpowers/', 'docs/superpowers/', '.adf/*', '!.adf/prices/', '!.adf/retro/'])
  execFileSync('git', ['check-ignore', '-q', '.adf/jira/bulk/plan-transition-2026-10-21-1000.json'], { cwd: root, stdio: 'ignore' })
  for (const path of ['.adf/retro/2026-10-19-window.json', '.adf/prices/2026-10-19.json']) {
    assert.throws(() => execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' }), undefined, `${path} is committed, never ignored`)
  }
  const once = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.equal(once, 'node_modules/\n.claude/worktrees/\n.superpowers/\ndocs/superpowers/\n.adf/*\n!.adf/prices/\n!.adf/retro/\n')
  assert.deepEqual(ignoreLocalDirs(root).added, [])
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), once)
})

test('setDebtRoot records debt.root, readDebtRoot reads it, and a registry is required', () => {
  const root = host()
  assert.throws(() => setDebtRoot(root, 'debt'), /run \/adf:init first/)
  initRegistry(root, CORE)
  assert.equal(readDebtRoot(root), null)
  assert.equal(setDebtRoot(root, 'docs/debt'), 'docs/debt')
  assert.equal(readDebtRoot(root), 'docs/debt')
  assert.deepEqual(readRegistry(root).extensions, [])
  assert.throws(() => setDebtRoot(root, ' x'), /debt\.root must be a path/)
  assert.equal(readDebtRoot(root), 'docs/debt')
})
