// Versions for /adf:update: the plugin version this machine has, the tag the marketplace has
// at most, and the ref a project pins.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { MARKETPLACE, SETTINGS_PATH } from './host-settings.mjs'
import { mainCheckout, selectInstall } from './installed.mjs'
import { claudeHome, readJson } from './superpowers.mjs'

const VERSION = /^\d+\.\d+\.\d+$/
const TAG = /^v(\d+\.\d+\.\d+)$/

// Numeric, per part: 0.9.0 < 0.10.0.
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}

export function latestTag(tags) {
  let best = null
  for (const tag of tags) {
    const version = TAG.exec(tag)?.[1]
    if (version && (best === null || compareVersions(version, TAG.exec(best)[1]) > 0)) best = tag
  }
  return best
}

// An unpinned ref (a branch, or none) is reported as it is and never compared.
export function projectRef(root) {
  const settings = readJson(join(mainCheckout(root), SETTINGS_PATH))
  const ref = settings?.extraKnownMarketplaces?.[MARKETPLACE]?.source?.ref
  return typeof ref === 'string' ? { ref, pinned: TAG.test(ref) } : { ref: null, pinned: false }
}

const defaultGit = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function remoteTags(url, { git = defaultGit } = {}) {
  return git(['ls-remote', '--tags', url])
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref) => ref?.startsWith('refs/tags/') && !ref.endsWith('^{}'))
    .map((ref) => ref.slice('refs/tags/'.length))
}

// The version of the install installedPath picks; null when there is none or it names no version.
export function installedVersion(id, root, { home = claudeHome() } = {}) {
  try {
    const version = selectInstall(id, root, { home }).version
    return VERSION.test(version ?? '') ? version : null
  } catch (error) {
    if (error.absent) return null
    throw error
  }
}

// The package plugins a registry enables (ids ending `@agentic-dev-flow`), each with the version
// it was configured at and the one the new marketplace offers. `from` is the entry's own
// version, else the old marketplace's, else null (a plugin the old marketplace lacked). A plugin
// the new marketplace dropped is reported with `to: null`, changed.
export function changedPlugins(registry, oldMarketplace, newMarketplace) {
  const versionOf = (marketplace, name) => marketplace?.plugins?.find((p) => p.name === name)?.version ?? null
  const result = []
  for (const entry of registry?.extensions ?? []) {
    if (typeof entry?.plugin !== 'string' || !entry.plugin.endsWith(`@${MARKETPLACE}`)) continue
    const id = entry.plugin
    const name = id.slice(0, id.lastIndexOf('@'))
    const from = entry.version ?? versionOf(oldMarketplace, name)
    const to = versionOf(newMarketplace, name)
    result.push({ id, from, to, changed: from !== to })
  }
  return result
}
