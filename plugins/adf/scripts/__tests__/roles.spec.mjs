import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addExtension, checkRegistry, initRegistry, validateDeclaration, writeRegistry, readRegistry } from '../lib/registry.mjs'
import { callHook, callRole, CORE, forgeInput, forgeReport, hookProviders, knowledgePaths, knowledgeReport, trackerReport, upstreamReport } from '../lib/roles.mjs'

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

test('the payload reaches stdin as a file, and a provider past the timeout is stopped and refused', () => {
  const root = host(`import {fstatSync} from 'node:fs';const s=fstatSync(0);console.log(JSON.stringify({state:'done',file:s.isFile()}))`)
  assert.deepEqual(callRole(root, 'forge', 'check', {}, { ...CORE, home }), { state: 'done', file: true, plugin: 'fake' })
  const slow = host(`setTimeout(()=>console.log(JSON.stringify({state:'done'})),5000)`)
  process.env.ADF_PROVIDER_TIMEOUT_MS = '300'
  try {
    assert.deepEqual(callRole(slow, 'forge', 'check', {}, { ...CORE, home }), { state: 'refused', plugin: 'fake', error: 'fake check did not finish in 0.3 s and was stopped' })
  } finally {
    delete process.env.ADF_PROVIDER_TIMEOUT_MS
  }
})

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

const memoryPlugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'adf-memory')

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

test('contract 1.7 defines the forge, knowledge, upstream and tracker roles and the provision, teardown and verify-check hooks', () => {
  assert.equal(CORE.coreContract, '1.7')
  assert.deepEqual(Object.keys(CORE.points), ['forge', 'knowledge', 'upstream', 'provision', 'teardown', 'verify-check', 'tracker'])
  assert.deepEqual(CORE.points.forge, { kind: 'role', since: '1.1', operations: ['check', 'open', 'push', 'finalize', 'state'], operationSince: { push: '1.2', state: '1.7' } })
  assert.deepEqual(CORE.points.knowledge, { kind: 'role', since: '1.3', operations: ['context', 'log', 'check'] })
  assert.deepEqual(CORE.points.upstream, { kind: 'role', since: '1.4', operations: ['check', 'file'] })
  assert.deepEqual(CORE.points.tracker, { kind: 'role', since: '1.7', operations: ['check', 'gather', 'start', 'handoff'] })
  for (const hook of ['provision', 'teardown', 'verify-check']) assert.deepEqual(CORE.points[hook], { kind: 'hook', since: '1.6', operations: [hook] })
})

test('validation by operation version: a 1.6 forge without state stays valid, a 1.7 one needs it, and a missing later operation is none', () => {
  const ops = ['check', 'open', 'push', 'finalize']
  assert.deepEqual(validateDeclaration({ name: 'f', contract: '1.6', provides: { forge: { script: 's.mjs', operations: ops } } }, CORE.points), [])
  assert.deepEqual(validateDeclaration({ name: 'f', contract: '1.1', provides: { forge: { script: 's.mjs', operations: ['check', 'open', 'finalize'] } } }, CORE.points), [])
  assert.deepEqual(validateDeclaration({ name: 'f', contract: '1.7', provides: { forge: { script: 's.mjs', operations: ops } } }, CORE.points), ['forge: operations state are missing'])
  assert.deepEqual(validateDeclaration({ name: 'f', contract: '1.7', provides: { forge: { script: 's.mjs', operations: [...ops, 'state'] } } }, CORE.points), [])
  const root = mkdtempSync(join(tmpdir(), 'adf-opver-'))
  initRegistry(root, CORE.coreContract)
  const dir = join(root, 'plugins', 'f')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify({ name: 'f', contract: '1.6', provides: { forge: { script: 's.mjs', operations: ops } } }))
  writeFileSync(join(dir, 's.mjs'), ECHO)
  writeRegistry(root, { ...readRegistry(root), extensions: [{ path: 'plugins/f' }] })
  assert.deepEqual(checkRegistry(root, { ...CORE, home }).errors, ['no branches are set; run /adf:init'])
  assert.deepEqual(callRole(root, 'forge', 'state', {}, { ...CORE, home }), { state: 'none', point: 'forge', operation: 'state', reason: 'not-provided', plugin: 'f' })
  assert.equal(callRole(root, 'forge', 'check', {}, { ...CORE, home }).state, 'done')
})

