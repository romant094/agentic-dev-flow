// One branch and one worktree per change, made at propose before any artifact is written, so
// changes run in parallel and none touches the developer's checkout. The main checkout is
// never switched: `git worktree add` reads a commit and writes a new directory.
//
// A change forks from the integration branch (fetched first when the host has a remote), or
// from the developer's current branch when they are mid-feature. That branch is the change's
// base: the merge request targets it, or, with no forge plugin, archive offers to merge the
// change back into it.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isProtected, requireBranches } from './branches.mjs'

export const WORKTREES_DIR = '.claude/worktrees'

const TYPES = [
  ['add-', 'feat'],
  ['fix-', 'fix'],
  ['restructure-', 'refactor'],
  ['refactor-', 'refactor']
]

export function branchType(change) {
  return TYPES.find(([prefix]) => change.startsWith(prefix))?.[1] ?? null
}

// Only trailing whitespace is cut: a porcelain status line starts with a space (` M a.txt`), and
// cutting the leading one turned the first dirty entry into `M a.txt`.
export function gitIn(root) {
  return (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
}

function attempt(git, ...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

// Uncommitted changes to tracked files. Untracked files are left out: `git worktree add`
// cannot lose or carry one, so a stray file must not block a change.
function dirtyFiles(git) {
  const status = git('status', '--porcelain', '--untracked-files=no')
  return status === '' ? [] : status.split('\n')
}

export function worktreePath(root, change) {
  return join(root, WORKTREES_DIR, change)
}

export function suggest(root, change, { git = gitIn(root) } = {}) {
  const branches = requireBranches(root)
  const current = attempt(git, 'branch', '--show-current') || null
  const currentProtected = current === null || isProtected(branches, current)
  const type = branchType(change)
  return {
    change,
    integration: branches.integration,
    protected: branches.protected,
    current,
    bases: currentProtected ? ['integration'] : ['integration', 'current'],
    type,
    branch: type ? `${type}/${change}` : null,
    path: worktreePath(root, change),
    dirty: dirtyFiles(git)
  }
}

export function create(root, { change, branch, base }, { git = gitIn(root) } = {}) {
  const branches = requireBranches(root)
  if (!branch) throw new Error('no branch name; the developer confirms one first')
  if (isProtected(branches, branch)) throw new Error(`${branch} is protected; a change never works on it`)
  if (!['integration', 'current'].includes(base)) throw new Error('base must be "integration" or "current"')
  const dirty = dirtyFiles(git)
  if (dirty.length > 0) throw new Error(`uncommitted changes to tracked files:\n${dirty.join('\n')}`)
  const path = worktreePath(root, change)
  if (existsSync(path)) throw new Error(`${path} already exists`)
  if (attempt(git, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== null) {
    throw new Error(`branch ${branch} already exists`)
  }
  if (attempt(git, 'check-ignore', '-q', path) === null) {
    throw new Error(`${WORKTREES_DIR}/ is not ignored by git; run /adf:init`)
  }

  let baseBranch
  let baseRef
  if (base === 'current') {
    baseBranch = attempt(git, 'branch', '--show-current') || null
    if (baseBranch === null) throw new Error('HEAD is detached; there is no current branch to fork from')
    if (isProtected(branches, baseBranch)) throw new Error(`${baseBranch} is protected; fork from the integration branch`)
    baseRef = baseBranch
  } else {
    baseBranch = branches.integration
    if (attempt(git, 'remote', 'get-url', 'origin') !== null) {
      git('fetch', 'origin', baseBranch)
      baseRef = `origin/${baseBranch}`
    } else {
      baseRef = baseBranch
    }
  }

  git('worktree', 'add', path, '-b', branch, baseRef)
  const top = gitIn(path)('rev-parse', '--show-toplevel')
  if (realpathSync(top) !== realpathSync(path)) {
    throw new Error(`the worktree resolves to ${top}, not ${path}; stop before writing anything`)
  }
  return { root: path, branch, base: baseBranch, baseRef }
}
