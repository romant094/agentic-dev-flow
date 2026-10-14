// Which change a phase acts on. Neither source is complete alone: the main checkout's branch
// rarely holds a change directory (a change is committed only on its own branch), and a change
// worktree holds only its own change. Every checkout of the repository is read; a group
// worktree is part of its change and is skipped. Only the change directories found count: a
// branch name is never taken for a change name, because the developer may edit it at propose.
import { listChanges } from './changes.mjs'
import { mainCheckout } from './installed.mjs'
import { gitIn } from './workspace.mjs'

const GROUP_DIR = /--group-\d+$/

export function checkouts(root) {
  const main = mainCheckout(root)
  const porcelain = gitIn(main)('worktree', 'list', '--porcelain')
  const list = []
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n')
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null
    if (lines.includes('bare') || lines.includes('prunable') || GROUP_DIR.test(path)) continue
    list.push({ root: path, branch, main: path === main })
  }
  return list
}

// A change worktree whose change directory cannot be read is still a change in flight: it is
// listed with no name, for the developer to identify, never dropped.
export function findChanges(root, schema) {
  const changes = []
  const unresolved = []
  for (const checkout of checkouts(root)) {
    let found
    try {
      found = listChanges(checkout.root, schema).changes
    } catch {
      found = []
    }
    for (const change of found) {
      changes.push({ ...change, root: checkout.root, branch: checkout.branch, main: checkout.main })
    }
    if (found.length === 0 && !checkout.main) unresolved.push({ root: checkout.root, branch: checkout.branch })
  }
  return { changes, unresolved }
}
