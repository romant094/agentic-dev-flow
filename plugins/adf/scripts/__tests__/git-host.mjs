// Test fixtures shared by the specs of the apply scripts: a host repository on develop with one
// change, add-x, in its own worktree, and a fake Claude Code home whose Superpowers install
// carries stand-ins for the skill's task-brief and review-package.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setBranches } from '../lib/branches.mjs'
import { ignoreLocalDirs } from '../lib/host-files.mjs'
import { initRegistry } from '../lib/registry.mjs'
import { PLUGIN_ID } from '../lib/superpowers.mjs'
import { create } from '../lib/workspace.mjs'

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

export function commitIn(dir, file, text, message = file) {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

// `files` maps change-relative paths (plan.md, tasks.md, .adf.json, specs/...) to their text.
export function host(files = {}) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'adf-host-'))), 'host')
  execFileSync('git', ['init', '-q', '-b', 'develop', root])
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  initRegistry(root, '1.2')
  setBranches(root, { integration: 'develop', protected: [] })
  ignoreLocalDirs(root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  const made = create(root, { change: 'add-x', branch: 'feat/add-x', base: 'integration' })
  const dir = join(made.root, 'openspec', 'changes', 'add-x')
  mkdirSync(dir, { recursive: true })
  const all = { 'tasks.md': '- [x] 1.1 a\n- [ ] 1.2 b\n', '.adf.json': '{"base":"develop"}\n', ...files }
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  git(made.root, 'add', '.')
  git(made.root, 'commit', '-q', '-m', 'propose')
  return { root, change: made.root, dir }
}

// A Claude Code home with Superpowers installed at a directory holding stand-in scripts. `leak`
// makes task-brief also write into the shared default .superpowers/sdd/plan/.
export function superpowersHome({ leak = false } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'adf-home-')))
  const install = join(home, 'sp')
  const scripts = join(install, 'skills', 'subagent-driven-development', 'scripts')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(join(home, 'plugins'), { recursive: true })
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: install }] } }))
  const leakLine = leak ? 'mkdir -p .superpowers/sdd/plan && echo leaked > .superpowers/sdd/plan/leak.md\n' : ''
  writeFileSync(join(scripts, 'task-brief'), `#!/usr/bin/env bash\nset -eu\n${leakLine}echo "brief $2 of $1" > "$3"\necho "wrote $3"\n`)
  writeFileSync(
    join(scripts, 'review-package'),
    '#!/usr/bin/env bash\nset -eu\ngit merge-base --is-ancestor "$2" "$3" || { echo "HEAD is not a descendant of BASE" >&2; exit 3; }\ngit diff "$2..$3" > "$4"\necho "wrote $4"\n'
  )
  // A marketplace unpacker can strip the exec bit; the scripts are run through bash anyway.
  chmodSync(join(scripts, 'task-brief'), 0o644)
  return home
}
