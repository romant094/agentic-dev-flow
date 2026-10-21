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
// The throwaway tree is provisioned (lib/provision.mjs, kind `proof`, no needs) once git made it
// and again once it moved to the commit, and torn down before it is removed; a refused
// provisioning ends the proof with its error, and a refused teardown leaves the tree.
//
// Both runs happen in the same kind of throwaway tree, so a failure that comes from the tree
// alone (dependencies that are not committed, a build output) fails the commit run as well and
// leaves no proof, never a false one. `share` names untracked paths of the source worktree, such
// as node_modules, linked into the throwaway tree for both runs and unlinked before removal (a
// directory junction on Windows, which needs no privilege). Nothing is installed.
//
// Test files are the commit's added or modified files that look like tests (a __tests__, test,
// tests, spec or specs directory; a `.test.`, `.spec.`, `_test.` or `-test.` name; `test_*.py`),
// or the ones the caller names. The command runs through lib/suite.mjs's runner (the platform
// shell in a process group of its own, stopped past the timeout) with the throwaway worktree as
// its working directory; its output goes to
// `<root>/.superpowers/sdd/<change>/tdd/<sha7>-parent.txt` and `-commit.txt`.
//
// `taskProof` is the run the orchestrator's script makes after a done test-first task, before its
// review (dispatch.mjs prompt for `T<n> review`): the commit and the test command come from the
// task's accepted `T<n> impl` result (the last commit, the last covering run's command), the
// shared paths from the planning guide's `## Test-first shares` section, one path per line. Its
// record is `tdd/T<n>.json`, kept while the commit and the command stay the same. Without the
// section nothing runs, and the reviewer runs tdd-proof itself.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { attemptsFile, parseEvents, readLog } from './attempts.mjs'
import { planDispatch } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { planInputs } from './plan.mjs'
import { provisionWorktree, teardownWorktree } from './provision.mjs'
import { PLANNING_FILE, runOnce, sectionBounds } from './suite.mjs'
import { gitIn, WORKTREES_DIR } from './workspace.mjs'

export const TEST_FILE = /(^|\/)(__tests__|tests?|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/
export const DEFAULT_TIMEOUT_MINUTES = 20

export const isTestFile = (path) => TEST_FILE.test(path)

const gitError = (error) => String(error?.stderr ?? '').trim() || error.message

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

export function tddProof(worktree, { change, commit, test, testFiles = null, share = [], root = worktree, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, core }) {
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
  const { files } = planInputs(worktree, change)
  const provision = () => {
    const p = provisionWorktree(worktree, { worktree: path, kind: 'proof', change, files }, core)
    result.provision = [...(result.provision ?? []), { state: p.state, report: p.report }]
    if (!p.ok) throw new Error(p.error)
  }
  try {
    provision()
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
    provision()
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
    const teardown = teardownWorktree(worktree, { worktree: path, kind: 'proof', change }, core)
    result.teardown = { state: teardown.state, report: teardown.report }
    if (!teardown.ok) {
      result.removed = false
      result.removeError = `${teardown.error}; it is left for the developer`
    } else {
      try {
        git('worktree', 'remove', path)
        result.removed = true
      } catch (error) {
        result.removed = false
        result.removeError = `git refused to remove ${path}; it is left for the developer: ${gitError(error)}`
      }
    }
  }
  return result
}

// ---------------------------------------------------------------- the orchestrator's run

export const SHARES_HEADING = '## Test-first shares'

// The paths of the `## Test-first shares` section, one per line (a list item, a code span or a
// plain line; HTML comments and fences ignored); null when the section is absent.
export function sharesIn(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const bounds = sectionBounds(lines, SHARES_HEADING)
  if (!bounds) return null
  return lines
    .slice(bounds.start, bounds.end)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim().replace(/^[-*]\s+/, '').replace(/^`([^`]+)`\.?$/, '$1').trim())
    .filter((l) => l && !/^(```|~~~)/.test(l))
}

export function readShares(root) {
  const file = join(resolve(root), PLANNING_FILE)
  return existsSync(file) ? sharesIn(readFileSync(file, 'utf8')) : null
}

export const taskProofFile = (root, change, task) => join(resolve(root), '.superpowers', 'sdd', change, 'tdd', `T${task}.json`)

export function readTaskProof(root, change, task) {
  try {
    return JSON.parse(readFileSync(taskProofFile(root, change, task), 'utf8'))
  } catch {
    return null
  }
}

// { ran: false, reason } when nothing ran, else { ran: true, cached, ...the tddProof result,
// task, test, share, file }. A refusal of tddProof itself (no test file in the commit, a leftover
// worktree) is `ran: false` with its message: the reviewer then runs it by hand.
export function taskProof(root, change, task, { planText, main = mainCheckout(root), prove = tddProof } = {}) {
  const skip = (reason) => ({ ran: false, reason })
  const share = readShares(root)
  if (share === null) return skip(`${PLANNING_FILE} has no ${SHARES_HEADING} section`)
  const impl = parseEvents(readLog(attemptsFile(root, change)))
    .filter((e) => e.event === 'valid' && e.name === `T${task} impl` && e.result)
    .at(-1)?.result
  if (!impl) return skip(`no accepted T${task} impl reply is recorded`)
  if (!['DONE', 'DONE_WITH_CONCERNS'].includes(impl.status)) return skip(`T${task} impl is ${impl.status}, not done`)
  const commit = impl.range?.head ?? impl.commits?.at(-1)?.sha
  const test = impl.tests?.runs?.at(-1)?.command
  if (!commit || !test) return skip(`T${task} impl names no commit or no covering run`)
  const file = taskProofFile(root, change, task)
  const kept = readTaskProof(root, change, task)
  if (kept?.commit === commit && kept.test === test) return { ran: true, cached: true, ...kept }
  const { worktree } = planDispatch({ change, role: 'impl', task }, { root, main, planText, exists: existsSync })
  let result
  try {
    result = prove(worktree, { change, commit, test, share, root })
  } catch (error) {
    return skip(`tdd-proof refused: ${error.message}`)
  }
  const record = { ...result, task, test, share, file }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return { ran: true, cached: false, ...record }
}
