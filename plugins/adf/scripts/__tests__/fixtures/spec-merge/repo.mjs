// A host repository for the merge's git tests: develop holds the main specs, and the change
// add-x lives on feat/add-x in its own worktree with its delta specs and .adf.json
// (base develop). `origin: true` adds a bare remote and fetches it, so the base ref is
// origin/develop.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

export function commitFiles(dir, files, message = 'edit') {
  put(dir, files)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

// `main` and `delta` map capability -> spec text.
export function mergeRepo({ main = {}, delta = {}, origin = false } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'adf-merge-')))
  const root = join(top, 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  commitFiles(root, { 'a.txt': 'a\n', ...Object.fromEntries(Object.entries(main).map(([c, t]) => [`openspec/specs/${c}/spec.md`, t])) }, 'init')
  if (origin) {
    execFileSync('git', ['clone', '-q', '--bare', root, join(top, 'origin.git')])
    git(root, 'remote', 'add', 'origin', join(top, 'origin.git'))
    git(root, 'fetch', '-q', 'origin')
  }
  const change = join(top, 'wt')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/add-x', change)
  const dir = 'openspec/changes/add-x'
  commitFiles(change, {
    [`${dir}/proposal.md`]: '# add-x\n',
    [`${dir}/.adf.json`]: '{"base":"develop"}\n',
    ...Object.fromEntries(Object.entries(delta).map(([c, t]) => [`${dir}/specs/${c}/spec.md`, t]))
  }, 'propose')
  // Develop moves on: commit there, and push when there is a remote.
  const onDevelop = (files) => {
    const sha = commitFiles(root, files, 'develop moves')
    if (origin) git(root, 'push', '-q', 'origin', 'develop')
    return sha
  }
  return { root, change, onDevelop }
}
