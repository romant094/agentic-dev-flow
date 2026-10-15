// The test-first proof of one task commit, done in a throwaway worktree, never in the working
// tree a reviewer or an implementer works in. The new test must fail without the task's code and
// pass with it:
//
// 1. a detached worktree of the commit's first parent, with the commit's test files written
//    over it, runs the test command: it must fail;
// 2. the test files are put back to the parent's state, the worktree moves to the commit itself
//    (a checkout of a clean tree, never forced), and the same command must pass;
// 3. the worktree is removed, never forced; a removal git refuses is reported and the worktree
//    left.
//
// Both runs happen in the same kind of throwaway tree, so a failure that comes from the tree
// alone (dependencies that are not committed, a build output) fails the commit run as well and
// leaves no proof, never a false one. `share` names untracked paths of the source worktree, such
// as node_modules, linked into the throwaway tree for both runs and unlinked before removal (a
// directory junction on Windows, which needs no privilege). Nothing is installed.
//
// Test files are the commit's added or modified files that look like tests (a __tests__, test,
// tests, spec or specs directory; a `.test.`, `.spec.`, `_test.` or `-test.` name; `test_*.py`),
// or the ones the caller names. The command runs through the platform shell with the throwaway
// worktree as its working directory; its output goes to
// `<root>/.superpowers/sdd/<change>/tdd/<sha7>-parent.txt` and `-commit.txt`.
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mainCheckout } from './installed.mjs'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'

export const TEST_FILE = /(^|\/)(__tests__|tests?|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/
export const CANNOT_RUN = [126, 127]
export const DEFAULT_TIMEOUT_MINUTES = 20

export const isTestFile = (path) => TEST_FILE.test(path)

const gitError = (error) => String(error?.stderr ?? '').trim() || error.message

function runOnce(command, cwd, file, timeoutMinutes) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  let result
  try {
    result = spawnSync(command, { cwd, shell: true, stdio: ['ignore', fd, fd], windowsHide: true, timeout: Math.round(timeoutMinutes * 60000) })
  } finally {
    closeSync(fd)
  }
  if (result.error) return { exit: null, cannotRun: true, error: result.error.code === 'ETIMEDOUT' ? `stopped after ${timeoutMinutes} minute(s)` : result.error.message }
  const exit = result.status ?? 1
  return { exit, cannotRun: CANNOT_RUN.includes(exit) }
}

// Empty directories left by a removed test file, up to the worktree root.
function pruneDirs(top, file) {
  for (let dir = dirname(join(top, file)); resolve(dir) !== resolve(top); dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      return
    }
  }
}

export function tddProof(worktree, { change, commit, test, testFiles = null, share = [], root = worktree, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES }) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(change ?? '')) throw new Error(`change name "${change}" is not kebab-case`)
  if (!test || !test.trim()) throw new Error('no test command')
  const git = gitIn(worktree)
  let sha
  let parent
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${commit}^{commit}`)
  } catch {
    throw new Error(`${commit} does not resolve to a commit in ${worktree}`)
  }
  try {
    parent = git('rev-parse', '--verify', '--quiet', `${sha}^1`)
  } catch {
    throw new Error(`${sha} has no parent; there is no tree without its code`)
  }
  const changed = git('diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', parent, sha)
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [status, path] = row.split('\t')
      return { status, path }
    })
  const present = changed.filter((c) => c.status !== 'D').map((c) => c.path)
  const tests = testFiles ?? present.filter(isTestFile)
  if (!tests.length) throw new Error(`commit ${sha.slice(0, 7)} adds or changes no test file; name them with --test-file`)
  const missing = tests.filter((t) => !present.includes(t))
  if (missing.length) throw new Error(`not added or changed by ${sha.slice(0, 7)}: ${missing.join(', ')}`)
  const atParent = new Set(changed.filter((c) => c.status !== 'A').map((c) => c.path))

  const sha7 = sha.slice(0, 7)
  const path = join(mainCheckout(worktree), WORKTREES_DIR, `${change}--tdd-${sha7}`)
  if (existsSync(path)) throw new Error(`${path} exists, a leftover from an earlier run; remove it first (git worktree remove)`)
  const outDir = join(resolve(root), '.superpowers', 'sdd', change, 'tdd')
  const outputFiles = { parent: join(outDir, `${sha7}-parent.txt`), commit: join(outDir, `${sha7}-commit.txt`) }
  const result = { ok: false, proof: false, commit: sha, parent, testFiles: tests, parentFails: null, commitPasses: null, worktree: path, outputFiles }

  try {
    git('worktree', 'add', '--detach', path, parent)
  } catch (error) {
    throw new Error(`git refused to add the throwaway worktree: ${gitError(error)}`)
  }
  const tmp = gitIn(path)
  const links = []
  try {
    for (const name of share) {
      const from = join(worktree, name)
      const to = join(path, name)
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      symlinkSync(from, to, statSync(from).isDirectory() ? 'junction' : 'file')
      links.push(to)
    }
    result.shared = links.map((l) => l.slice(path.length + 1))

    for (const file of tests) {
      const content = execFileSync('git', ['show', `${sha}:${file}`], { cwd: worktree, maxBuffer: 1 << 28 })
      mkdirSync(dirname(join(path, file)), { recursive: true })
      writeFileSync(join(path, file), content)
    }
    const before = runOnce(test, path, outputFiles.parent, timeoutMinutes)
    result.parentExit = before.exit
    if (before.error) result.parentError = before.error
    result.parentFails = before.exit !== 0 && !before.cannotRun

    const back = tests.filter((t) => atParent.has(t))
    if (back.length) tmp('checkout', parent, '--', ...back)
    for (const file of tests.filter((t) => !atParent.has(t))) {
      unlinkSync(join(path, file))
      pruneDirs(path, file)
    }
    try {
      tmp('checkout', '--detach', sha)
    } catch (error) {
      throw new Error(`the throwaway worktree did not move to ${sha7} (the parent run left files in the way?): ${gitError(error)}`)
    }
    const after = runOnce(test, path, outputFiles.commit, timeoutMinutes)
    result.commitExit = after.exit
    if (after.error) result.commitError = after.error
    result.commitPasses = after.exit === 0
    result.proof = result.parentFails && result.commitPasses
    result.ok = result.proof
  } catch (error) {
    result.error = error.message
  } finally {
    for (const link of links) {
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
        else rmdirSync(link)
      } catch {
        // reported by the removal below
      }
    }
    try {
      git('worktree', 'remove', path)
      result.removed = true
    } catch (error) {
      result.removed = false
      result.removeError = `git refused to remove ${path}; it is left for the developer: ${gitError(error)}`
    }
  }
  return result
}
