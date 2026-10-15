// Task groups that run in parallel get a worktree each, branched from the change branch, and
// are merged back into it one by one. Every path is rooted at the main checkout: run from
// inside the change worktree, a relative `.claude/worktrees/...` would nest the group inside
// it, where removing the change worktree strands the group.
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir, META_FILE } from './changes.mjs'
import { mainCheckout } from './installed.mjs'
import { baseRef } from './plan-symbols.mjs'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'

const GROUP = /^[1-9]\d*$/

function attempt(git, ...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

function changeBranch(git) {
  const branch = attempt(git, 'branch', '--show-current')
  if (!branch) throw new Error('the change worktree has no current branch; run this from the change worktree')
  return branch
}

function names(changeRoot, change, group) {
  if (!GROUP.test(String(group ?? ''))) throw new Error(`group "${group}" is not a positive number`)
  const git = gitIn(changeRoot)
  const branch = changeBranch(git)
  return {
    git,
    branch,
    groupBranch: `${branch}--group-${group}`,
    path: join(mainCheckout(changeRoot), WORKTREES_DIR, `${change}--group-${group}`)
  }
}

const isWorktree = (git, path) =>
  (attempt(git, 'worktree', 'list', '--porcelain') ?? '').split('\n').includes(`worktree ${path}`)

export function addGroup(changeRoot, { change, group }) {
  const { git, branch, groupBranch, path } = names(changeRoot, change, group)
  if (isWorktree(git, path)) throw new Error(`group ${group} of ${change} already has a worktree at ${path}`)
  if (attempt(git, 'rev-parse', '--verify', '--quiet', `refs/heads/${groupBranch}`)) {
    throw new Error(`branch ${groupBranch} already exists`)
  }
  git('worktree', 'add', path, '-b', groupBranch, 'HEAD')
  if (realpathSync(gitIn(path)('rev-parse', '--show-toplevel')) !== realpathSync(path)) {
    throw new Error(`the group worktree does not resolve to ${path}; stop`)
  }
  return { root: path, branch: groupBranch, from: branch }
}

// A conflict leaves the merge in progress for the subagent that resolves it.
export function mergeGroup(changeRoot, { change, group }) {
  const { git, branch, groupBranch } = names(changeRoot, change, group)
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty !== '') throw new Error(`the change worktree has uncommitted changes:\n${dirty}`)
  try {
    git('merge', '--no-ff', '--no-edit', groupBranch)
  } catch {
    const conflicts = (attempt(git, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
    if (conflicts.length === 0) throw new Error(`merging ${groupBranch} into ${branch} failed without a conflict`)
    return { merged: false, into: branch, branch: groupBranch, conflicts }
  }
  return { merged: true, into: branch, branch: groupBranch, commit: git('rev-parse', 'HEAD'), conflicts: [] }
}

// Only a merged group is removed; a blocked group keeps its worktree and branch.
export function removeGroup(changeRoot, { change, group }) {
  const { git, groupBranch, path } = names(changeRoot, change, group)
  if (attempt(git, 'merge-base', '--is-ancestor', groupBranch, 'HEAD') === null) {
    throw new Error(`${groupBranch} is not merged into the change branch; a blocked group keeps its worktree`)
  }
  if (isWorktree(git, path)) git('worktree', 'remove', path)
  git('branch', '-d', groupBranch)
  return { removed: path, branch: groupBranch }
}

export function listGroups(changeRoot, change) {
  const git = gitIn(changeRoot)
  const prefix = join(mainCheckout(changeRoot), WORKTREES_DIR, `${change}--group-`)
  return (attempt(git, 'worktree', 'list', '--porcelain') ?? '')
    .split('\n')
    .filter((line) => line.startsWith(`worktree ${prefix}`))
    .map((line) => {
      const path = line.slice('worktree '.length)
      return { group: Number(path.slice(prefix.length)), root: path }
    })
}

// The whole-suite run checks whether a failure is pre-existing in a throwaway, detached
// worktree of the change's base, never by stashing. The base is the change's `.adf.json` base,
// resolved as plan-symbols resolves it: the remote-tracking ref when it exists.
export function baseCheckPath(changeRoot, change) {
  return join(mainCheckout(changeRoot), WORKTREES_DIR, `${change}--base-check`)
}

function gitError(error) {
  const stderr = String(error?.stderr ?? '').trim()
  return stderr || error.message
}

export function addBaseCheck(changeRoot, { change }) {
  if (!change) throw new Error('no change name')
  const git = gitIn(changeRoot)
  let meta
  try {
    meta = JSON.parse(readFileSync(join(changeDir(changeRoot, change), META_FILE), 'utf8'))
  } catch {
    throw new Error(`cannot read openspec/changes/${change}/${META_FILE} in ${changeRoot}; run this from the change worktree`)
  }
  const ref = baseRef(meta, (name) => attempt(git, 'rev-parse', '--verify', '--quiet', name) !== null)
  const commit = attempt(git, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  if (!commit) throw new Error(`the base ref ${ref} of ${change} does not resolve to a commit`)
  const path = baseCheckPath(changeRoot, change)
  if (isWorktree(git, path)) {
    throw new Error(`${path} is already a worktree, a leftover from an earlier run; remove it first (base-check-remove)`)
  }
  try {
    git('worktree', 'add', '--detach', path, commit)
  } catch (error) {
    throw new Error(`git refused to add the base-check worktree: ${gitError(error)}`)
  }
  if (!isWorktree(git, path)) throw new Error(`the base-check worktree is not listed at ${path}; stop`)
  return { root: path, ref, commit: gitIn(path)('rev-parse', 'HEAD') }
}

// Never forced: a base-check worktree git will not remove is reported and left.
export function removeBaseCheck(changeRoot, { change }) {
  if (!change) throw new Error('no change name')
  const git = gitIn(changeRoot)
  const path = baseCheckPath(changeRoot, change)
  if (!isWorktree(git, path)) throw new Error(`${path} is not a worktree; there is no base check to remove`)
  try {
    git('worktree', 'remove', path)
  } catch (error) {
    throw new Error(`git refused to remove ${path}; leave it and report it: ${gitError(error)}`)
  }
  return { removed: path }
}
