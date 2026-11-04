// Versions for /adf:update: the plugin version this machine has, the tag the marketplace has
// at most, and the ref a project pins.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireBranches } from './branches.mjs'
import { classify, hostFiles, keepFromUpdate, replaceFromUpdate } from './host-merge.mjs'
import { indentOf, MARKETPLACE, SETTINGS_PATH } from './host-settings.mjs'
import { codexEnabledIds, codexMarketplace, mainCheckout, selectInstall } from './installed.mjs'
import { migrateConfig } from './migrate.mjs'
import { DECLARATION_FILE, parseVersion, REGISTRY_PATH } from './registry.mjs'
import { cli, detectRuntime, installCommand, runtimeHome } from './runtime.mjs'
import { claudeHome, countsHere, mergeSettings, readJson } from './superpowers.mjs'
import { create, worktreePath } from './workspace.mjs'

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

// For the session-start notice: never waits long, never prompts for a credential.
export const quietGit = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
  })

export function remoteTags(url, { git = defaultGit } = {}) {
  return git(['ls-remote', '--tags', url])
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref) => ref?.startsWith('refs/tags/') && !ref.endsWith('^{}'))
    .map((ref) => ref.slice('refs/tags/'.length))
}

const detected = () => detectRuntime({ scriptPath: fileURLToPath(import.meta.url) })

