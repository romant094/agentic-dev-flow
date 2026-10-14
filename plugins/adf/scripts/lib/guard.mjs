// Proves a dispatch wrote only where it was sent. Before the dispatch every checkout of the
// repository but the dispatch targets is recorded (HEAD and `git status`); after it the same
// checkouts must be unchanged. A subagent that ran `git checkout` in the main checkout, or
// committed in a sibling's worktree, is caught at the dispatch that did it. Ignored files (the
// ledger, reply files) do not count.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitIn } from './workspace.mjs'
import { checkouts } from './resolve.mjs'

const real = (path) => realpathSync(path)

function state(root) {
  const git = gitIn(root)
  return { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--untracked-files=all') }
}

function guardFile(root, change) {
  return join(root, '.superpowers', 'sdd', change, 'guard.json')
}

export function snapshot(root, { change, targets }) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('name the dispatch targets (--targets)')
  const skip = new Set(targets.map(real))
  const watched = {}
  for (const c of [...checkouts(root), ...groupCheckouts(root)]) {
    if (!skip.has(real(c.root))) watched[c.root] = state(c.root)
  }
  const file = guardFile(root, change)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ targets, watched }, null, 2)}\n`)
  return { watched: Object.keys(watched), targets }
}

export function compare(root, { change }) {
  let saved
  try {
    saved = JSON.parse(readFileSync(guardFile(root, change), 'utf8'))
  } catch {
    throw new Error(`no snapshot for ${change}; run snapshot before the dispatch`)
  }
  const changed = []
  for (const [path, before] of Object.entries(saved.watched)) {
    let after
    try {
      after = state(path)
    } catch {
      after = { head: null, status: 'the checkout is gone' }
    }
    if (after.head !== before.head || after.status !== before.status) changed.push({ root: path, before, after })
  }
  return { ok: changed.length === 0, targets: saved.targets, changed }
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
