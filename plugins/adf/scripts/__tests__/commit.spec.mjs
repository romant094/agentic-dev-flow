// commit.mjs against real git repositories: a host on develop with one change in its own worktree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBranches } from '../lib/branches.mjs'
import { commitPaths, normalizePath, Refusal } from '../lib/commit.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { create, gitIn } from '../lib/workspace.mjs'
import { run, UsageError } from '../commit.mjs'

const CLI = fileURLToPath(new URL('../commit.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function host() {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-commit-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: ['release'] })
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  const { root: change } = create(root, { change: 'add-x', branch: 'feat/add-x', base: 'integration' })
  return { root, change }
}

function writeChange(change) {
  const dir = join(change, 'openspec', 'changes', 'add-x')
  mkdirSync(join(dir, 'specs', 'cap'), { recursive: true })
  writeFileSync(join(dir, 'proposal.md'), 'p\n')
  writeFileSync(join(dir, 'specs', 'cap', 'spec.md'), 's\n')
}

test('commits only the named paths, with the message unchanged', () => {
  const { change } = host()
  writeChange(change)
  writeFileSync(join(change, 'a.txt'), 'changed but not named\n')
  const message = 'docs(openspec): propose add-x'
  const out = commitPaths(change, { only: ['openspec/changes/add-x'], message })
  assert.equal(out.ok, true)
  assert.equal(out.commit, git(change, 'rev-parse', 'HEAD'))
  assert.equal(out.branch, 'feat/add-x')
  assert.deepEqual(out.files.sort(), ['openspec/changes/add-x/proposal.md', 'openspec/changes/add-x/specs/cap/spec.md'])
  assert.equal(git(change, 'log', '-1', '--format=%B'), message, 'no trailer is appended')
  assert.equal(git(change, 'status', '--porcelain', '--', 'a.txt'), 'M a.txt', 'an unnamed change stays uncommitted')
})

test('an absolute path inside the root and a tracked file both commit', () => {
  const { change } = host()
  writeFileSync(join(change, 'a.txt'), 'b\n')
  const out = commitPaths(change, { only: [join(change, 'a.txt')], message: 'chore: a' })
  assert.deepEqual(out.files, ['a.txt'])
})

test('another staged file refuses, and nothing new is staged', () => {
  const { change } = host()
  writeChange(change)
  writeFileSync(join(change, 'b.txt'), 'b\n')
  git(change, 'add', 'b.txt')
  const head = git(change, 'rev-parse', 'HEAD')
  assert.throws(() => commitPaths(change, { only: ['openspec/changes/add-x'], message: 'm' }), (e) => e instanceof Refusal && /b\.txt/.test(e.message))
  assert.equal(git(change, 'rev-parse', 'HEAD'), head)
  assert.equal(git(change, 'diff', '--cached', '--name-only'), 'b.txt')
})

test('the main checkout, a protected branch and a detached HEAD refuse', () => {
  const { root, change } = host()
  writeFileSync(join(root, 'a.txt'), 'b\n')
  assert.throws(() => commitPaths(root, { only: ['a.txt'], message: 'm' }), /is the main checkout/)

  writeFileSync(join(change, 'a.txt'), 'b\n')
  setBranches(change, { integration: 'develop', protected: ['feat/add-x'] })
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }), /feat\/add-x is protected/)
  setBranches(change, { integration: 'develop', protected: [] })

  git(change, 'checkout', '-q', '--detach')
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }), /HEAD is detached/)
})

test('a failed or empty branch read refuses; it never passes the protected-branch guard', () => {
  const { change } = host()
  writeFileSync(join(change, 'a.txt'), 'b\n')
  const real = gitIn(change)
  const failing = (...args) => {
    if (args[0] === 'branch') throw Object.assign(new Error('fatal'), { stderr: 'fatal: not a git repository' })
    return real(...args)
  }
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }, { git: failing }), /failed to read the current branch/)
  const empty = (...args) => (args[0] === 'branch' ? '' : real(...args))
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }, { git: empty }), /HEAD is detached/)
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'adf-commit-none-')))
  assert.throws(() => commitPaths(notRepo, { only: ['a.txt'], message: 'm' }), /failed to read the top level/)
})

test('nothing to commit, an empty message and paths outside the root refuse', () => {
  const { change } = host()
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }), /nothing to commit/)
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: ' ' }), /message is empty/)
  assert.throws(() => commitPaths(change, { only: [], message: 'm' }), /no path/)
  assert.throws(() => normalizePath(change, '../x'), /outside/)
  assert.throws(() => normalizePath(change, '.'), /whole repository/)
  assert.equal(normalizePath(change, './openspec/changes/'), 'openspec/changes')
})

test('a registry with no branch policy refuses: the protected list is unknown', () => {
  const { change } = host()
  writeFileSync(join(change, 'a.txt'), 'b\n')
  rmSync(join(change, '.claude', 'adf-extensions.json'))
  assert.throws(() => commitPaths(change, { only: ['a.txt'], message: 'm' }), /run \/adf:init/)
})

test('the CLI parses repeated --only and refuses a wrong call as a usage error', () => {
  assert.throws(() => run(['--only', 'a']), UsageError)
  assert.throws(() => run(['--message', 'm']), UsageError)
  assert.throws(() => run(['--only', 'a', '--message', 'm', 'extra']), UsageError)
  assert.throws(() => run(['--root', 'a', '--root', 'b', '--only', 'a', '--message', 'm']), UsageError)
})

test('the CLI prints one JSON object and exits 0, 1 on a refusal, 2 on a usage error', () => {
  const { root, change } = host()
  writeChange(change)
  writeFileSync(join(change, 'a.txt'), 'b\n')
  const call = (...args) => {
    const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  const done = call('--root', change, '--only', 'openspec/changes/add-x', '--only', 'a.txt', '--message', 'm')
  assert.equal(done.code, 0)
  assert.equal(done.out.files.length, 3)
  const refused = call('--root', root, '--only', 'a.txt', '--message', 'm')
  assert.equal(refused.code, 1)
  assert.match(refused.out.error, /main checkout/)
  const usage = call('--root', change)
  assert.equal(usage.code, 2)
  assert.ok(usage.out.usage)
})