test('forgeReport: a forge that does not provide an operation is named, and the state of a merge request is rendered', () => {
  assert.equal(forgeReport('state', { state: 'none', point: 'forge', operation: 'state', reason: 'not-provided', plugin: 'f' }), "Merge request: none; f does not provide state, so the step's default applies.")
  assert.equal(forgeReport('state', { state: 'none', point: 'forge' }), 'Merge request: none; no forge plugin is enabled, so nothing was pushed and no merge request exists.')
  assert.equal(forgeReport('state', { state: 'done', url: 'https://g/mr/7', status: 'open' }), 'Merge request: https://g/mr/7 (open)')
  assert.equal(forgeReport('state', { state: 'done', number: 7, status: 'draft' }), 'Merge request: !7 (draft)')
  assert.equal(forgeReport('state', { state: 'done', url: 'u', status: 'merged', mergedAt: '2026-10-20T10:00:00Z', mergeCommit: 'abcdef1234567' }), 'Merge request: u (merged at 2026-10-20T10:00:00Z, commit abcdef1)')
  assert.equal(forgeReport('state', { state: 'degraded', hint: 'run glab auth login' }), 'Merge request: not done yet. run glab auth login')
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
  writeFileSync(join(off, 'settings.json'), JSON.stringify({ enabledPlugins: { 'adf-gitlab@agentic-dev-flow': false } }))
  const extensions = [{ plugin: 'adf-memory@agentic-dev-flow', points: ['knowledge'] }, { plugin: 'adf-gitlab@agentic-dev-flow', points: ['forge'] }, { plugin: 'old@mk' }, ...readRegistry(root).extensions]
  writeRegistry(root, { ...readRegistry(root), extensions })
  const core = { ...CORE, home: off }
  assert.deepEqual(callRole(root, 'upstream', 'check', {}, core), { state: 'done', tool: 't', plugin: 'u' })
  const none = callRole(root, 'knowledge', 'context', {}, core)
  assert.deepEqual(none, { state: 'none', point: 'knowledge', absent: [{ id: 'adf-memory@agentic-dev-flow', reason: 'not-installed' }] })
  assert.equal(
    knowledgeReport('context', none),
    'Knowledge: none; no knowledge plugin is enabled, so brainstorm reads no index and archive skips the ingest.\nadf-memory@agentic-dev-flow is in the registry but not installed; the knowledge context was skipped.'
  )
  assert.deepEqual(knowledgePaths(root, core), { state: 'none', paths: [], absent: [{ id: 'adf-memory@agentic-dev-flow', reason: 'not-installed' }] })
  assert.match(forgeReport('push', callRole(root, 'forge', 'push', {}, core)), /\nadf-gitlab@agentic-dev-flow is in the registry but disabled; the forge push was skipped\.$/)
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
  assert.equal(context.plugin, 'adf-memory')
  assert.equal(context.index, '.claude/memory/index.md')
  assert.equal(knowledgeReport('context', context), 'Knowledge: index .claude/memory/index.md (missing)')
  assert.deepEqual(knowledgePaths(root, core), { state: 'done', plugin: 'adf-memory', paths: ['.claude/memory/**'] })
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

// ---------------------------------------------------------------- hooks

// A host whose registry names one path plugin per entry of `plugins`, in that order: each provides
// `points` with the script `script`, and gets `config`.
function hookHost(plugins) {
  const root = mkdtempSync(join(tmpdir(), 'adf-hook-'))
  initRegistry(root, CORE.coreContract)
  const extensions = []
  for (const { name, points = ['provision'], script, config } of plugins) {
    const dir = join(root, 'plugins', name)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const provides = Object.fromEntries(points.map((p) => [p, { script: 'scripts/h.mjs', operations: [p] }]))
    writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify({ name, contract: '1.6', provides }))
    writeFileSync(join(dir, 'scripts', 'h.mjs'), script)
    extensions.push({ path: `plugins/${name}`, points, ...(config ? { config } : {}) })
  }
  writeRegistry(root, { ...readRegistry(root), extensions })
  return root
}

// A provider that records its call in <root>/calls.txt and answers `state` with what it was given.
const hookScript = (state, extra = {}) => `import { appendFileSync } from 'node:fs'
let t='';process.stdin.on('data',(d)=>t+=d).on('end',()=>{const j=JSON.parse(t);appendFileSync(j.root+'/calls.txt',(j.config.name ?? '?')+' '+process.argv[2]+'\\n');console.log(JSON.stringify({state:${JSON.stringify(state)},config:j.config,input:j.input,cwd:process.cwd()===j.root,...${JSON.stringify(extra)}}))})`
const calls = (root) => (existsSync(join(root, 'calls.txt')) ? readFileSync(join(root, 'calls.txt'), 'utf8').trim().split('\n') : [])

test('callHook calls every provider in registry order, each with its own config, the point as the operation', () => {
  const root = hookHost([
    { name: 'one', script: hookScript('done', { notes: ['n1'] }), config: { name: 'one' } },
    { name: 'two', script: hookScript('done'), config: { name: 'two', x: 1 } }
  ])
  const out = callHook(root, 'provision', { kind: 'change' }, { ...CORE, home })
  assert.equal(out.state, 'done')
  assert.deepEqual(calls(root), ['one provision', 'two provision'])
  assert.deepEqual(out.results.map((r) => [r.plugin, r.state, r.config, r.input, r.cwd]), [
    ['one', 'done', { name: 'one' }, { kind: 'change' }, true],
    ['two', 'done', { name: 'two', x: 1 }, { kind: 'change' }, true]
  ])
  assert.deepEqual(out.results[0].notes, ['n1'])
})

test('callHook: none without a provider or a registry, and absent entries named as callRole names them', () => {
  const bare = mkdtempSync(join(tmpdir(), 'adf-hook-'))
  assert.deepEqual(callHook(bare, 'provision', {}, { ...CORE, home }), { state: 'none', point: 'provision', results: [] })
  const root = hookHost([{ name: 'other', points: ['teardown'], script: hookScript('done'), config: { name: 'other' } }])
  assert.deepEqual(callHook(root, 'provision', {}, { ...CORE, home }), { state: 'none', point: 'provision', results: [] })
  writeRegistry(root, { ...readRegistry(root), extensions: [{ plugin: 'adf-db@mk', points: ['provision'] }, ...readRegistry(root).extensions] })
  assert.deepEqual(callHook(root, 'provision', {}, { ...CORE, home }), { state: 'none', point: 'provision', results: [], absent: [{ id: 'adf-db@mk', reason: 'not-installed' }] })
  assert.deepEqual(calls(root), [])
  assert.throws(() => callHook(root, 'forge', {}, { ...CORE, home }), /forge is not a hook point/)
  assert.deepEqual(hookProviders(root, 'teardown', { ...CORE, home }).plugins.map((p) => p.declaration.name), ['other'])
})

test('callHook: degraded when one is degraded and none refused; every provider still runs', () => {
  const root = hookHost([
    { name: 'one', points: ['teardown'], script: hookScript('degraded', { hint: 'start the server' }), config: { name: 'one' } },
    { name: 'two', points: ['teardown'], script: hookScript('done'), config: { name: 'two' } }
  ])
  const out = callHook(root, 'teardown', {}, { ...CORE, home })
  assert.equal(out.state, 'degraded')
  assert.deepEqual(out.results.map((r) => r.state), ['degraded', 'done'])
  assert.equal(out.results[0].hint, 'start the server')
  assert.deepEqual(calls(root), ['one teardown', 'two teardown'])
})

test('callHook: the first refusal stops the providers after it, which are named and never called', () => {
  const root = hookHost([
    { name: 'one', script: hookScript('done'), config: { name: 'one' } },
    { name: 'two', script: hookScript('refused', { error: 'no server' }), config: { name: 'two' } },
    { name: 'three', script: hookScript('done'), config: { name: 'three' } }
  ])
  const out = callHook(root, 'provision', {}, { ...CORE, home })
  assert.equal(out.state, 'refused')
  assert.deepEqual(out.results.map((r) => [r.plugin, r.state]), [['one', 'done'], ['two', 'refused']])
  assert.equal(out.results[1].error, 'no server')
  assert.deepEqual(out.skipped, ['three'])
  assert.deepEqual(calls(root), ['one provision', 'two provision'])
})

test('callHook: a provider with no parseable result is refused, and stops the rest', () => {
  const root = hookHost([
    { name: 'broken', points: ['verify-check'], script: 'console.log("hello")' },
    { name: 'two', points: ['verify-check'], script: hookScript('done'), config: { name: 'two' } }
  ])
  const out = callHook(root, 'verify-check', {}, { ...CORE, home })
  assert.equal(out.state, 'refused')
  assert.match(out.results[0].error, /broken verify-check returned no result: hello/)
  assert.deepEqual(out.skipped, ['two'])
})

test('the registry takes declarations providing hooks, two providers of one hook included', () => {
  for (const hook of ['provision', 'teardown', 'verify-check']) {
    assert.deepEqual(validateDeclaration({ name: 'p', contract: '1.6', provides: { [hook]: { script: 's.mjs', operations: [hook] } } }, CORE.points), [])
    assert.deepEqual(validateDeclaration({ name: 'p', contract: '1.6', provides: { [hook]: { script: 's.mjs', operations: [] } } }, CORE.points), [`${hook}: operations ${hook} are missing`])
  }
  const root = mkdtempSync(join(tmpdir(), 'adf-hook-'))
  initRegistry(root, CORE.coreContract)
  writeRegistry(root, { ...readRegistry(root), branches: { integration: 'develop', protected: ['develop'] } })
  for (const name of ['a', 'b']) {
    mkdirSync(join(root, 'plugins', name), { recursive: true })
    writeFileSync(join(root, 'plugins', name, 'adf-extension.json'), JSON.stringify({ name, contract: '1.6', provides: { provision: { script: 's.mjs', operations: ['provision'] }, teardown: { script: 's.mjs', operations: ['teardown'] } } }))
    assert.deepEqual(addExtension(root, `plugins/${name}`, { ...CORE, home }).points, ['provision', 'teardown'])
  }
  const check = checkRegistry(root, { ...CORE, home })
  assert.equal(check.ok, true, check.errors.join('; '))
  assert.deepEqual(check.plugins.map((p) => p.name), ['a', 'b'])
})

// ---------------------------------------------------------------- the tracker role

// A fixture tracker: answers each operation from a table, and records its calls.
function trackerHost(answers, { entries } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-tracker-'))
  initRegistry(root, CORE.coreContract)
  if (answers) {
    const dir = join(root, 'plugins', 't')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'adf-extension.json'), JSON.stringify({ name: 't', contract: '1.7', provides: { tracker: { script: 't.mjs', operations: ['check', 'gather', 'start', 'handoff'] } } }))
    writeFileSync(
      join(dir, 't.mjs'),
      `const answers=${JSON.stringify(answers)};let t='';process.stdin.on('data',(d)=>t+=d).on('end',()=>{const op=process.argv[2];const j=JSON.parse(t);const a=answers[op+(j.input.apply?':apply':'')]??answers[op];console.log(JSON.stringify(a))})`
    )
  }
  writeRegistry(root, { ...readRegistry(root), extensions: entries ?? (answers ? [{ path: 'plugins/t', points: ['tracker'] }] : []) })
  return root
}

