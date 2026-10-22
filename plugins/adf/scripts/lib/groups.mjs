// Task groups that run in parallel get a worktree each, branched from the change branch, and
// are merged back into it one by one. Every path is rooted at the main checkout: run from
// inside the change worktree, a relative `.claude/worktrees/...` would nest the group inside
// it, where removing the change worktree strands the group.
//
// Each worktree made here is provisioned once git made it, and torn down before git removes it
// (lib/provision.mjs); a refused teardown leaves the worktree. A refused provisioning leaves the
// worktree made, and the result says so with `ok: false`.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireBranches } from './branches.mjs'
import { changeDir, META_FILE, readChangeMeta } from './changes.mjs'
import { mainCheckout } from './installed.mjs'
import { planInputs } from './plan.mjs'
import { baseRef } from './plan-symbols.mjs'
import { provisionWorktree, teardownWorktree } from './provision.mjs'
import { callRole } from './roles.mjs'
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

// The summary of a provisioning a result carries; the whole of it is in `report`.
const provisioned = (p) => ({ ok: p.ok, state: p.state, report: p.report, ...(p.error ? { error: p.error } : {}) })

// A provisioning that refused leaves the worktree it was given: the result is `ok: false`, with
// the command that provisions it again once the cause is fixed.
function withProvision(made, p, { change, kind, changeRoot }) {
  if (p.ok) return { ...made, provision: provisioned(p) }
  const again = `workspace.mjs provision --change ${change} --kind ${kind} --worktree "${made.root}" --root "${changeRoot}"`
  return { ok: false, error: `the ${kind} worktree is made at ${made.root}, but ${p.error}; fix the cause, then run ${again}`, ...made, provision: provisioned(p) }
}

export function addGroup(changeRoot, { change, group }, { core } = {}) {
  const { git, branch, groupBranch, path } = names(changeRoot, change, group)
  if (isWorktree(git, path)) throw new Error(`group ${group} of ${change} already has a worktree at ${path}`)
  if (attempt(git, 'rev-parse', '--verify', '--quiet', `refs/heads/${groupBranch}`)) {
    throw new Error(`branch ${groupBranch} already exists`)
  }
  git('worktree', 'add', path, '-b', groupBranch, 'HEAD')
  if (realpathSync(gitIn(path)('rev-parse', '--show-toplevel')) !== realpathSync(path)) {
    throw new Error(`the group worktree does not resolve to ${path}; stop`)
  }
  const p = provisionWorktree(changeRoot, { worktree: path, kind: 'group', change, ...planInputs(changeRoot, change) }, core)
  return withProvision({ root: path, branch: groupBranch, from: branch }, p, { change, kind: 'group', changeRoot })
}

