// The local merge with no forge, on the developer's yes: `git merge --no-ff <branch>` in the main
// checkout when it has the base checked out and is clean. Nothing is pushed, and the branch is
// kept. A branch already merged is done; without `yes` nothing happens and the commands are
// returned. A merge that fails is aborted, so the main checkout is left as it was.
//
// One rule for both callers: archive's merge-local step (lib/archive.mjs mergeLocalStep), which
// keeps only its own --no and forge-skip handling, and the retrospective's publish
// (lib/retro-run.mjs).
import { execFileSync, spawnSync } from 'node:child_process'

export class MergeRefusal extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.extra = extra
  }
}

const refuse = (message, extra) => {
  throw new MergeRefusal(message, extra)
}

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`)

function read(main, what, ...args) {
  try {
    return execFileSync('git', args, { cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  } catch (error) {
    return refuse(`git failed to ${what} (${String(error.stderr || error.message).trim()}); check that ${main} is a git working tree and run again`)
  }
}

// Returns { hold: true, branch, base, commands } without `yes`, else { branch, base, commands,
// merged | already, mergeCommit?, report }. Throws MergeRefusal, with `commands` in `extra`,
// when the main checkout is on another branch, is not clean, or the merge fails.
export function localMerge(main, { branch, base, yes = false }) {
  const commands = [`git -C ${quote(main)} checkout ${quote(base)}`, `git -C ${quote(main)} merge --no-ff ${quote(branch)}`]
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', branch, base], { cwd: main, encoding: 'utf8' })
  if (ancestor.status !== 0 && ancestor.status !== 1) refuse(`git failed to compare ${branch} with ${base} (${String(ancestor.stderr || `exit ${ancestor.status}`).trim()}); run again`)
  if (ancestor.status === 0) return { branch, base, commands, already: true, report: `Local merge: ${branch} is already merged into ${base}.` }
  if (!yes) return { hold: true, branch, base, commands }
  const current = read(main, 'read the main checkout branch', 'branch', '--show-current')
  if (current !== base) refuse(`the main checkout ${main} has ${current || 'a detached HEAD'} checked out, not ${base}; nothing was merged. Run: ${commands.join(' && ')}`, { commands })
  const dirty = read(main, 'read the main checkout status', 'status', '--porcelain', '--untracked-files=no')
  if (dirty) refuse(`the main checkout ${main} has uncommitted changes; nothing was merged. Once it is clean, run: ${commands[1]}`, { commands, dirty: dirty.split('\n') })
  const merged = spawnSync('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: main, encoding: 'utf8' })
  if (merged.status !== 0) {
    spawnSync('git', ['merge', '--abort'], { cwd: main, encoding: 'utf8' })
    refuse(`git merge --no-ff ${branch} failed in ${main} and was aborted (${String(merged.stderr || merged.stdout).trim()}); merge it by hand: ${commands[1]}`, { commands })
  }
  const commit = read(main, 'read the merge commit', 'rev-parse', 'HEAD')
  return { branch, base, commands, merged: true, mergeCommit: commit, report: `Local merge: ${branch} merged into ${base} at ${commit.slice(0, 7)}; nothing was pushed, and the branch is kept.` }
}
