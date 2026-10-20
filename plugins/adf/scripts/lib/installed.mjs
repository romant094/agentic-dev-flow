// Where an installed Claude Code plugin lives on this machine. A registry entry names a plugin
// by id (`name@marketplace`); its directory is the cache path Claude Code recorded when it
// installed the plugin, which changes with every version, so it is never written down.
//
// Claude Code records a project- or local-scope install once per checkout, worktrees
// included, and a change worktree is rarely opened as a session of its own. The plugin is
// therefore looked up for the main checkout, whatever worktree the core runs in.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { claudeHome, countsHere, mergeSettings, readJson } from './superpowers.mjs'

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/

export function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return dirname(common)
  } catch {
    return resolve(root)
  }
}

// `absent` lets a caller treat the entry as absent rather than as broken.
function absent(message, id, reason) {
  const error = new Error(message)
  error.absent = { id, reason }
  return error
}

export function installedPath(id, root, { home = claudeHome(), exists = existsSync } = {}) {
  const main = mainCheckout(root)
  const records = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins?.[id]
  const here = Array.isArray(records) ? records.filter((r) => countsHere(r, main)) : []
  const settings = mergeSettings(
    readJson(join(home, 'settings.json')),
    readJson(join(main, '.claude', 'settings.json')),
    readJson(join(main, '.claude', 'settings.local.json'))
  )
  if (settings.enabledPlugins[id] === false) throw absent(`${id} is installed but disabled`, id, 'disabled')
  // The most specific install wins: local, then project, then user.
  const rank = { local: 0, project: 1, user: 2 }
  const found = here
    .filter((r) => r.installPath && exists(r.installPath))
    .sort((a, b) => (rank[a.scope] ?? 2) - (rank[b.scope] ?? 2))[0]
  if (!found) throw absent(`${id} is not installed for this project; run: claude plugin install ${id} --scope project`, id, 'not-installed')
  return found.installPath
}
