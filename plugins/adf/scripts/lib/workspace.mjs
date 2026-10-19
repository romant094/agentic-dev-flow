// One branch and one worktree per change, made at propose before any artifact is written, so
// changes run in parallel and none touches the developer's checkout. The main checkout is
// never switched: `git worktree add` reads a commit and writes a new directory.
//
// A change forks from the integration branch (fetched first when the host has a remote), or
// from the developer's current branch when they are mid-feature. That branch is the change's
// base: the merge request targets it, or, with no forge plugin, archive offers to merge the
// change back into it.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isProtected, requireBranches } from './branches.mjs'
import { ARCHIVE, archivedDirs, CHANGES_DIR, isMainCheckout, LEDGER_FILE } from './changes.mjs'
import { ledgerPath } from './ledger.mjs'

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

// ---------------------------------------------------------------- removal at archive

const real = (path) => (existsSync(path) ? realpathSync(path) : path)
// A task group's worktree and the base check's are their change's, never the change worktree.
const HELPER = /--(?:group-\d+|base-check)$/

// Whether a checkout holds the change, active or archived as archive/<date>-<name>.
function holdsChange(dir, change) {
  if (existsSync(join(dir, CHANGES_DIR, change))) return true
  const archive = join(dir, CHANGES_DIR, ARCHIVE)
  if (!existsSync(archive)) return false
  return readdirSync(archive).some((name) => /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === change)
}

// `git worktree list --porcelain` as [{ path, branch, prunable }].
export function worktrees(git) {
  return git('worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => block.split('\n'))
    .filter((lines) => lines[0]?.startsWith('worktree '))
    .map((lines) => ({
      path: lines[0].slice('worktree '.length),
      branch: lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
      prunable: lines.some((l) => l.startsWith('prunable'))
    }))
}

// The last step of archive, run from the main checkout: remove the change's worktree, the one
// at the change's path or the one holding the change, with `git worktree remove`, never forced.
// The branch is kept. A change made in place (the main checkout holds it and no worktree does)
// is `in-place`; a change with no worktree left is `absent`: neither is a failure, so a second
// archive run passes this step. A worktree with uncommitted changes or untracked files is
// refused with its `git status --porcelain` lines. A worktree whose ledger exists while the
// archived change holds no copy is refused too: the ledger under `.superpowers/` goes with the
// worktree.
// Returns { ok, state: removed|in-place|absent, change, path?, branch?, hint? }.
export function remove(root, { change }, { git = gitIn(root) } = {}) {
  if (!change) throw new Error('no change name')
  if (!isMainCheckout(root)) {
    throw new Error(`${root} is not the main checkout; run remove from the main checkout, since a worktree cannot remove the ground it stands on`)
  }
  const main = real(root)
  const expected = real(worktreePath(main, change))
  const found = worktrees(git).filter((w) => real(w.path) !== main && !HELPER.test(w.path) && (real(w.path) === expected || (!w.prunable && holdsChange(w.path, change))))
  if (found.length > 1) throw new Error(`more than one worktree holds ${change}: ${found.map((w) => w.path).join(', ')}; remove the right one by hand`)
  if (found.length === 0 || found[0].prunable) {
    if (found.length === 0 && holdsChange(main, change)) return { ok: true, state: 'in-place', change }
    return {
      ok: true,
      state: 'absent',
      change,
      ...(found[0]?.prunable ? { path: found[0].path, hint: `the directory is gone; git worktree prune drops its record` } : {})
    }
  }
  const { path, branch } = found[0]
  const archived = archivedDirs(path, change).at(-1)
  if (existsSync(ledgerPath(path, change)) && !(archived && existsSync(join(archived, LEDGER_FILE)))) {
    throw new Error(`${path} holds the ledger of ${change} and the archived change has no copy of it; archive the change first (changes.mjs archive copies it), then remove again`)
  }
  const status = gitIn(path)('status', '--porcelain')
  if (status !== '') throw new Error(`${path} has uncommitted changes; commit or move them, then remove again (never --force):\n${status}`)
  git('worktree', 'remove', path)
  return { ok: true, state: 'removed', change, path, branch }
}
