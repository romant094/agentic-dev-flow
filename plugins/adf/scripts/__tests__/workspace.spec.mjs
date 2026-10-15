// Against real git repositories in temp directories: a bare remote and a clone of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectIntegration, readBranches, setBranches } from '../lib/branches.mjs'
import { createPlanningGuide, ignoreLocalDirs } from '../lib/host-files.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { branchType, create, gitIn, suggest } from '../lib/workspace.mjs'

const quiet = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })

function host({ remote = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'adf-ws-')))
  const root = join(base, 'host')
  quiet(base, 'init', '-q', '-b', 'develop', root)
  quiet(root, 'config', 'user.email', 't@example.com')
  quiet(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'README.md'), 'host\n')
  quiet(root, 'add', '.')
  quiet(root, 'commit', '-q', '-m', 'init')
  if (remote) {
    quiet(base, 'clone', '-q', '--bare', root, 'origin.git')
    quiet(root, 'remote', 'add', 'origin', join(base, 'origin.git'))
    quiet(root, 'fetch', '-q', 'origin')
    quiet(root, 'remote', 'set-head', 'origin', 'develop')
  }
  initRegistry(root, '1.0')
  setBranches(root, { integration: 'develop', protected: ['main'] })
  ignoreLocalDirs(root)
  quiet(root, 'add', '.')
  quiet(root, 'commit', '-q', '-m', 'adf')
  if (remote) quiet(root, 'push', '-q', 'origin', 'develop')
  return root
}

test('branchType maps the change name prefix and returns null otherwise', () => {
  assert.equal(branchType('add-licensing'), 'feat')
  assert.equal(branchType('fix-timeout'), 'fix')
  assert.equal(branchType('refactor-store'), 'refactor')
  assert.equal(branchType('restructure-store'), 'refactor')
  assert.equal(branchType('licensing'), null)
})

test('the branch policy always protects the integration branch', () => {
  const root = host({ remote: false })
  assert.deepEqual(readBranches(root), { integration: 'develop', protected: ['develop', 'main'] })
  assert.throws(() => setBranches(root, { integration: 'two words' }), /integration/)
})

test('detectIntegration reads origin/HEAD, and is null without a remote', () => {
  assert.equal(detectIntegration(host()), 'develop')
  assert.equal(detectIntegration(host({ remote: false })), null)
})

test('suggest offers only the integration base on a protected branch', () => {
  const root = host()
  const s = suggest(root, 'add-thing')
  assert.equal(s.current, 'develop')
  assert.deepEqual(s.bases, ['integration'])
  assert.equal(s.branch, 'feat/add-thing')
  assert.equal(s.path, join(root, '.claude/worktrees/add-thing'))
  assert.deepEqual(s.dirty, [])
})

test('suggest keeps every dirty line as git prints it, the first one included', () => {
  const root = host({ remote: false })
  writeFileSync(join(root, 'README.md'), 'changed\n')
  writeFileSync(join(root, 'second.txt'), 'x\n')
  quiet(root, 'add', 'second.txt')
  quiet(root, 'commit', '-q', '-m', 'second')
  writeFileSync(join(root, 'second.txt'), 'y\n')
  assert.deepEqual(suggest(root, 'add-thing').dirty, [' M README.md', ' M second.txt'])
})

test('suggest offers the current branch when the developer is mid-feature', () => {
  const root = host()
  quiet(root, 'switch', '-q', '-c', 'feat/mine')
  assert.deepEqual(suggest(root, 'thing').bases, ['integration', 'current'])
  assert.equal(suggest(root, 'thing').branch, null)
})

test('create forks from the fetched integration branch and leaves the checkout alone', () => {
  const root = host()
  quiet(root, 'switch', '-q', '-c', 'feat/mine')
  const made = create(root, { change: 'add-thing', branch: 'feat/add-thing', base: 'integration' })
  assert.deepEqual(made, {
    root: join(root, '.claude/worktrees/add-thing'),
    branch: 'feat/add-thing',
    base: 'develop',
    baseRef: 'origin/develop'
  })
  assert.equal(gitIn(root)('branch', '--show-current'), 'feat/mine')
  assert.equal(gitIn(made.root)('branch', '--show-current'), 'feat/add-thing')
  assert.equal(gitIn(root)('status', '--porcelain'), '')
})

test('create forks from the current branch and records it as the base', () => {
  const root = host({ remote: false })
  quiet(root, 'switch', '-q', '-c', 'feat/mine')
  const made = create(root, { change: 'thing', branch: 'feat/thing', base: 'current' })
  assert.equal(made.base, 'feat/mine')
  assert.equal(made.baseRef, 'feat/mine')
})

test('create uses the local integration branch when the host has no remote', () => {
  const root = host({ remote: false })
  assert.equal(create(root, { change: 'thing', branch: 'feat/thing', base: 'integration' }).baseRef, 'develop')
})

test('create refuses a protected branch, a protected base and a repeated change', () => {
  const root = host()
  assert.throws(() => create(root, { change: 'x', branch: 'main', base: 'integration' }), /protected/)
  assert.throws(() => create(root, { change: 'x', branch: 'feat/x', base: 'current' }), /develop is protected/)
  assert.throws(() => create(root, { change: 'x', branch: 'feat/x', base: 'elsewhere' }), /base must be/)
  create(root, { change: 'x', branch: 'feat/x', base: 'integration' })
  assert.throws(() => create(root, { change: 'x', branch: 'feat/y', base: 'integration' }), /already exists/)
  assert.throws(() => create(root, { change: 'y', branch: 'feat/x', base: 'integration' }), /branch feat\/x already exists/)
})

test('create stops on uncommitted tracked changes but not on untracked files', () => {
  const root = host()
  writeFileSync(join(root, 'stray.txt'), 'untracked\n')
  create(root, { change: 'a', branch: 'feat/a', base: 'integration' })
  writeFileSync(join(root, 'README.md'), 'edited\n')
  assert.throws(() => create(root, { change: 'b', branch: 'feat/b', base: 'integration' }), /M README\.md/)
  assert.equal(existsSync(join(root, '.claude/worktrees/b')), false)
})

test('create refuses when the worktrees directory is not ignored', () => {
  const root = host({ remote: false })
  writeFileSync(join(root, '.gitignore'), '')
  quiet(root, 'commit', '-q', '-am', 'unignore')
  assert.throws(() => create(root, { change: 'a', branch: 'feat/a', base: 'integration' }), /not ignored/)
})

test('create refuses without a branch policy', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'adf-ws-')))
  quiet(base, 'init', '-q')
  initRegistry(base, '1.0')
  assert.throws(() => suggest(base, 'a'), /sets no branches/)
})

test('ignoreLocalDirs and createPlanningGuide add only what is missing', () => {
  const root = host({ remote: false })
  assert.deepEqual(ignoreLocalDirs(root), { added: [] })
  assert.equal(createPlanningGuide(root).created, true)
  assert.equal(createPlanningGuide(root).created, false)
})
