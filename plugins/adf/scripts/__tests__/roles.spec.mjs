import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRegistry, writeRegistry, readRegistry } from '../lib/registry.mjs'
import { callRole } from '../lib/roles.mjs'

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
  assert.deepEqual(forge(host(), 'check'), { code: 0, out: { state: 'none', point: 'forge' } })
})

test('the provider gets the operation, its config and the input, in the host root', () => {
  const out = forge(host(ECHO), 'open', '--input', '{"change":"x"}').out
  assert.deepEqual(out, { state: 'done', op: 'open', config: { host: 'h' }, input: { change: 'x' }, cwd: true, plugin: 'fake' })
})

test('a provider that prints no result, or an unknown operation, is refused with exit 1', () => {
  const broken = forge(host('console.log("hello")'), 'check')
  assert.equal(broken.code, 1)
  assert.match(broken.out.error, /fake check returned no result: hello/)
  assert.match(forge(host(ECHO), 'merge').out.error, /forge has no operation merge/)
  assert.match(forge(host(ECHO), 'open', '--input').out.error, /--input needs a value/)
})

test('callRole refuses an operation the point does not declare, before looking for a provider', () => {
  const core = { points: { forge: { operations: ['check'] } } }
  assert.throws(() => callRole(host(), 'forge', 'merge', {}, core), /forge has no operation merge/)
})
