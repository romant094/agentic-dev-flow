import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRegistry, writeRegistry, readRegistry } from '../lib/registry.mjs'
import { callRole, CORE, knowledgePaths, knowledgeReport } from '../lib/roles.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'forge.mjs')
const home = mkdtempSync(join(tmpdir(), 'adf-home-'))

function host(script) {
  const root = mkdtempSync(join(tmpdir(), 'adf-role-'))
  initRegistry(root, '1.2')
  if (script !== undefined) {
    const dir = join(root, 'plugins', 'fake')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, 'adf-extension.json'),
      JSON.stringify({ name: 'fake', contract: '1.2', provides: { forge: { script: 'scripts/f.mjs', operations: ['check', 'open', 'push', 'finalize'] } } })
    )
    writeFileSync(join(dir, 'scripts', 'f.mjs'), script)
    writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/fake', config: { host: 'h' } }] })
  }
  return root
}

function forge(root, ...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync('node', [cli, ...args, '--root', root, '--home', home], { encoding: 'utf8' })) }
  } catch (error) {
    return { code: error.status, out: JSON.parse(error.stdout) }
  }
}

const ECHO = `let t='';process.stdin.on('data',(d)=>t+=d).on('end',()=>{const j=JSON.parse(t);console.log(JSON.stringify({state:'done',op:process.argv[2],config:j.config,input:j.input,cwd:process.cwd()===j.root}))})`

test('with no forge enabled the state is none and nothing runs', () => {
  assert.deepEqual(forge(host(), 'check'), {
    code: 0,
    out: { state: 'none', point: 'forge', report: 'Forge: none; no forge plugin is enabled, so nothing was pushed and no merge request exists.' }
  })
})

test('the provider gets the operation, its config and the input, in the host root', () => {
  const out = forge(host(ECHO), 'open', '--input', '{"change":"x"}').out
  assert.deepEqual(out, { state: 'done', op: 'open', config: { host: 'h' }, input: { change: 'x' }, cwd: true, plugin: 'fake', report: 'Merge request: no link returned (opened as a draft)' })
})

test('a provider that prints no result, or an unknown operation, is refused with exit 1', () => {
  const broken = forge(host('console.log("hello")'), 'check')
  assert.equal(broken.code, 1)
  assert.match(broken.out.error, /fake check returned no result: hello/)
  assert.match(broken.out.report, /^Forge: refused; fake check returned no result/)
  assert.match(forge(host(ECHO), 'merge').out.error, /forge has no operation merge/)
  const usage = forge(host(ECHO), 'open', '--input').out
  assert.match(usage.error, /--input needs a value/)
  assert.match(usage.report, /^Merge request: refused; --input needs a value/)
})

test('callRole refuses an operation the point does not declare, before looking for a provider', () => {
  const core = { points: { forge: { operations: ['check'] } } }
  assert.throws(() => callRole(host(), 'forge', 'merge', {}, core), /forge has no operation merge/)
})

// ---------------------------------------------------------------- the knowledge role

const memoryPlugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'memory')

function knowledgeHost(declaration, script) {
  const root = mkdtempSync(join(tmpdir(), 'adf-knowledge-'))
  initRegistry(root, CORE.coreContract)
  if (declaration === 'memory') {
    writeRegistry(root, { ...readRegistry(root), extensions: [{ path: memoryPlugin }] })
  } else if (declaration) {
    const dir = join(root, 'plugins', 'k')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify(declaration))
    writeFileSync(join(dir, 'scripts', 'k.mjs'), script)
    writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/k' }] })
  }
  return root
}

test('contract 1.3 defines the knowledge role with context, log and check', () => {
  assert.equal(CORE.coreContract, '1.3')
  assert.deepEqual(CORE.points.knowledge, { kind: 'role', operations: ['context', 'log', 'check'] })
  assert.equal(CORE.points.forge.kind, 'role')
})

test('with no knowledge provider the state is none, the default is said, and no path is allowed', () => {
  const root = knowledgeHost()
  const core = { ...CORE, home }
  const none = callRole(root, 'knowledge', 'context', {}, core)
  assert.deepEqual(none, { state: 'none', point: 'knowledge' })
  assert.equal(knowledgeReport('context', none), 'Knowledge: none; no knowledge plugin is enabled, so brainstorm reads no index and archive skips the ingest.')
  assert.match(knowledgeReport('log', none), /no log entry was written and archive skipped the ingest/)
  assert.deepEqual(knowledgePaths(root, core), { state: 'none', paths: [] })
  assert.throws(() => callRole(root, 'knowledge', 'merge', {}, core), /knowledge has no operation merge/)
})

test('the memory plugin answers context through the core, and its paths are allowed', () => {
  const root = knowledgeHost('memory')
  const core = { ...CORE, home }
  const context = callRole(root, 'knowledge', 'context', {}, core)
  assert.equal(context.state, 'done')
  assert.equal(context.plugin, 'memory')
  assert.equal(context.index, '.claude/memory/index.md')
  assert.equal(knowledgeReport('context', context), 'Knowledge: index .claude/memory/index.md (missing)')
  assert.deepEqual(knowledgePaths(root, core), { state: 'done', plugin: 'memory', paths: ['.claude/memory/**'] })
  const check = callRole(root, 'knowledge', 'check', {}, core)
  assert.equal(knowledgeReport('check', check), 'Knowledge check: 2 finding(s)')
})

test('knowledgePaths drops a glob outside the host root and reports a refused provider', () => {
  const declaration = { name: 'k', contract: '1.3', provides: { knowledge: { script: 'scripts/k.mjs', operations: ['context', 'log', 'check'] } } }
  const core = { ...CORE, home }
  const outside = knowledgeHost(declaration, `console.log(JSON.stringify({ state: 'done', paths: ['kb/**', '../up/**', '/abs/**'] }))`)
  assert.deepEqual(knowledgePaths(outside, core), { state: 'done', plugin: 'k', paths: ['kb/**'], error: 'not relative to the host root: ../up/**, /abs/**' })
  const broken = knowledgeHost(declaration, 'console.log("hi")')
  const result = knowledgePaths(broken, core)
  assert.equal(result.state, 'refused')
  assert.deepEqual(result.paths, [])
  assert.match(result.error, /k context returned no result: hi/)
  assert.equal(knowledgeReport('log', { state: 'done', entry: '## [2026-10-19 10:00] task | t | A\n- b\n', rotated: ['2026-09'], amended: false }), 'Knowledge log: written ## [2026-10-19 10:00] task | t | A; rotated 2026-09')
})