// The version of the install installedPath picks; null when there is none or it names no version.
export function installedVersion(id, root, { runtime = detected(), home = runtimeHome(runtime) } = {}) {
  try {
    const version = selectInstall(id, root, { runtime, home }).version
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

// A marketplace source's git URL: its `url`, or for a `github` source its repository on GitHub.
export function sourceUrl(source) {
  if (typeof source?.url === 'string') return source.url
  if (source?.source === 'github' && typeof source.repo === 'string') return `https://github.com/${source.repo}.git`
  return null
}

// Where the update comes from: the project's declared marketplace, else this machine's record.
function remoteUrl(root, scope, home, runtime) {
  if (scope === 'project') {
    return sourceUrl(readJson(join(mainCheckout(root), SETTINGS_PATH))?.extraKnownMarketplaces?.[MARKETPLACE]?.source)
  }
  if (runtime === 'codex') {
    const record = codexMarketplace(MARKETPLACE, home)
    if (record?.source_type !== 'git' || typeof record.source !== 'string') return null
    return /^[\w.-]+\/[\w.-]+$/.test(record.source) ? `https://github.com/${record.source}.git` : record.source
  }
  return sourceUrl(readJson(join(home, 'plugins', 'known_marketplaces.json'))?.[MARKETPLACE]?.source)
}

// Scope: `project` when the main directory's settings declare the marketplace with a ref (pinned
// or not), else `user` when adf has a user-scope install record, else `none`. A pinned project
// is compared against its ref; a user-scope install against its installed version. An unpinned
// ref is never compared, and its latest tag is not asked for.
// `fetchLatest(url)` gives the newest tag name or null; tests and the notice replace it.
export function checkUpdate(root, { git = quietGit, runtime = detected(), home = runtimeHome(runtime), fetchLatest = (url) => latestTag(remoteTags(url, { git })) } = {}) {
  const { ref, pinned } = projectRef(root)
  // Codex has no install record of Claude Code's kind: its user install is the enabled plugin's cache.
  const codexVersion = runtime === 'codex' ? installedVersion(PLUGIN_KEY_ID, root, { runtime, home }) : null
  const record = runtime === 'codex' ? (codexVersion ? { version: codexVersion } : null) : userRecord(home)
  const scope = ref !== null ? 'project' : record ? 'user' : 'none'
  const result = { scope, ref, pinned, installed: null, latest: null, behind: false, pull: false, inFlight: inFlight(root) }
  if (scope === 'none') return result
  result.installed = scope === 'user' ? (VERSION.test(record.version ?? '') ? record.version : null) : installedVersion(PLUGIN_KEY_ID, root, { runtime, home })
  if (scope === 'project' && !pinned) return result
  const url = remoteUrl(root, scope, home, runtime)
  const latest = url ? fetchLatest(url) : null
  result.latest = latest
  const latestVersion = latest ? TAG.exec(latest)?.[1] : null
  const current = scope === 'project' ? TAG.exec(ref)[1] : result.installed
  if (latestVersion && current) result.behind = compareVersions(current, latestVersion) < 0
  if (scope === 'project' && result.installed) result.pull = compareVersions(result.installed, TAG.exec(ref)[1]) < 0
  return result
}

// The session-start text for a check result; null when there is nothing to say.
export function noticeMessage(check, { runtime = detected() } = {}) {
  const lines = []
  const update = runtime === 'codex' ? '$adf:update' : '/adf:update'
  const bare = (v) => v?.replace(/^v/, '')
  if (check.pull) lines.push(`This project pins ADF v${bare(check.ref)}; v${check.installed} is installed. Run ${update} to install it.`)
  if (check.behind) {
    const on = check.scope === 'project' ? `this project is on v${bare(check.ref)}` : `v${check.installed} is installed`
    lines.push(`ADF v${bare(check.latest)} is available; ${on}. Run ${update}.`)
  }
  return lines.length ? lines.join('\n') : null
}

const defaultRun = (command, args, { cwd }) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// Where Codex's marketplace is added from when a project pins a ref: the repository, not the user's record.
const CODEX_SOURCE = 'romant094/agentic-dev-flow'

// The package plugins enabled for a scope: ids ending `@agentic-dev-flow` set to true.
function enabledPackagePlugins(main, scope, home, runtime) {
  if (runtime === 'codex') return codexEnabledIds(main, home).filter((id) => id.endsWith(`@${MARKETPLACE}`))
  const merged =
    scope === 'project'
      ? mergeSettings(readJson(join(main, SETTINGS_PATH)), readJson(join(main, '.claude', 'settings.local.json')))
      : mergeSettings(readJson(join(home, 'settings.json')))
  return Object.entries(merged.enabledPlugins)
    .filter(([id, on]) => on === true && id.endsWith(`@${MARKETPLACE}`))
    .map(([id]) => id)
}

// Whether the plugin has an install record of its own for the scope: `claude plugin install` does
// nothing for an installed plugin, and `claude plugin update` refuses one that is not installed.
function hasRecord(id, main, scope, home) {
  const records = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins?.[id]
  if (!Array.isArray(records)) return false
  return records.some((r) => r.scope === scope && (scope === 'user' || countsHere(r, [main])))
}

// The calls of one pull. Claude Code: refresh the marketplace, then update every enabled package
// plugin installed for the scope and install the others. Codex has one user-scope install and no
// update subcommand: when the project pins a ref, the user's marketplace record is moved to it
// first (`add` on a name with another ref is an error, so a record on another ref is removed; the
// same ref is a no-op), then `marketplace upgrade` (which follows the record's ref) and
// `plugin add` for each enabled plugin.
function pullCalls({ main, scope, home, runtime, ref, pinned }) {
  const plugins = enabledPackagePlugins(main, scope, home, runtime)
  if (runtime !== 'codex') {
    return [['plugin', 'marketplace', 'update', MARKETPLACE], ...plugins.map((id) => ['plugin', hasRecord(id, main, scope, home) ? 'update' : 'install', id, '--scope', scope])]
  }
  const calls = []
  if (pinned) {
    const record = codexMarketplace(MARKETPLACE, home)
    if (record && record.ref !== ref) calls.push(['plugin', 'marketplace', 'remove', MARKETPLACE])
    calls.push(['plugin', 'marketplace', 'add', CODEX_SOURCE, '--ref', ref])
  }
  calls.push(['plugin', 'marketplace', 'upgrade', MARKETPLACE], ...plugins.map((id) => ['plugin', 'add', id]))
  return calls
}

// Refreshes the marketplace and brings every enabled package plugin up to date (see pullCalls), in
// the main directory.
// Installing at project scope in Claude Code rewrites .claude/settings.json; the file is restored afterwards, so
// it must be clean before. A failing call stops the pull, after the restore: the error carries `ran` and `restored`.
// Afterwards the install is read again: `installed`, and for a project `ref`. A project whose
// installed release is still older than its pinned ref is a refusal naming both.
export function pull({ root, scope, runtime = detected(), home = runtimeHome(runtime), run = defaultRun }) {
  if (scope !== 'project' && scope !== 'user') throw new Error(`cannot pull for scope ${scope}`)
  const main = mainCheckout(root)
  const command = cli(runtime)
  const touchesSettings = scope === 'project' && runtime !== 'codex'
  const gitOut = (args) => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (touchesSettings && gitOut(['status', '--porcelain', '--', SETTINGS_PATH]).trim() !== '') {
    throw new Error(`${SETTINGS_PATH} has uncommitted changes; commit or revert them first`)
  }
  const { ref, pinned } = projectRef(main)
  const calls = pullCalls({ main, scope, home, runtime, ref, pinned: pinned && scope === 'project' })
  const ran = []
  let restored = false
  const restore = () => {
    if (touchesSettings && gitOut(['status', '--porcelain', '--', SETTINGS_PATH]).trim() !== '') {
      gitOut(['checkout', '--', SETTINGS_PATH])
      restored = true
    }
  }
  for (const args of calls) {
    try {
      run(command, args, { cwd: main })
    } catch (cause) {
      restore()
      const stderr = String(cause.stderr ?? cause.message ?? '').trim()
      const error = new Error(`${command} ${args.join(' ')} failed: ${stderr}`)
      error.ran = ran
      error.restored = restored
      throw error
    }
    ran.push(args)
  }
  restore()
  if (scope === 'user') {
    const version = runtime === 'codex' ? installedVersion(PLUGIN_KEY_ID, main, { runtime, home }) : userRecord(home)?.version
    return { ran, restored, installed: VERSION.test(version ?? '') ? version : null }
  }
  const installed = installedVersion(PLUGIN_KEY_ID, main, { runtime, home })
  if (pinned && (installed === null || compareVersions(installed, TAG.exec(ref)[1]) < 0)) {
    const again = runtime === 'codex' ? installCommand(runtime, PLUGIN_KEY_ID, scope) : `claude plugin update ${PLUGIN_KEY_ID} --scope project`
    const error = new Error(`after the pull ADF ${installed ? `v${installed}` : 'is not'} installed for this project, older than the pinned ${ref}; run ${again} and check its output`)
    error.ran = ran
    error.restored = restored
    throw error
  }
  return { ran, restored, installed, ref }
}

// ---------------------------------------------------------------- /adf:update: plan, apply, commit

const MARKETPLACE_FILE = '.claude-plugin/marketplace.json'
const CONTRACT_FILE = 'plugins/adf/contract/contract.json'
const CONVENTIONAL = /^[a-z]+(\([^)]*\))?!?: \S/
const bare = (tag) => TAG.exec(tag)[1]
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
const nameOf = (id) => id.slice(0, id.lastIndexOf('@'))

export const updateChange = (version) => `adf-update-${version}`
export const updateBranch = (version) => `chore/${updateChange(version)}`
export const updateRecord = (version) => `.adf/update-${version}.json`
export const updateTitle = (version) => `chore(adf): update to v${version}`

// `reason` says why an incompatible contract refuses the update.
function contractCheck(registry, clone) {
  const from = registry?.contract ?? null
  const to = readJson(join(clone, CONTRACT_FILE))?.version ?? null
  const [a, b] = [parseVersion(from), parseVersion(to)]
  const compatible = Boolean(a && b && a.major === b.major)
  if (compatible) return { from, to, compatible }
  const reason = !a
    ? `${REGISTRY_PATH} has no valid "contract" field (${JSON.stringify(from)}); set it to the contract version the project runs`
    : !b
      ? `the new release has no contract version in ${CONTRACT_FILE}`
      : `the update moves the extension contract from ${from} to ${to}, a major change; every plugin must move to contract ${to} first`
  return { from, to, compatible, reason }
}

// The integration branch as the update branch will fork from it (lib/workspace.mjs create):
// `origin/<integration>` after a fetch when the host has a remote, else the local branch.
function integrationRef(main, integration) {
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    git('remote', 'get-url', 'origin')
  } catch {
    return integration
  }
  git('fetch', 'origin', integration)
  return `origin/${integration}`
}

