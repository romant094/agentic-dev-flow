// Versions for /adf:update: the plugin version this machine has, the tag the marketplace has
// at most, and the ref a project pins.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
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

export const PLUGIN_KEY_ID = `adf@${MARKETPLACE}`

function userRecord(home) {
  const records = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins?.[PLUGIN_KEY_ID]
  return Array.isArray(records) ? records.find((r) => r.scope === 'user') ?? null : null
}

function dirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

// The changes open in the project (directories of openspec/changes/ but archive/) and the
// worktrees under .claude/worktrees/, paired by name; a change with no worktree has `null`.
export function inFlight(root) {
  const main = mainCheckout(root)
  const changes = dirs(join(main, 'openspec', 'changes')).filter((name) => name !== 'archive')
  const trees = dirs(join(main, '.claude', 'worktrees'))
  const result = changes.map((change) => ({ change, worktree: trees.includes(change) ? join(main, '.claude', 'worktrees', change) : null }))
  for (const tree of trees) {
    if (!changes.includes(tree)) result.push({ change: tree, worktree: join(main, '.claude', 'worktrees', tree) })
  }
  return result
}

// Where the update comes from: the project's declared marketplace, else this machine's record.
function remoteUrl(root, scope, home) {
  if (scope === 'project') {
    return readJson(join(mainCheckout(root), SETTINGS_PATH))?.extraKnownMarketplaces?.[MARKETPLACE]?.source?.url ?? null
  }
  return readJson(join(home, 'plugins', 'known_marketplaces.json'))?.[MARKETPLACE]?.source?.url ?? null
}

// Scope: `project` when the main directory's settings declare the marketplace with a ref (pinned
// or not), else `user` when adf has a user-scope install record, else `none`. A pinned project
// is compared against its ref; a user-scope install against its installed version. An unpinned
// ref is never compared, and its latest tag is not asked for.
// `fetchLatest(url)` gives the newest tag name or null; tests and the notice replace it.
export function checkUpdate(root, { git = defaultGit, home = claudeHome(), fetchLatest = (url) => latestTag(remoteTags(url, { git })) } = {}) {
  const { ref, pinned } = projectRef(root)
  const record = userRecord(home)
  const scope = ref !== null ? 'project' : record ? 'user' : 'none'
  const result = { scope, ref, pinned, installed: null, latest: null, behind: false, pull: false, inFlight: inFlight(root) }
  if (scope === 'none') return result
  result.installed = scope === 'user' ? (VERSION.test(record.version ?? '') ? record.version : null) : installedVersion(PLUGIN_KEY_ID, root, { home })
  if (scope === 'project' && !pinned) return result
  const url = remoteUrl(root, scope, home)
  const latest = url ? fetchLatest(url) : null
  result.latest = latest
  const latestVersion = latest ? TAG.exec(latest)?.[1] : null
  const current = scope === 'project' ? TAG.exec(ref)[1] : result.installed
  if (latestVersion && current) result.behind = compareVersions(current, latestVersion) < 0
  if (scope === 'project' && result.installed) result.pull = compareVersions(result.installed, TAG.exec(ref)[1]) < 0
  return result
}

// The session-start text for a check result; null when there is nothing to say.
export function noticeMessage(check) {
  const lines = []
  const bare = (v) => v?.replace(/^v/, '')
  if (check.pull) lines.push(`This project pins ADF v${bare(check.ref)}; v${check.installed} is installed. Run /adf:update to install it.`)
  if (check.behind) {
    const on = check.scope === 'project' ? `this project is on v${bare(check.ref)}` : `v${check.installed} is installed`
    lines.push(`ADF v${bare(check.latest)} is available; ${on}. Run /adf:update.`)
  }
  return lines.length ? lines.join('\n') : null
}
