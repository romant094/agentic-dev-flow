// Proves a dispatch wrote only where it was sent. Before the dispatch every checkout of the
// repository but the dispatch targets is recorded (HEAD and `git status`); after it the same
// checkouts must be unchanged. A subagent that ran `git checkout` in the main checkout, or
// committed in a sibling's worktree, is caught at the dispatch that did it. Ignored files (the
// ledger, reply files) do not count.
//
// A move the round could not cause is `foreign`, reported and not failed (#27, #43): in the
// worktree of another active change (it holds a change directory, not this change's), a commit
// or an edit on the branch it had at the snapshot, whichever session drives that change; in the
// main checkout, a fast-forward of a protected branch (its reflog since the snapshot holds only
// fast-forwards) with the status unchanged. Every other move fails: a branch switch, a rewind, a
// commit in the main checkout, a worktree of no change. A snapshot written before `foreign`
// existed records no branch, and every move in it fails, as before.
//
// The targets are computed from the round's dispatch names, by the rule that places each
// dispatch (lib/dispatch.mjs planDispatch), never listed by hand: a target typed wrong leaves
// the checkout it should watch unwatched, or watches the one the dispatch writes in.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isProtected, readBranches } from './branches.mjs'
import { ARCHIVE, CHANGES_DIR } from './changes.mjs'
import { parseName, planDispatch } from './dispatch.mjs'
import { mainCheckout } from './installed.mjs'
import { gitIn } from './workspace.mjs'
import { checkouts } from './resolve.mjs'

const real = (path) => realpathSync(path)

function state(root) {
  const git = gitIn(root)
  let branch = null
  try {
    branch = git('branch', '--show-current') || null
  } catch {
    // a detached HEAD or an old git: no branch, so no move there is foreign
  }
  return { head: git('rev-parse', 'HEAD'), branch, status: git('status', '--porcelain', '--untracked-files=all') }
}

// The change directories a checkout holds; none when it holds the guarded change itself.
function otherChanges(root, change) {
  let names = []
  try {
    names = readdirSync(join(root, CHANGES_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ARCHIVE && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  return names.includes(change) ? [] : names.sort()
}

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}

// HEAD moved forward only: the new HEAD is the old one or descends from it.
const forward = (git, from, to) => from === to || attempt(() => git('merge-base', '--is-ancestor', from, to)) !== null

// Every move of HEAD since `from` is a fast-forward, by the reflog; false when the reflog does not
// reach `from`.
function fastForwards(git, from) {
  const rows = (attempt(() => git('reflog', 'show', '--format=%H%x09%gs', 'HEAD')) ?? '').split('\n').filter(Boolean)
  for (const row of rows) {
    const [sha, ...subject] = row.split('\t')
    if (sha === from) return true
    if (!/Fast-forward/.test(subject.join('\t'))) return false
  }
  return false
}

// Why a recorded checkout's move is foreign, or null when the round may have made it.
function foreignReason(root, before, after) {
  if (!before.branch || after.head === null || after.branch !== before.branch) return null
  const git = gitIn(root)
  if (!forward(git, before.head, after.head)) return null
  if (before.changes?.length) return `a commit or an edit on ${before.branch} in the worktree of another active change: ${before.changes.join(', ')}`
  if (before.main && after.head !== before.head && after.status === before.status) {
    const branches = readBranches(root)
    if (branches && isProtected(branches, before.branch) && fastForwards(git, before.head)) return `a fast-forward of ${before.branch} in the main checkout`
  }
  return null
}

function guardFile(root, change) {
  return join(root, '.superpowers', 'sdd', change, 'guard.json')
}

// The worktree of each dispatch of a round, from its fixed-form name: [{ name, worktree }].
export function targetsOf(root, change, names) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('name the dispatches of the round (--dispatch)')
  let planText = null
  try {
    planText = readFileSync(join(root, 'openspec', 'changes', change, 'plan.md'), 'utf8')
  } catch {
    // a task or group dispatch then refuses, naming the missing plan
  }
  const main = mainCheckout(root)
  return names.map((name) => {
    const parts = parseName(name)
    if (!parts) throw new Error(`"${name}" is not a dispatch name in the fixed form`)
    return { name, worktree: planDispatch({ change, ...parts }, { root, main, planText, exists: existsSync }).worktree }
  })
}

export function snapshot(root, { change, targets, dispatches }) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('name the dispatch targets (--dispatch)')
  const skip = new Set(targets.map(real))
  const watched = {}
  for (const c of [...checkouts(root), ...groupCheckouts(root)]) {
    if (skip.has(real(c.root))) continue
    const others = c.main ? [] : otherChanges(c.root, change)
    watched[c.root] = { ...state(c.root), ...(c.main ? { main: true } : {}), ...(others.length ? { changes: others } : {}) }
  }
  const file = guardFile(root, change)
  mkdirSync(dirname(file), { recursive: true })
  const names = dispatches ? { dispatches } : {}
  writeFileSync(file, `${JSON.stringify({ ...names, targets, watched }, null, 2)}\n`)
  return { ...names, watched: Object.keys(watched), targets }
}

export function compare(root, { change }) {
  let saved
  try {
    saved = JSON.parse(readFileSync(guardFile(root, change), 'utf8'))
  } catch {
    throw new Error(`no snapshot for ${change}; run snapshot before the dispatch`)
  }
  const changed = []
  const foreign = []
  for (const [path, before] of Object.entries(saved.watched)) {
    let after
    try {
      after = state(path)
    } catch {
      after = { head: null, status: 'the checkout is gone' }
    }
    // A branch switch on one commit is a move too, where the snapshot recorded the branch.
    const sameBranch = !('branch' in before) || after.branch === before.branch
    if (after.head === before.head && after.status === before.status && sameBranch) continue
    const reason = foreignReason(path, before, after)
    if (reason) foreign.push({ root: path, reason, before, after })
    else changed.push({ root: path, before, after })
  }
  return { ok: changed.length === 0, ...(saved.dispatches ? { dispatches: saved.dispatches } : {}), targets: saved.targets, changed, foreign }
}

// Group worktrees are skipped when a phase resolves a change, but a dispatch must not touch a
// sibling's group either.
function groupCheckouts(root) {
  const porcelain = gitIn(root)('worktree', 'list', '--porcelain')
  return porcelain
    .split('\n')
    .filter((l) => l.startsWith('worktree ') && /--group-\d+$/.test(l))
    .map((l) => ({ root: l.slice('worktree '.length) }))
}