function showAt(main, ref) {
  return (path) => {
    try {
      return execFileSync('git', ['-C', main, 'show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return null
    }
  }
}

// What plan and apply read of the project: the settings, the registry and the host files at the
// integration branch's tip (`base`), never the main directory's working tree, which may be behind
// or on another branch.
function integrationState(root) {
  const main = mainCheckout(root)
  const base = integrationRef(main, requireBranches(main).integration)
  const baseCommit = execFileSync('git', ['-C', main, 'rev-parse', `${base}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const show = showAt(main, baseCommit)
  const settingsText = show(SETTINGS_PATH)
  const settings = settingsText === null ? null : JSON.parse(settingsText)
  const source = settings?.extraKnownMarketplaces?.[MARKETPLACE]?.source
  if (!source) throw new Error(`${base}:${SETTINGS_PATH} declares no ${MARKETPLACE} marketplace`)
  const registryText = show(REGISTRY_PATH)
  if (registryText === null) throw new Error(`${base} has no ${REGISTRY_PATH}; run /adf:init`)
  return { main, base, baseCommit, show, settingsText, settings, source, registryText, registry: JSON.parse(registryText) }
}

// The host files with the project's copy at the integration branch and their class.
function classified(state, clones) {
  return hostFiles(clones.old, clones.new, state.registry).map((file) => {
    const ours = state.show(file.path)
    return { ...file, ours, class: classify({ ...file, ours, path: file.path }) }
  })
}

// What would stop apply making the update branch, found before anything is cloned: uncommitted
// changes to tracked files in the main directory, or a branch or worktree of the same update.
function blockers(main, version) {
  const git = gitAt(main)
  const found = []
  const dirty = git('status', '--porcelain', '--untracked-files=no').trimEnd()
  if (dirty) found.push(`the main directory has uncommitted changes to tracked files:\n${dirty}`)
  try {
    git('rev-parse', '--verify', '--quiet', `refs/heads/${updateBranch(version)}`)
    found.push(`branch ${updateBranch(version)} already exists`)
  } catch {}
  if (existsSync(worktreePath(main, updateChange(version)))) found.push(`${worktreePath(main, updateChange(version))} already exists`)
  return found
}

// Compares the integration branch's pinned release with `to` (the latest tag by default). When
// `to` is newer, clones the repository once into a temporary directory and checks the two tags
// out beside it; the clones are left for apply and for the command to remove. `baseCommit` is
// the integration commit read; apply refuses when the branch moved since.
export function planUpdate(root, { to = null, git = defaultGit } = {}) {
  const state = integrationState(root)
  const ref = state.source.ref ?? null
  if (typeof ref !== 'string' || !TAG.test(ref)) throw new Error(`${state.base}:${SETTINGS_PATH} pins no release of ${MARKETPLACE} (ref: ${ref ?? 'none'}); pin a tag v<x.y.z> first`)
  const url = sourceUrl(state.source)
  if (!url) throw new Error(`${state.base}:${SETTINGS_PATH} declares no url for the ${MARKETPLACE} marketplace`)
  const target = to ?? latestTag(remoteTags(url, { git }))
  if (!target) throw new Error(`${url} has no release tag v<x.y.z>`)
  const base = { base: state.base, baseCommit: state.baseCommit }
  if (compareVersions(bare(target), bare(ref)) <= 0) return { from: ref, to: target, ...base, upToDate: true }
  const blocked = blockers(state.main, bare(target))
  if (blocked.length) throw new Error(`the update to ${target} cannot start: ${blocked.join('; ')}`)
  const tmp = mkdtempSync(join(tmpdir(), 'adf-update-'))
  const clones = { old: join(tmp, 'old'), new: join(tmp, 'new'), repo: join(tmp, 'repo') }
  try {
    try {
      git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', url, clones.repo])
      git(['-C', clones.repo, 'worktree', 'add', '--detach', clones.old, ref])
      git(['-C', clones.repo, 'worktree', 'add', '--detach', clones.new, target])
    } catch (error) {
      throw new Error(`cannot clone ${url} at ${ref} and ${target}: ${String(error.stderr ?? error.message).trim()}`)
    }
    const plugins = changedPlugins(state.registry, readJson(join(clones.old, MARKETPLACE_FILE)), readJson(join(clones.new, MARKETPLACE_FILE)))
    const log = {}
    for (const name of ['adf', ...plugins.filter((p) => p.changed && p.to !== null).map((p) => nameOf(p.id))]) {
      log[name] = git(['-C', clones.repo, 'log', '--format=%s', `${ref}..${target}`, '--', `plugins/${name}`])
        .split('\n')
        .filter((subject) => CONVENTIONAL.test(subject))
    }
    const files = classified(state, clones).map((file) => ({ path: file.path, class: file.class }))
    return { from: ref, to: target, ...base, upToDate: false, plugins, log, hostFiles: files, contract: contractCheck(state.registry, clones.new), inFlight: inFlight(root), clones }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

// Removes the temporary directory plan made for its clones: one parent `adf-update-*` directly in
// the system temporary directory, holding old, new and repo. Anything else is refused.
export function removeClones(clones) {
  const parent = dirname(resolve(clones.repo))
  const shaped = ['old', 'new'].every((k) => dirname(resolve(clones[k])) === parent) && basename(parent).startsWith('adf-update-')
  const refusal = new Error(`${parent} is not a temporary directory plan made; remove it yourself`)
  if (!shaped) throw refusal
  if (!existsSync(parent)) return { removed: null }
  if (dirname(realpathSync(parent)) !== realpathSync(tmpdir())) throw refusal
  rmSync(parent, { recursive: true, force: true })
  return { removed: parent }
}

function gitAt(dir) {
  return (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitFiles(worktree, files, version) {
  const git = gitAt(worktree)
  git('add', '--', ...files)
  try {
    git('diff', '--cached', '--quiet')
    throw new Error(`nothing to commit in ${worktree}: the update's files are already committed or unchanged`)
  } catch (error) {
    if (error.status !== 1) throw error
  }
  git('commit', '--quiet', '-m', updateTitle(version))
  return git('branch', '--show-current').trim()
}

// Runs from the new release's clone. Everything is computed from the integration branch and the
// two clones first, so a refusal writes nothing; then the branch chore/adf-update-<version> and
// its worktree are made, the files written, and, with no conflict and no manual file, committed.
// `base` is plan's `baseCommit`: an integration branch that moved since is refused, so apply
// merges exactly what plan showed. The classes are this release's own.
// `choices` maps each edited host file to keep | replace | manual.
export async function applyUpdate(root, { to, clones, base, choices = {} }) {
  const version = bare(to)
  let atTo = false
  try {
    const git = gitAt(clones.new)
    atTo = git('rev-parse', 'HEAD').trim() === git('rev-parse', `${to}^{commit}`).trim()
  } catch {}
  if (!atTo) throw new Error(`${clones.new} is not at ${to}; run plan again`)
  const state = integrationState(root)
  if (state.baseCommit !== base) throw new Error(`the integration branch moved since plan (${state.base} is ${state.baseCommit}, plan read ${base}); run plan again`)
  const { main, settings, settingsText, source, registry, registryText } = state
  const newMarketplace = readJson(join(clones.new, MARKETPLACE_FILE))
  if (!newMarketplace) throw new Error(`${clones.new} holds no ${MARKETPLACE_FILE}; run plan again`)

  const contract = contractCheck(registry, clones.new)
  if (!contract.compatible) throw new Error(`the update to v${version} is refused: ${contract.reason}`)
  const files = classified(state, clones)
  const missing = files.filter((f) => f.class === 'edited' && !Object.hasOwn(choices, f.path)).map((f) => f.path)
  if (missing.length) throw new Error(`no choice for ${missing.join(', ')}: each edited host file needs keep, replace or manual`)

  source.ref = to
  const writes = new Map([[SETTINGS_PATH, `${JSON.stringify(settings, null, indentOf(settingsText))}\n`]])
  const dropped = []
  const ran = {}
  for (const row of changedPlugins(registry, readJson(join(clones.old, MARKETPLACE_FILE)), newMarketplace)) {
    if (row.to === null) {
      dropped.push(row.id)
      continue
    }
    const entry = registry.extensions.find((e) => e.plugin === row.id)
    if (row.changed) {
      const dir = join(clones.new, 'plugins', nameOf(row.id))
      const declaration = readJson(join(dir, DECLARATION_FILE)) ?? { name: nameOf(row.id) }
      const migrated = await migrateConfig(entry, declaration, dir, { from: row.from, to: row.to })
      if (migrated.ran.length) {
        entry.config = migrated.config
        ran[row.id] = migrated.ran
      }
    }
    entry.version = row.to
  }
  registry.contract = contract.to
  const registryNew = `${JSON.stringify(registry, null, 2)}\n`
  if (registryNew !== registryText) writes.set(REGISTRY_PATH, registryNew)

  const manual = []
  const conflicts = []
  for (const file of files) {
    if (file.class === 'new') writes.set(file.path, file.theirs)
    if (file.class === 'replace') writes.set(file.path, replaceFromUpdate(file.path, file.ours, file.theirs))
    if (file.class !== 'edited') continue
    const choice = choices[file.path]
    if (choice === 'manual') manual.push(file.path)
    else if (choice === 'replace') writes.set(file.path, replaceFromUpdate(file.path, file.ours, file.theirs))
    else {
      const merged = keepFromUpdate(file.path, file.base, file.ours, file.theirs)
      if (merged.conflicts) conflicts.push(file.path)
      writes.set(file.path, merged.text)
    }
  }

  const change = updateChange(version)
  const branch = updateBranch(version)
  let worktree
  try {
    worktree = create(main, { change, branch, base: 'integration' }).root
  } catch (error) {
    if (error.message.startsWith('uncommitted changes')) throw new Error(`the main directory has ${error.message}`)
    throw new Error(`cannot make the update branch: ${error.message}`)
  }
  for (const [path, text] of writes) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true })
    writeFileSync(join(worktree, path), text)
  }
  const written = [...writes.keys()]
  const record = join(worktree, updateRecord(version))
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, `${JSON.stringify({ to, written, manual, conflicts }, null, 2)}\n`)
  const result = { worktree, branch, written, manual, conflicts, dropped, ran, committed: false }
  if (conflicts.length === 0 && manual.length === 0) {
    // A failing commit (a hook, say) leaves the files written: `commit` finishes it.
    try {
      commitFiles(worktree, written, version)
      result.committed = true
    } catch (error) {
      result.commitError = String(error.stderr || error.message).trim()
    }
  }
  return result
}

// Finishes an update apply left uncommitted: stages the files it wrote and the manual ones, once
// none holds a conflict marker, and commits.
export function commitUpdate(worktree, { to }) {
  const version = bare(to)
  const record = readJson(join(worktree, updateRecord(version)))
  if (!record) throw new Error(`${worktree} holds no ${updateRecord(version)}; run apply first`)
  const files = [...record.written, ...record.manual]
  const marked = files.filter((path) => /^<<<<<<< /m.test(readText(join(worktree, path)) ?? ''))
  if (marked.length) throw new Error(`${marked.join(', ')} still hold conflict markers; resolve them, then commit again`)
  const branch = commitFiles(worktree, files, version)
  return { worktree, branch, committed: true }
}
