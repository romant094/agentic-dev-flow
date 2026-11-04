import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RUNTIMES, cacheDir, cli, detectRuntime, installCommand, runtimeHome, sessionId } from '../lib/runtime.mjs'

function homes() {
  return {
    'claude-code': mkdtempSync(join(tmpdir(), 'adf-claude-')),
    codex: mkdtempSync(join(tmpdir(), 'adf-codex-'))
  }
}

function script(home) {
  const dir = join(home, 'plugins', 'cache', 'market', 'adf', '1.0.0', 'scripts')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'x.mjs')
  writeFileSync(file, '')
  return file
}

test('ADF_RUNTIME wins', () => {
  const h = homes()
  const env = { ADF_RUNTIME: 'codex', CLAUDE_CODE_SESSION_ID: 's' }
  assert.equal(detectRuntime({ env, scriptPath: script(h['claude-code']), homes: h }), 'codex')
})

test('a script under the Codex cache is codex', () => {
  const h = homes()
  assert.equal(detectRuntime({ env: {}, scriptPath: script(h.codex), homes: h }), 'codex')
})

test('a script under the Claude cache is claude-code', () => {
  const h = homes()
  const env = { CODEX_THREAD_ID: 't' }
  assert.equal(detectRuntime({ env, scriptPath: script(h['claude-code']), homes: h }), 'claude-code')
})

test('CODEX_THREAD_ID alone is codex', () => {
  assert.equal(detectRuntime({ env: { CODEX_THREAD_ID: 't' } }), 'codex')
})

test('CLAUDE_CODE_SESSION_ID alone is claude-code', () => {
  assert.equal(detectRuntime({ env: { CLAUDE_CODE_SESSION_ID: 's' } }), 'claude-code')
})

test('a clone with no runtime env is claude-code', () => {
  const h = homes()
  const clone = join(mkdtempSync(join(tmpdir(), 'adf-clone-')), 'x.mjs')
  assert.equal(detectRuntime({ env: {}, scriptPath: clone, homes: h }), 'claude-code')
})

test('a symlinked home is compared resolved', () => {
  const real = mkdtempSync(join(tmpdir(), 'adf-real-home-'))
  const link = join(mkdtempSync(join(tmpdir(), 'adf-link-')), '.codex')
  symlinkSync(real, link)
  const h = { 'claude-code': mkdtempSync(join(tmpdir(), 'adf-claude-')), codex: link }
  assert.equal(detectRuntime({ env: {}, scriptPath: script(real), homes: h }), 'codex')
})

test('sessionId reads the runtime variable', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'c1', CODEX_THREAD_ID: 'x1' }
  assert.equal(sessionId('claude-code', env), 'c1')
  assert.equal(sessionId('codex', env), 'x1')
  assert.equal(sessionId('codex', {}), null)
})

test('homes, cache, cli and install command per runtime', () => {
  assert.deepEqual(RUNTIMES, ['claude-code', 'codex'])
  assert.equal(runtimeHome('claude-code', { CLAUDE_CONFIG_DIR: '/c' }), '/c')
  assert.equal(runtimeHome('codex', { CODEX_HOME: '/x' }), '/x')
  assert.equal(runtimeHome('codex', {}), join(homedir(), '.codex'))
  assert.equal(cacheDir('codex', '/x'), join('/x', 'plugins', 'cache'))
  assert.equal(cacheDir('claude-code', '/c'), join('/c', 'plugins', 'cache'))
  assert.equal(cli('codex'), 'codex')
  assert.equal(cli('claude-code'), 'claude')
  assert.equal(installCommand('claude-code', 'a@b', 'user'), 'claude plugin install a@b --scope user')
  assert.equal(installCommand('codex', 'a@b', 'user'), 'codex plugin add a@b')
})
