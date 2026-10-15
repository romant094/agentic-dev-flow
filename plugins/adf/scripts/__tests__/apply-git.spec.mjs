// Group worktrees, change resolution and the dispatch guard, against real git repositories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setBranches } from '../lib/branches.mjs'
import { addBaseCheck, addGroup, baseCheckPath, listGroups, mergeGroup, removeBaseCheck, removeGroup } from '../lib/groups.mjs'
import { compare, snapshot } from '../lib/guard.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { findChanges } from '../lib/resolve.mjs'
import { loadSchema } from '../lib/schema.mjs'
import { create } from '../lib/workspace.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const schema = loadSchema()

// A host on develop with one change in its own worktree, holding a tasks file.
function host() {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-apply-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: [] })
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  const made = create(root, { change: 'add-x', branch: 'feat/add-x', base: 'integration' })
  const dir = join(made.root, 'openspec', 'changes', 'add-x')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tasks.md'), '- [x] 1.1 a\n- [ ] 1.2 b\n')
  git(made.root, 'add', '.')
  git(made.root, 'commit', '-q', '-m', 'propose')
  return { root, change: made.root }
}

function commitIn(dir, file, text) {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', file)
}

test('find reads every checkout and reports the change where it lives', () => {
  const { root, change } = host()
  const { changes } = findChanges(root, schema)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].name, 'add-x')
  assert.equal(changes[0].root, change)
  assert.equal(changes[0].branch, 'feat/add-x')
  assert.equal(changes[0].main, false)
  assert.equal(changes[0].completedTasks, 1)
  assert.deepEqual(findChanges(root, schema).unresolved, [])
  addGroup(change, { change: 'add-x', group: 1 })
  assert.equal(findChanges(change, schema).changes.length, 1, 'a group worktree is not a change of its own')
})

test('a group is made from the change branch at the main checkout, merged and removed', () => {
  const { root, change } = host()
  const made = addGroup(change, { change: 'add-x', group: 1 })
  assert.deepEqual(made, { root: join(root, '.claude/worktrees/add-x--group-1'), branch: 'feat/add-x--group-1', from: 'feat/add-x' })
  assert.deepEqual(listGroups(change, 'add-x'), [{ group: 1, root: made.root }])
  assert.throws(() => addGroup(change, { change: 'add-x', group: 1 }), /already has a worktree/)
  commitIn(made.root, 'g1.txt', 'one\n')
  assert.throws(() => removeGroup(change, { change: 'add-x', group: 1 }), /not merged/)
  const merged = mergeGroup(change, { change: 'add-x', group: 1 })
  assert.equal(merged.merged, true)
  assert.equal(existsSync(join(change, 'g1.txt')), true)
  assert.deepEqual(removeGroup(change, { change: 'add-x', group: 1 }), { removed: made.root, branch: 'feat/add-x--group-1' })
  assert.deepEqual(listGroups(change, 'add-x'), [])
  assert.throws(() => addGroup(change, { change: 'add-x', group: 0 }), /not a positive number/)
})

test('a conflicting merge lists the files and stays in progress for the resolver', () => {
  const { change } = host()
  const one = addGroup(change, { change: 'add-x', group: 1 })
  const two = addGroup(change, { change: 'add-x', group: 2 })
  commitIn(one.root, 'a.txt', 'one\n')
  commitIn(two.root, 'a.txt', 'two\n')
  assert.equal(mergeGroup(change, { change: 'add-x', group: 1 }).merged, true)
  const second = mergeGroup(change, { change: 'add-x', group: 2 })
  assert.deepEqual({ merged: second.merged, conflicts: second.conflicts }, { merged: false, conflicts: ['a.txt'] })
  assert.equal(existsSync(join(change, '.git')) && git(change, 'rev-parse', '-q', '--verify', 'MERGE_HEAD') !== '', true)
})

test('the guard passes a dispatch that wrote only in its target, and names any other checkout it touched', () => {
  const { root, change } = host()
  const group = addGroup(change, { change: 'add-x', group: 1 })
  const watched = snapshot(change, { change: 'add-x', targets: [group.root] }).watched.sort()
  assert.deepEqual(watched, [change, root].sort())
  commitIn(group.root, 'g.txt', 'g\n')
  assert.deepEqual(compare(change, { change: 'add-x' }), { ok: true, targets: [group.root], changed: [] })
  writeFileSync(join(root, 'stray.txt'), 'x\n')
  const after = compare(change, { change: 'add-x' })
  assert.equal(after.ok, false)
  assert.deepEqual(after.changed.map((c) => c.root), [root])
  assert.throws(() => compare(change, { change: 'other' }), /no snapshot/)
  assert.throws(() => snapshot(change, { change: 'add-x', targets: [] }), /dispatch targets/)
})

