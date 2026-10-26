// The patch an ingest reply carries for one page: the `git diff` of writing `text` to `path`
// (null deletes it) in the repository at `root`. The tree is left as it was.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const git = (root, ...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function pagePatch(root, path, text) {
  const file = join(root, path)
  const before = existsSync(file) ? readFileSync(file) : null
  if (text === null) rmSync(file)
  else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  try {
    if (before === null) git(root, 'add', '-N', '--', path)
    return git(root, 'diff', '--no-color', '--no-ext-diff', '--', path)
  } finally {
    if (before === null) {
      git(root, 'reset', '-q', '--', path)
      rmSync(file)
    } else writeFileSync(file, before)
  }
}
