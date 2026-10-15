// workspace.mjs group-merge with the merge review's package, and group-finish.
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { addGroup, groupState, listGroups, mergeGroup } from '../lib/groups.mjs'
import { run } from '../workspace.mjs'
import { commitIn, git, host, superpowersHome } from './git-host.mjs'

const PLAN = '# Plan\n\n### Task 1: one\n'

test('group-merge returns the merge commit, its first parent and the package between them', () => {
  const { change } = host({ 'plan.md': PLAN })
  const home = superpowersHome()
  const group = addGroup(change, { change: 'add-x', group: 1 })
  commitIn(group.root, 'g1.txt', 'one\n')
  const before = git(change, 'rev-parse', 'HEAD')
  const out = run(['group-merge', '--change', 'add-x', '--group', '1', '--root', change, '--home', home])
  assert.equal(out.merged, true)
  assert.equal(out.already, false)
  assert.equal(out.firstParent, before)
  assert.equal(out.mergeCommit, git(change, 'rev-parse', 'HEAD'))
  assert.equal(out.package.ok, true, out.package.error)
  assert.equal(out.package.file, join(change, `.superpowers/sdd/add-x/review-${before.slice(0, 7)}..${out.mergeCommit.slice(0, 7)}.diff`))
  assert.match(readFileSync(out.package.file, 'utf8'), /g1\.txt/)
  const again = run(['group-merge', '--change', 'add-x', '--group', '1', '--root', change, '--home', home])
  assert.deepEqual([again.already, again.mergeCommit, again.firstParent], [true, out.mergeCommit, before])
})

test('after a conflict the resolver commits, and a second group-merge reports that merge', () => {
  const { change } = host({ 'plan.md': PLAN })
  const one = addGroup(change, { change: 'add-x', group: 1 })
  const two = addGroup(change, { change: 'add-x', group: 2 })
  commitIn(one.root, 'a.txt', 'one\n')
  commitIn(two.root, 'a.txt', 'two\n')
  mergeGroup(change, { change: 'add-x', group: 1 })
  const firstParent = git(change, 'rev-parse', 'HEAD')
  assert.equal(mergeGroup(change, { change: 'add-x', group: 2 }).merged, false)
  assert.throws(() => mergeGroup(change, { change: 'add-x', group: 2 }), /merge is in progress/)
  writeFileSync(join(change, 'a.txt'), 'both\n')
  git(change, 'add', 'a.txt')
  git(change, 'commit', '-q', '--no-edit')
  const done = run(['group-merge', '--change', 'add-x', '--group', '2', '--root', change, '--home', superpowersHome()])
  assert.deepEqual([done.merged, done.already, done.firstParent, done.mergeCommit], [true, true, firstParent, git(change, 'rev-parse', 'HEAD')])
  assert.equal(done.package.ok, true)
})

test('a package that cannot be cut leaves the merge standing and says why', () => {
  const { change } = host({ 'plan.md': PLAN })
  const group = addGroup(change, { change: 'add-x', group: 1 })
  commitIn(group.root, 'g1.txt', 'one\n')
  const out = run(['group-merge', '--change', 'add-x', '--group', '1', '--root', change, '--home', join(superpowersHome(), 'none')])
  assert.equal(out.merged, true)
  assert.equal(out.package.ok, false)
  assert.match(out.package.error, /not installed/)
})

test('group-finish removes the merged group and pushes through the forge role, none with no provider', () => {
  const { root, change } = host({ 'plan.md': PLAN })
  const group = addGroup(change, { change: 'add-x', group: 1 })
  commitIn(group.root, 'g1.txt', 'one\n')
  assert.throws(() => run(['group-finish', '--change', 'add-x', '--group', '1', '--root', change]), /not merged/)
  mergeGroup(change, { change: 'add-x', group: 1 })
  const out = run(['group-finish', '--change', 'add-x', '--group', '1', '--root', change])
  assert.deepEqual(out.removed, { removed: join(root, '.claude/worktrees/add-x--group-1'), branch: 'feat/add-x--group-1' })
  assert.deepEqual(out.push, { state: 'none' })
  assert.equal(existsSync(group.root), false)
  assert.deepEqual(listGroups(change, 'add-x'), [])
  const kept = JSON.parse(readFileSync(join(change, '.superpowers/sdd/add-x/push.json'), 'utf8'))
  assert.deepEqual([kept.state, kept.group, kept.branch], ['none', 1, 'feat/add-x'])
  assert.deepEqual(groupState(change, 'add-x')(1), { merged: true, kept: false })
  assert.deepEqual(groupState(change, 'add-x')(2), { merged: false, kept: false })
})
