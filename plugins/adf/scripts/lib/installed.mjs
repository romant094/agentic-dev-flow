// Where an installed Claude Code plugin lives on this machine. A registry entry names a plugin
// by id (`name@marketplace`); its directory is the cache path Claude Code recorded when it
// installed the plugin, which changes with every version, so it is never written down.
//
// Claude Code records a project- or local-scope install once per checkout, worktrees
// included, and a change worktree is rarely opened as a session of its own. The plugin is
// therefore looked up for the main checkout, whatever worktree the core runs in.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectRuntime, installCommand, runtimeHome } from './runtime.mjs'
import { countsHere, mergeSettings, readJson } from './superpowers.mjs'
import { readToml } from './toml.mjs'

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

export function installedPath(id, root, opts = {}) {
  return selectInstall(id, root, opts).path
}

// The install installedPath uses: its directory and, when known, its version. The runtime is
// the one that runs this script unless the caller names it; the home is that runtime's.
export function selectInstall(id, root, { runtime = detectRuntime({ scriptPath: fileURLToPath(import.meta.url) }), home = runtimeHome(runtime), exists = existsSync } = {}) {
  const main = mainCheckout(root)
  if (runtime === 'codex') return selectCodexInstall(id, main, { home, exists })
  const records = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins?.[id]
  const here = Array.isArray(records) ? records.filter((r) => countsHere(r, [main, root])) : []
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
  if (found) return { path: found.installPath, version: found.version ?? null }
  // Project trust enables a plugin with no record of its own; its cache directory is the install.
  if (settings.enabledPlugins[id] === true) {
    const cached = cachedInstall(id, home)
    if (cached && exists(cached.path)) return cached
  }
  throw absent(`${id} is not installed for this project; run: ${installCommand('claude-code', id, 'project')}; run it from ${main}`, id, 'not-installed')
}

// The cache directory of the version the marketplace clone lists for the plugin.
function cachedInstall(id, home) {
  const [name, marketplace] = id.split('@')
  const listed = readJson(join(home, 'plugins', 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json'))
  const version = listed?.plugins?.find((p) => p.name === name)?.version
  return version ? { path: join(home, 'plugins', 'cache', marketplace, name, version), version } : null
}

// Codex: `[plugins."<id>"] enabled` from the user's config.toml, then the project's own
// <main>/.codex/config.toml (the later layer wins; Codex loads the project's only when it is
// trusted, the core reads it regardless). An enabled plugin's install is its cache directory.
function codexEnabled(id, main, home) {
  const layers = [join(home, 'config.toml'), join(main, '.codex', 'config.toml')]
  return Object.assign({}, ...layers.map((path) => readTomlFile(path)[`plugins.${id}`]))
}

function readTomlFile(path) {
  try {
    return readToml(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// The package plugins Codex has enabled (ids with `enabled = true`), from the same two layers.
export function codexEnabledIds(main, home) {
  const merged = {}
  for (const path of [join(home, 'config.toml'), join(main, '.codex', 'config.toml')]) {
    for (const [table, values] of Object.entries(readTomlFile(path))) {
      if (table.startsWith('plugins.')) merged[table] = { ...merged[table], ...values }
    }
  }
  return Object.entries(merged).filter(([, v]) => v.enabled === true).map(([table]) => table.slice('plugins.'.length))
}

// The user's `[marketplaces.<name>]` record in Codex's config.toml: { source_type, source, ref, ... }.
export function codexMarketplace(name, home) {
  return readTomlFile(join(home, 'config.toml'))[`marketplaces.${name}`] ?? null
}

function selectCodexInstall(id, main, { home, exists }) {
  const { enabled } = codexEnabled(id, main, home)
  if (enabled === false) throw absent(`${id} is installed but disabled`, id, 'disabled')
  if (enabled === true) {
    const cached = codexCachedInstall(id, home)
    if (cached && exists(cached.path)) return cached
  }
  throw absent(`${id} is not installed for this project; run: ${installCommand('codex', id, 'user')}`, id, 'not-installed')
}

// The cache directory of the version the marketplace clone lists for the plugin, else the only
// version directory in the cache. A git marketplace is cloned to <home>/.tmp/marketplaces/<name>.
function codexCachedInstall(id, home) {
  const [name, marketplace] = id.split('@')
  const cache = join(home, 'plugins', 'cache', marketplace, name)
  const version = listedVersion(join(home, '.tmp', 'marketplaces', marketplace), name) ?? onlyVersion(cache)
  return version ? { path: join(cache, version), version } : null
}

function listedVersion(clone, name) {
  const listing = readJson(join(clone, '.agents', 'plugins', 'marketplace.json')) ?? readJson(join(clone, '.claude-plugin', 'marketplace.json'))
  const entry = listing?.plugins?.find((p) => p.name === name)
  if (!entry) return null
  const source = typeof entry.source === 'string' ? entry.source : entry.source?.path
  const dir = join(clone, source ?? '')
  return readJson(join(dir, '.claude-plugin', 'plugin.json'))?.version ?? readJson(join(dir, 'plugin.json'))?.version ?? entry.version ?? null
}

function onlyVersion(dir) {
  try {
    const versions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
    return versions.length === 1 ? versions[0].name : null
  } catch {
    return null
  }
}
