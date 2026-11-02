// Every commit the flow makes: exactly the named paths, on the change's own branch, in the
// change's own worktree. The orchestrator once ran `git add -A` and committed two files that
// were not its own; a commit made by hand also checked the branch from a read that had failed.
// Here every git read that a guard depends on is checked, and a failed read refuses.
//
// The commit takes only the given paths: a file staged outside them before the step refuses,
// because it is someone's decision the flow must not overrule, so the index holds nothing else.
// The paths are then staged and the index committed (`git commit` with no pathspec). A pathspec
// commit builds the commit from a temporary index, so a host hook that formats and re-stages
// (lefthook's `stage_fixed`, lint-staged) would leave the real index ahead of HEAD and the next
// step would refuse those files as foreign. The message is passed as it is: nothing is
// appended to it. The host's git hooks run as they do for the developer: no hook is disabled,
// and the files reported are read from the commit, so what a hook rewrote or added is there; a
// hook that refuses stops the commit with its output.
//
// Before the paths are staged, the planning guide's `## Format command` runs on them, when the
// guide has one (`formatPaths`), so the commit holds the host's style with or without a hook.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isProtected, readBranches } from './branches.mjs'
import { PLANNING_FILE, sectionLine } from './guide.mjs'
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

// ---------------------------------------------------------------- the guide's format command

export const FORMAT_HEADING = '## Format command'
export const FILES = '{files}'

export const formatCommandIn = (text) => sectionLine(text, FORMAT_HEADING, 'command')

// A path as one shell word: `/bin/sh -c` on POSIX, `cmd.exe` on Windows.
const quote = (path) => (process.platform === 'win32' ? `"${path}"` : `'${path.replaceAll("'", "'\\''")}'`)

// Runs the guide's format command in `root` on the paths that exist, `{files}` replaced by them,
// through the platform shell: the command is the developer's own line in the guide, not a string
// built from input. No section, or no path left, runs nothing. A command that exits non-zero
// refuses with its output. Returns the command run, or null.
export function formatPaths(root, paths) {
  const file = join(resolve(root), PLANNING_FILE)
  const template = existsSync(file) ? formatCommandIn(readFileSync(file, 'utf8')) : null
  const present = paths.filter((p) => existsSync(join(resolve(root), p)))
  if (template === null || present.length === 0) return null
  const command = template.replaceAll(FILES, present.map(quote).join(' '))
  const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', windowsHide: true })
  if (run.error || run.status !== 0) {
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() || String(run.error?.message ?? '')
    refuse(`the format command of ${PLANNING_FILE} (${command}) exited ${run.status ?? 'abnormally'}${output ? `: ${output}` : ''}; fix it or the files and run again`)
  }
  return command
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
  formatPaths(place.root, paths)
  step(git, 'stage the given paths', 'add', '--', ...paths)
  const staged = list(step(git, 'list the staged files', 'diff', '--cached', '--name-only', '-z', '--', ...paths))
  if (staged.length === 0) refuse(`nothing to commit in ${paths.join(', ')}`)

  step(git, 'make the commit', 'commit', '-q', '-m', message)
  const commit = step(git, 'read the new commit', 'rev-parse', 'HEAD')
  const files = list(step(git, 'list the committed files', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'))
  return { ok: true, commit, branch: place.branch, files }
}
