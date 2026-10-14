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

export function findChanges(root, schema) {
  const changes = []
  for (const checkout of checkouts(root)) {
    for (const change of listChanges(checkout.root, schema).changes) {
      changes.push({ ...change, root: checkout.root, branch: checkout.branch, main: checkout.main })
    }
  }
  return { changes }
}
