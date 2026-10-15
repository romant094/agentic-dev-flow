// Every commit the flow makes: exactly the named paths, on the change's own branch, in the
// change's own worktree. The orchestrator once ran `git add -A` and committed two files that
// were not its own; a commit made by hand also checked the branch from a read that had failed.
// Here every git read that a guard depends on is checked, and a failed read refuses.
//
// The commit takes only the given paths (`git commit -- <paths>`), so work the developer staged
// elsewhere is never swept in; it is refused instead, because a staged file outside the paths is
// someone's decision the flow must not overrule. The message is passed as it is: nothing is
// appended to it.
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isProtected, readBranches } from './branches.mjs'
import { gitIn } from './workspace.mjs'

export class Refusal extends Error {}

const refuse = (message) => {
  throw new Refusal(message)
}

// A path the caller named, as git prints it: relative to the repository root, with `/`.
export function normalizePath(root, path) {
  if (typeof path !== 'string' || path.trim() === '') refuse('a path to commit is empty')
  const rel = (isAbsolute(path) ? relative(root, path) : path).split('\\').join('/')
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) refuse(`"${path}" names the whole repository; name the files or directories to commit`)
  if (parts[0] === '..' || isAbsolute(rel)) refuse(`"${path}" is outside ${root}`)
  return parts.join('/')
}

export const covers = (paths, file) => paths.some((p) => file === p || file.startsWith(`${p}/`))

const list = (text) => text.split('\0').filter(Boolean)

// One git read a guard depends on. A failed read is a refusal, never an empty value.
function step(git, what, ...args) {
  try {
    return git(...args)
  } catch (error) {
    return refuse(`git failed to ${what} (${String(error.stderr || error.message).trim()}); check that the root is a git working tree and run again`)
  }
}

// The checks every commit shares, also used by preflight: `root` is a worktree's top level,
// not the main checkout, on a named branch that is not protected.
export function checkCommitPlace(root, { git = gitIn(root) } = {}) {
  const top = step(git, 'read the top level of the working tree', 'rev-parse', '--show-toplevel')
  if (!top) refuse('git printed no top level for the working tree; check that the root is a git working tree')
  if (realpathSync(top) !== realpathSync(root)) refuse(`${root} is not the top level of its working tree (${top}); pass the worktree's top level as the root`)
  const common = step(git, 'read the common git directory', 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) refuse('git printed no common git directory; check that the root is a git working tree')
  const main = realpathSync(dirname(common))
  if (main === realpathSync(top)) {
    refuse(`${root} is the main checkout; a change works only in its own worktree, so pick that worktree from changes.mjs find or make one with /adf:propose`)
  }
  const branch = step(git, 'read the current branch', 'branch', '--show-current')
  if (!branch) refuse('HEAD is detached; check out the change branch in the worktree')
  const branches = readBranches(root)
  if (!branches) refuse('the registry sets no branch policy, so the protected branches are unknown; run /adf:init')
  if (isProtected(branches, branch)) refuse(`${branch} is protected and nothing is committed to it directly; work on the change branch /adf:propose made`)
  return { root: realpathSync(top), main, branch, protected: branches.protected }
}

export function commitPaths(root, { only, message }, { git = gitIn(root) } = {}) {
  if (!Array.isArray(only) || only.length === 0) refuse('no path to commit; name each with --only')
  if (typeof message !== 'string' || message.trim() === '') refuse('the commit message is empty')
  const place = checkCommitPlace(root, { git })
  const paths = [...new Set(only.map((p) => normalizePath(place.root, p)))]

  const stagedBefore = list(step(git, 'list the staged files', 'diff', '--cached', '--name-only', '-z'))
  const foreign = stagedBefore.filter((f) => !covers(paths, f))
  if (foreign.length > 0) {
    refuse(`files outside the given paths are staged: ${foreign.join(', ')}; the developer decides about them`)
  }
  step(git, 'stage the given paths', 'add', '--', ...paths)
  const staged = list(step(git, 'list the staged files', 'diff', '--cached', '--name-only', '-z', '--', ...paths))
  if (staged.length === 0) refuse(`nothing to commit in ${paths.join(', ')}`)

  step(git, 'make the commit', 'commit', '-q', '-m', message, '--', ...paths)
  const commit = step(git, 'read the new commit', 'rev-parse', 'HEAD')
  const files = list(step(git, 'list the committed files', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'))
  return { ok: true, commit, branch: place.branch, files }
}
