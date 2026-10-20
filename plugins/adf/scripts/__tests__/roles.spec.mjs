import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRegistry, writeRegistry, readRegistry } from '../lib/registry.mjs'
import { callRole, CORE, forgeInput, forgeReport, knowledgePaths, knowledgeReport, upstreamReport } from '../lib/roles.mjs'

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

test('contract 1.5 defines the forge, knowledge and upstream roles', () => {
  assert.equal(CORE.coreContract, '1.5')
  assert.deepEqual(Object.keys(CORE.points), ['forge', 'knowledge', 'upstream'])
  assert.deepEqual(CORE.points.forge, { kind: 'role', operations: ['check', 'open', 'push', 'finalize'] })
  assert.deepEqual(CORE.points.knowledge, { kind: 'role', operations: ['context', 'log', 'check'] })
  assert.deepEqual(CORE.points.upstream, { kind: 'role', operations: ['check', 'file'] })
})

test('forgeInput passes ci false through, and the forge provider gets it', () => {
  const state = { change: 'x', branch: 'feat/x', base: 'develop', protected: ['develop'] }
  for (const operation of ['open', 'push', 'finalize']) {
    assert.equal(forgeInput(operation, state, { input: { ci: false }, title: 'feat: x' }).ci, false, operation)
    assert.equal(Object.hasOwn(forgeInput(operation, state, { title: 'feat: x' }), 'ci'), false, operation)
  }
  const out = forge(host(ECHO), 'push', '--input', '{"change":"x","ci":false}').out
  assert.deepEqual(out.input, { change: 'x', ci: false })
})

test('with no upstream provider nothing is filed and the findings stay in the sidecar', () => {
  const root = knowledgeHost()
  const core = { ...CORE, home }
  const none = callRole(root, 'upstream', 'file', { repository: 'o/r', host: 'h', retro: '2026-10-19-window', findings: [], debt: [] }, core)
  assert.deepEqual(none, { state: 'none', point: 'upstream' })
  assert.equal(upstreamReport('file', none), 'Upstream: none; no upstream plugin is enabled, so nothing was filed and the findings stay in the retrospective sidecar, the ADF debt unfiled in the debt tree.')
  assert.match(upstreamReport('check', none), /findings stay in the retrospective sidecar and the ADF debt stays unfiled/)
  assert.throws(() => callRole(root, 'upstream', 'close', {}, core), /upstream has no operation close/)
})

test('an upstream provider declared for contract 1.4 runs under core 1.5 and files findings and ADF debt in one call', () => {
  const declaration = { name: 'u', contract: '1.4', provides: { upstream: { script: 'scripts/k.mjs', operations: ['check', 'file'] } } }
  const script = `let t='';process.stdin.on('data',(d)=>t+=d).on('end',()=>{const j=JSON.parse(t).input;const items=[...j.findings.map((f)=>[f.id,'finding']),...j.debt.map((d)=>[d.id,'debt'])];console.log(JSON.stringify({state:'done',issues:items.map(([item,kind],i)=>({item,kind,number:i+1,url:'https://t/'+(i+1),existed:kind==='debt'}))}))})`
  const root = knowledgeHost(declaration, script)
  const core = { ...CORE, home }
  const filed = callRole(root, 'upstream', 'file', { repository: 'o/r', host: 'h', retro: 'r', findings: [{ id: 'R1' }, { id: 'R2' }], debt: [{ id: 'adf-01' }] }, core)
  assert.deepEqual(filed.issues, [
    { item: 'R1', kind: 'finding', number: 1, url: 'https://t/1', existed: false },
    { item: 'R2', kind: 'finding', number: 2, url: 'https://t/2', existed: false },
    { item: 'adf-01', kind: 'debt', number: 3, url: 'https://t/3', existed: true }
  ])
  assert.equal(upstreamReport('file', filed), 'Upstream: 2 filed, 1 already filed; finding R1 as https://t/1, finding R2 as https://t/2, ADF debt adf-01 as https://t/3 (already filed)')
  assert.equal(upstreamReport('file', { state: 'done', issues: [{ item: 'R1', kind: 'finding', number: 9 }] }), 'Upstream: 1 filed, 0 already filed; finding R1 as #9')
  assert.equal(upstreamReport('file', { state: 'done', issues: [] }), 'Upstream: nothing filed')
  assert.equal(upstreamReport('check', { state: 'degraded', hint: 'gh auth login' }), 'Upstream check: not done. gh auth login')
})

test('an absent entry is skipped: an installed provider still runs, and a point only it recorded is none with absent', () => {
  const declaration = { name: 'u', contract: '1.4', provides: { upstream: { script: 'scripts/k.mjs', operations: ['check', 'file'] } } }
  const root = knowledgeHost(declaration, `console.log(JSON.stringify({state:'done',tool:'t'}))`)
  const off = mkdtempSync(join(tmpdir(), 'adf-home-'))
  writeFileSync(join(off, 'settings.json'), JSON.stringify({ enabledPlugins: { 'gitlab@agentic-dev-flow': false } }))
  const extensions = [{ plugin: 'memory@agentic-dev-flow', points: ['knowledge'] }, { plugin: 'gitlab@agentic-dev-flow', points: ['forge'] }, { plugin: 'old@mk' }, ...readRegistry(root).extensions]
  writeRegistry(root, { ...readRegistry(root), extensions })
  const core = { ...CORE, home: off }
  assert.deepEqual(callRole(root, 'upstream', 'check', {}, core), { state: 'done', tool: 't', plugin: 'u' })
  const none = callRole(root, 'knowledge', 'context', {}, core)
  assert.deepEqual(none, { state: 'none', point: 'knowledge', absent: [{ id: 'memory@agentic-dev-flow', reason: 'not-installed' }] })
  assert.equal(
    knowledgeReport('context', none),
    'Knowledge: none; no knowledge plugin is enabled, so brainstorm reads no index and archive skips the ingest.\nmemory@agentic-dev-flow is in the registry but not installed; the knowledge context was skipped.'
  )
  assert.deepEqual(knowledgePaths(root, core), { state: 'none', paths: [], absent: [{ id: 'memory@agentic-dev-flow', reason: 'not-installed' }] })
  assert.match(forgeReport('push', callRole(root, 'forge', 'push', {}, core)), /\ngitlab@agentic-dev-flow is in the registry but disabled; the forge push was skipped\.$/)
  assert.doesNotMatch(upstreamReport('check', { state: 'none', point: 'upstream' }), /in the registry/)
})

test('an absent maintainer entry is named for upstream only, and an old entry with no points for nothing', () => {
  const root = knowledgeHost()
  writeRegistry(root, { ...readRegistry(root), extensions: [{ plugin: 'adf-maintainer@agentic-dev-flow', points: ['upstream'] }, { plugin: 'old@mk' }] })
  const core = { ...CORE, home }
  const knowledge = callRole(root, 'knowledge', 'context', {}, core)
  assert.deepEqual(knowledge, { state: 'none', point: 'knowledge' })
  assert.doesNotMatch(knowledgeReport('context', knowledge), /in the registry/)
  const upstream = callRole(root, 'upstream', 'file', { findings: [] }, core)
  assert.deepEqual(upstream, { state: 'none', point: 'upstream', absent: [{ id: 'adf-maintainer@agentic-dev-flow', reason: 'not-installed' }] })
  assert.equal(
    upstreamReport('file', upstream),
    'Upstream: none; no upstream plugin is enabled, so nothing was filed and the findings stay in the retrospective sidecar, the ADF debt unfiled in the debt tree.\nadf-maintainer@agentic-dev-flow is in the registry but not installed; the upstream file was skipped.'
  )
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