test('a worktree with no readable change is listed as unresolved, never dropped', () => {
  const { root } = host()
  create(root, { change: 'fix-y', branch: 'fix/fix-y', base: 'integration' })
  assert.deepEqual(findChanges(root, schema).unresolved, [{ root: join(root, '.claude/worktrees/fix-y'), branch: 'fix/fix-y' }])
})

test('a failed git read stops the group scripts and is reported by the guard', () => {
  const { root, change } = host()
  git(change, 'checkout', '-q', '--detach')
  assert.throws(() => addGroup(change, { change: 'add-x', group: 1 }), /no current branch/)
  git(change, 'checkout', '-q', 'feat/add-x')
  const group = addGroup(change, { change: 'add-x', group: 1 })
  snapshot(change, { change: 'add-x', targets: [change] })
  execFileSync('git', ['-C', change, 'worktree', 'remove', '--force', group.root])
  const after = compare(change, { change: 'add-x' })
  assert.equal(after.ok, false)
  assert.deepEqual(after.changed.map((c) => [c.root, c.after.status]), [[group.root, 'the checkout is gone']])
  assert.equal(root.length > 0, true)
})

test('group listing is per change: another change\'s group worktree is not listed', () => {
  const { root, change } = host()
  const other = create(root, { change: 'add-b', branch: 'feat/add-b', base: 'integration' })
  const theirs = addGroup(other.root, { change: 'add-b', group: 1 })
  const ours = addGroup(change, { change: 'add-x', group: 2 })
  assert.deepEqual(listGroups(change, 'add-x'), [{ group: 2, root: ours.root }])
  assert.deepEqual(listGroups(other.root, 'add-b'), [{ group: 1, root: theirs.root }])
})

// The change's metadata names its base; the change branch moves on past it.
function withBase(change, base = 'develop') {
  writeFileSync(join(change, 'openspec/changes/add-x/.adf.json'), `${JSON.stringify({ base })}\n`)
  git(change, 'add', '.')
  git(change, 'commit', '-q', '-m', 'meta')
}

test('a base check is a detached worktree of the base commit, refused twice, removed once', () => {
  const { root, change } = host()
  withBase(change)
  const base = git(root, 'rev-parse', 'develop')
  assert.notEqual(git(change, 'rev-parse', 'HEAD'), base)
  const path = baseCheckPath(change, 'add-x')
  assert.equal(path, join(root, '.claude/worktrees/add-x--base-check'))
  assert.deepEqual(addBaseCheck(change, { change: 'add-x' }), { root: path, ref: 'develop', commit: base })
  assert.equal(git(path, 'rev-parse', 'HEAD'), base)
  assert.equal(git(path, 'branch', '--show-current'), '', 'the base check is detached')
  assert.throws(() => addBaseCheck(change, { change: 'add-x' }), /already a worktree, a leftover/)
  assert.deepEqual(removeBaseCheck(change, { change: 'add-x' }), { removed: path })
  assert.equal(existsSync(path), false)
  assert.throws(() => removeBaseCheck(change, { change: 'add-x' }), /not a worktree/)
})

test('a base check prefers the remote-tracking base and refuses an unreadable change', () => {
  const { root, change } = host()
  assert.throws(() => addBaseCheck(change, { change: 'add-x' }), /cannot read openspec\/changes\/add-x\/\.adf\.json/)
  withBase(change)
  const first = git(root, 'rev-list', '--max-parents=0', 'develop')
  commitIn(root, 'later.txt', 'later\n')
  git(root, 'update-ref', 'refs/remotes/origin/develop', first)
  const made = addBaseCheck(change, { change: 'add-x' })
  assert.deepEqual([made.ref, made.commit], ['origin/develop', first])
  removeBaseCheck(change, { change: 'add-x' })
  writeFileSync(join(change, 'openspec/changes/add-x/.adf.json'), '{}\n')
  assert.throws(() => addBaseCheck(change, { change: 'add-x' }), /no "base" branch/)
})

test('a dirty base check is never force-removed', () => {
  const { change } = host()
  withBase(change)
  const { root: path } = addBaseCheck(change, { change: 'add-x' })
  writeFileSync(join(path, 'a.txt'), 'changed\n')
  assert.throws(() => removeBaseCheck(change, { change: 'add-x' }), /git refused to remove/)
  assert.equal(existsSync(join(path, 'a.txt')), true)
  assert.equal(git(change, 'worktree', 'list', '--porcelain').includes(`worktree ${path}`), true)
})