test('tracker: with no provider every operation is none and the report says the step was skipped', () => {
  const root = trackerHost(null)
  for (const op of ['check', 'gather', 'start', 'handoff']) {
    const result = callRole(root, 'tracker', op, {}, { ...CORE, home })
    assert.deepEqual(result, { state: 'none', point: 'tracker' })
    assert.equal(trackerReport(op, result), `Tracker ${op}: none; no tracker plugin is enabled; the tracker step was skipped.`)
  }
})

test('tracker: an absent registry entry is named as callRole names it', () => {
  const root = trackerHost(null, { entries: [{ plugin: 'adf-tracker@mk', points: ['tracker'] }] })
  const result = callRole(root, 'tracker', 'start', {}, { ...CORE, home })
  assert.deepEqual(result, { state: 'none', point: 'tracker', absent: [{ id: 'adf-tracker@mk', reason: 'not-installed' }] })
  assert.equal(
    trackerReport('start', result),
    'Tracker start: none; no tracker plugin is enabled; the tracker step was skipped.\nadf-tracker@mk is in the registry but not installed; the tracker start was skipped.'
  )
})

test('tracker: the held shape and the applied shape are rendered for the developer', () => {
  const root = trackerHost({
    check: { state: 'done', tool: 'ready', account: 'dev' },
    start: { state: 'done', held: true, plan: 'p1', preview: ['K-1: Open -> In Progress, assignee dev'] },
    'start:apply': { state: 'done', applied: ['K-1'], skipped: [{ key: 'K-2', reason: 'moved by hand' }], failed: [] },
    handoff: { state: 'degraded', tool: 'unauthenticated', hint: 'create a new token' }
  })
  const core = { ...CORE, home }
  assert.equal(trackerReport('check', callRole(root, 'tracker', 'check', {}, core)), 'Tracker: ready as dev')
  assert.equal(trackerReport('check', { state: 'done', tool: 'ready', account: 'dev', notes: ['config.statuses.initial is unset'] }), 'Tracker: ready as dev\n  note: config.statuses.initial is unset')
  const held = callRole(root, 'tracker', 'start', { items: [{ key: 'K-1' }] }, core)
  assert.deepEqual([held.held, held.plan, held.plugin], [true, 'p1', 't'])
  assert.equal(trackerReport('start', held), "Tracker start: held for the developer's yes; plan p1\n  K-1: Open -> In Progress, assignee dev")
  assert.equal(trackerReport('start', callRole(root, 'tracker', 'start', { apply: 'p1' }, core)), 'Tracker start: applied K-1; skipped K-2 (moved by hand); failed none')
  assert.equal(trackerReport('handoff', callRole(root, 'tracker', 'handoff', {}, core)), 'Tracker handoff: not done (unauthenticated). create a new token')
  assert.equal(trackerReport('gather', { state: 'refused', error: 'K-9 is outside the allowlist' }), 'Tracker gather: refused; K-9 is outside the allowlist')
  assert.equal(trackerReport('gather', { state: 'done', items: [{ key: 'K-1' }], notes: ['K-9 is outside the allowlist'] }), 'Tracker gather: 1 item(s): K-1\n  note: K-9 is outside the allowlist')
})
