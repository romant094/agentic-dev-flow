import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installDirectories } from '../lib/guard.mjs'

// Every case runs the real hook entry as Claude Code does: the PreToolUse input JSON on stdin,
// against a real repository and a linked worktree of it in the system temp directory.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard.mjs')

// The guard acts only where the registry enables the plugin: every repository but the ones a
// case builds without an entry carries one, committed, so the worktree has it too.
const ENABLED = JSON.stringify({ contract: '1.6', extensions: [{ plugin: 'adf-npm-workspaces@agentic-dev-flow' }] })

function repo(t, { registry = ENABLED } = {}) {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'npm-guard-')))
  t.after(() => rmSync(main, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: main, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(main, 'apps/web'), { recursive: true })
  writeFileSync(join(main, 'apps/web/package.json'), '{}')
  if (registry !== null) {
    mkdirSync(join(main, '.claude'))
    writeFileSync(join(main, '.claude/adf-extensions.json'), registry)
  }
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const worktree = join(main, '.claude/worktrees/feature')
  git('worktree', 'add', '-q', '-b', 'feature', worktree)
  return { main, worktree }
}

function guard(command, cwd, extra = {}) {
  const input = { session_id: 's', hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command }, ...extra }
  const r = spawnSync('node', [GUARD], { input: JSON.stringify(input), encoding: 'utf8' })
  return { code: r.status, stderr: r.stderr, stdout: r.stdout }
}

test('the guard blocks npm install in a worktree from Codex input', (t) => {
  const r = repo(t)
  // The field set of openai/codex codex-rs/hooks/src/schema.rs `PreToolUseCommandInput`, line 279.
  const input = {
    session_id: '019a0000-0000-7000-8000-000000000000',
    turn_id: 't1',
    transcript_path: null,
    cwd: r.worktree,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_use_id: 'call_1',
  }
  const out = spawnSync('node', [GUARD], { input: JSON.stringify(input), encoding: 'utf8' })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /^adf-npm-workspaces: `npm install` is blocked/)
})

test('npm install and its kin are blocked in a linked worktree', (t) => {
  const r = repo(t)
  for (const command of ['npm install', 'npm i left-pad', 'npm ci', 'npm add x', 'npm update', 'npm uninstall x', 'npm install-ci-test']) {
    const out = guard(command, r.worktree)
    assert.equal(out.code, 2, command)
    assert.match(out.stderr, /^adf-npm-workspaces: `npm \S+` is blocked in .*, a linked git worktree\./)
    assert.match(out.stderr, /A dependency update is its own change/)
  }
  assert.equal(guard('npm install', join(r.worktree, 'apps/web')).code, 2)
})

test('no registry: the guard does nothing', (t) => {
  const r = repo(t, { registry: null })
  assert.deepEqual(guard('npm install', r.worktree), { code: 0, stderr: '', stdout: '' })
})

test('a registry without an entry for the plugin: the guard does nothing', (t) => {
  const r = repo(t, { registry: JSON.stringify({ contract: '1.6', extensions: [{ plugin: 'other@agentic-dev-flow' }] }) })
  assert.deepEqual(guard('npm install', r.worktree), { code: 0, stderr: '', stdout: '' })
})

test('a path entry whose declaration is named adf-npm-workspaces enables the guard', (t) => {
  const r = repo(t, { registry: JSON.stringify({ contract: '1.6', extensions: [{ path: 'vendor/nw' }] }) })
  mkdirSync(join(r.main, 'vendor/nw'), { recursive: true })
  writeFileSync(join(r.main, 'vendor/nw/adf-extension.json'), JSON.stringify({ name: 'adf-npm-workspaces', contract: '1.6' }))
  assert.equal(guard('npm install', r.worktree).code, 2)
})

test('the main checkout is allowed', (t) => {
  const r = repo(t)
  assert.deepEqual(guard('npm install', r.main), { code: 0, stderr: '', stdout: '' })
  assert.equal(guard('npm ci', join(r.main, 'apps/web')).code, 0)
})

test('cd, --prefix and -C move the effective directory', (t) => {
  const r = repo(t)
  assert.equal(guard(`cd ${r.worktree} && npm install`, r.main).code, 2)
  assert.equal(guard(`cd "${r.worktree}/apps/web"; npm i`, r.main).code, 2)
  assert.equal(guard('cd .claude/worktrees/feature && npm ci', r.main).code, 2)
  assert.equal(guard(`npm --prefix ${r.worktree} install`, r.main).code, 2)
  assert.equal(guard(`npm --prefix=${r.worktree} ci`, r.main).code, 2)
  assert.equal(guard(`npm -C ${r.worktree} update`, r.main).code, 2)
  assert.equal(guard(`npm --prefix ${r.main} install`, r.worktree).code, 0)
  assert.equal(guard(`cd ${r.main} && npm install`, r.worktree).code, 0)
  assert.equal(guard(`npm install && cd ${r.worktree}`, r.main).code, 0)
  assert.equal(guard('FOO=1 npm install', r.worktree).code, 2)
  assert.equal(guard(`(cd ${r.worktree} && npm install)`, r.main).code, 2)
})

test('other commands are ignored', (t) => {
  const r = repo(t)
  for (const command of ['npm test', 'npm run build', 'npm ls', 'npm exec -- tsc', 'npm install -g some-cli', 'git status', 'echo npm install', 'ls node_modules']) {
    assert.deepEqual(guard(command, r.worktree), { code: 0, stderr: '', stdout: '' }, command)
  }
  assert.equal(guard('npm install', r.worktree, { tool_name: 'Read' }).code, 0)
})

test('outside a repository, a cd to a variable and an open quote are allowed', (t) => {
  const r = repo(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'npm-guard-out-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal(guard('npm install', outside).code, 0)
  assert.equal(guard('cd "$DIR" && npm install', r.main).code, 0)
  assert.equal(guard('npm install "open', r.worktree).code, 0)
})

test('a guard that cannot run fails open: exit 1 and a warning, never a block', () => {
  const r = spawnSync('node', [GUARD], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^adf-npm-workspaces: the install guard could not run \(.*\); this command was not checked\.\n$/)
})

test('installDirectories reads the effective directory of each npm command', () => {
  assert.deepEqual(installDirectories('npm i && cd sub && npm --workspace a ci', '/repo'), [
    { sub: 'i', dir: '/repo' },
    { sub: 'ci', dir: '/repo/sub' }
  ])
  assert.deepEqual(installDirectories('cd $X && npm i', '/repo'), [{ sub: 'i', dir: null }])
  assert.deepEqual(installDirectories('npm run install', '/repo'), [])
})