// A conflict leaves the merge in progress for the subagent that resolves it. A merge that is
// made, by this call or by the resolver's commit, reports the merge commit and its first parent:
// the range of the merge review. Called again once the resolver committed, it merges nothing and
// reports the same pair, with `already` true.
export function mergeGroup(changeRoot, { change, group }) {
  const { git, branch, groupBranch } = names(changeRoot, change, group)
  if (attempt(git, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')) {
    throw new Error('a merge is in progress in the change worktree; the resolver completes it, then run group-merge again')
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty !== '') throw new Error(`the change worktree has uncommitted changes:\n${dirty}`)
  const tip = attempt(git, 'rev-parse', '--verify', '--quiet', `refs/heads/${groupBranch}`)
  if (!tip) throw new Error(`branch ${groupBranch} does not exist`)
  if (attempt(git, 'merge-base', '--is-ancestor', tip, 'HEAD') !== null) {
    const found = mergeOf(git, tip)
    if (!found) throw new Error(`${groupBranch} is already in ${branch} without a merge commit; there is no merge to review`)
    return { merged: true, already: true, into: branch, branch: groupBranch, commit: found.mergeCommit, ...found, conflicts: [] }
  }
  try {
    git('merge', '--no-ff', '--no-edit', groupBranch)
  } catch {
    const conflicts = (attempt(git, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
    if (conflicts.length === 0) throw new Error(`merging ${groupBranch} into ${branch} failed without a conflict`)
    return { merged: false, into: branch, branch: groupBranch, conflicts }
  }
  const mergeCommit = git('rev-parse', 'HEAD')
  return { merged: true, already: false, into: branch, branch: groupBranch, commit: mergeCommit, mergeCommit, firstParent: git('rev-parse', 'HEAD^1'), conflicts: [] }
}

// The merge commit on the change branch whose second parent is the group branch's tip.
function mergeOf(git, tip) {
  const rows = (attempt(git, 'log', '--merges', '--format=%H %P', 'HEAD') ?? '').split('\n').filter(Boolean)
  for (const row of rows) {
    const [mergeCommit, firstParent, ...others] = row.split(' ')
    if (others.includes(tip)) return { mergeCommit, firstParent }
  }
  return null
}

// Only a merged group is removed; a blocked group keeps its worktree and branch.
export function removeGroup(changeRoot, { change, group }, { core } = {}) {
  const { git, groupBranch, path } = names(changeRoot, change, group)
  if (attempt(git, 'merge-base', '--is-ancestor', groupBranch, 'HEAD') === null) {
    throw new Error(`${groupBranch} is not merged into the change branch; a blocked group keeps its worktree`)
  }
  let teardown = null
  if (isWorktree(git, path)) {
    teardown = teardownWorktree(changeRoot, { worktree: path, kind: 'group', change, branch: groupBranch }, core)
    if (!teardown.ok) throw new Error(`${teardown.error}\n${teardown.report}`)
    git('worktree', 'remove', path)
  }
  git('branch', '-d', groupBranch)
  return { removed: path, branch: groupBranch, ...(teardown ? { teardown: { state: teardown.state, report: teardown.report } } : {}) }
}

// Each group's state on disk, for the schedule: merged when the change branch holds the merge
// commit of its branch (the branch itself is deleted once its worktree is removed, so the merge
// subject is what remains), kept while its worktree exists. Returns `(n) => { merged, kept }`.
// After the merge review passed: remove the group's worktree and branch, then push the change
// branch through the forge role with the branch and the protected list read here, never typed.
// With no forge plugin the push state is `none`, which is not an error. The push result is kept
// in .superpowers/sdd/<change>/push.json for apply's report. `core` is callRole's.
export const PUSH_FILE = 'push.json'
export const pushPath = (changeRoot, change) => join(changeRoot, '.superpowers', 'sdd', change, PUSH_FILE)

export function finishGroup(changeRoot, { change, group }, core) {
  const branches = requireBranches(changeRoot)
  const removed = removeGroup(changeRoot, { change, group }, { core })
  const branch = changeBranch(gitIn(changeRoot))
  const result = callRole(changeRoot, 'forge', 'push', { change, branch, protected: branches.protected }, core)
  const push = { state: result.state, ...(result.plugin ? { plugin: result.plugin } : {}), ...(result.hint ? { hint: result.hint } : {}), ...(result.error ? { error: result.error } : {}) }
  const file = pushPath(changeRoot, change)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), group: Number(group), branch, ...push }, null, 2)}\n`, 'utf8')
  return { removed, push }
}

export function groupState(changeRoot, change) {
  const git = gitIn(changeRoot)
  const branch = attempt(git, 'branch', '--show-current') ?? ''
  const merges = (attempt(git, 'log', '--merges', '--format=%s', 'HEAD') ?? '').split('\n')
  let kept = []
  try {
    kept = listGroups(changeRoot, change).map((g) => g.group)
  } catch {
    // not a repository: nothing is kept
  }
  return (n) => {
    const name = `${branch}--group-${n}`
    return { merged: Boolean(branch) && merges.some((s) => s === `Merge branch '${name}'` || s.startsWith(`Merge branch '${name}' into `)), kept: kept.includes(n) }
  }
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
// worktree of the change's base, never by stashing. The base is the change's metadata base,
// resolved as plan-symbols resolves it: the remote-tracking ref when it exists.
export function baseCheckPath(changeRoot, change) {
  return join(mainCheckout(changeRoot), WORKTREES_DIR, `${change}--base-check`)
}

function gitError(error) {
  const stderr = String(error?.stderr ?? '').trim()
  return stderr || error.message
}

export function addBaseCheck(changeRoot, { change }, { core } = {}) {
  if (!change) throw new Error('no change name')
  const git = gitIn(changeRoot)
  const meta = readChangeMeta(changeRoot, changeDir(changeRoot, change))
  if (!meta) {
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
  const p = provisionWorktree(changeRoot, { worktree: path, kind: 'base-check', change, files: planInputs(changeRoot, change).files }, core)
  return withProvision({ root: path, ref, commit: gitIn(path)('rev-parse', 'HEAD') }, p, { change, kind: 'base-check', changeRoot })
}

// Never forced: a base-check worktree git will not remove, or whose teardown refused, is reported
// and left.
export function removeBaseCheck(changeRoot, { change }, { core } = {}) {
  if (!change) throw new Error('no change name')
  const git = gitIn(changeRoot)
  const path = baseCheckPath(changeRoot, change)
  if (!isWorktree(git, path)) throw new Error(`${path} is not a worktree; there is no base check to remove`)
  const teardown = teardownWorktree(changeRoot, { worktree: path, kind: 'base-check', change }, core)
  if (!teardown.ok) throw new Error(`${teardown.error}; leave it and report it\n${teardown.report}`)
  try {
    git('worktree', 'remove', path)
  } catch (error) {
    throw new Error(`git refused to remove ${path}; leave it and report it: ${gitError(error)}`)
  }
  return { removed: path, teardown: { state: teardown.state, report: teardown.report } }
}
