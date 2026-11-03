// Versions for /adf:update: the plugin version this machine has, the tag the marketplace has
// at most, and the ref a project pins.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { requireBranches } from './branches.mjs'
import { classify, hostFiles, mergeKeep, replaceFromUpdate } from './host-merge.mjs'
import { indentOf, MARKETPLACE, SETTINGS_PATH } from './host-settings.mjs'
import { mainCheckout, selectInstall } from './installed.mjs'
import { migrateConfig } from './migrate.mjs'
import { DECLARATION_FILE, parseVersion, REGISTRY_PATH } from './registry.mjs'
import { claudeHome, mergeSettings, readJson } from './superpowers.mjs'
import { create } from './workspace.mjs'

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

const defaultClaude = (args, { cwd }) => execFileSync('claude', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// The package plugins enabled for a scope: ids ending `@agentic-dev-flow` set to true.
function enabledPackagePlugins(main, scope, home) {
  const merged =
    scope === 'project'
      ? mergeSettings(readJson(join(main, SETTINGS_PATH)), readJson(join(main, '.claude', 'settings.local.json')))
      : mergeSettings(readJson(join(home, 'settings.json')))
  return Object.entries(merged.enabledPlugins)
    .filter(([id, on]) => on === true && id.endsWith(`@${MARKETPLACE}`))
    .map(([id]) => id)
}

// Refreshes the marketplace, then installs every enabled package plugin, in the main directory.
// Installing at project scope rewrites .claude/settings.json; the file is restored afterwards, so
// it must be clean before. A failing `claude` call stops the pull, after the restore: the error carries `ran` and `restored`.
export function pull({ root, scope, home = claudeHome(), claude = defaultClaude }) {
  if (scope !== 'project' && scope !== 'user') throw new Error(`cannot pull for scope ${scope}`)
  const main = mainCheckout(root)
  const gitOut = (args) => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (scope === 'project' && gitOut(['status', '--porcelain', '--', SETTINGS_PATH]).trim() !== '') {
    throw new Error(`${SETTINGS_PATH} has uncommitted changes; commit or revert them first`)
  }
  const calls = [['plugin', 'marketplace', 'update', MARKETPLACE]]
  for (const id of enabledPackagePlugins(main, scope, home)) calls.push(['plugin', 'install', id, '--scope', scope])
  const ran = []
  let restored = false
  const restore = () => {
    if (scope === 'project' && gitOut(['status', '--porcelain', '--', SETTINGS_PATH]).trim() !== '') {
      gitOut(['checkout', '--', SETTINGS_PATH])
      restored = true
    }
  }
  for (const args of calls) {
    try {
      claude(args, { cwd: main })
    } catch (cause) {
      restore()
      const stderr = String(cause.stderr ?? cause.message ?? '').trim()
      const error = new Error(`claude ${args.join(' ')} failed: ${stderr}`)
      error.ran = ran
      error.restored = restored
      throw error
    }
    ran.push(args)
  }
  restore()
  return { ran, restored }
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

function contractCheck(registry, clone) {
  const from = registry?.contract ?? null
  const to = readJson(join(clone, CONTRACT_FILE))?.version ?? null
  const [a, b] = [parseVersion(from), parseVersion(to)]
  return { from, to, compatible: Boolean(a && b && a.major === b.major) }
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
  const show = showAt(main, base)
  const settingsText = show(SETTINGS_PATH)
  const settings = settingsText === null ? null : JSON.parse(settingsText)
  const source = settings?.extraKnownMarketplaces?.[MARKETPLACE]?.source
  if (!source) throw new Error(`${base}:${SETTINGS_PATH} declares no ${MARKETPLACE} marketplace`)
  const registryText = show(REGISTRY_PATH)
  if (registryText === null) throw new Error(`${base} has no ${REGISTRY_PATH}; run /adf:init`)
  return { main, base, show, settingsText, settings, source, registryText, registry: JSON.parse(registryText) }
}

// The host files with the project's copy at the integration branch and their class.
function classified(state, clones) {
  return hostFiles(clones.old, clones.new, state.registry).map((file) => {
    const ours = state.show(file.path)
    return { ...file, ours, class: classify({ ...file, ours }) }
  })
}

// Compares the integration branch's pinned release with `to` (the latest tag by default). When
// `to` is newer, clones the repository once into a temporary directory and checks the two tags
// out beside it; the clones are left for apply and for the command to remove.
export function planUpdate(root, { to = null, git = defaultGit } = {}) {
  const state = integrationState(root)
  const ref = state.source.ref ?? null
  if (typeof ref !== 'string' || !TAG.test(ref)) throw new Error(`${state.base}:${SETTINGS_PATH} pins no release of ${MARKETPLACE} (ref: ${ref ?? 'none'}); pin a tag v<x.y.z> first`)
  const url = state.source.url
  if (!url) throw new Error(`${state.base}:${SETTINGS_PATH} declares no url for the ${MARKETPLACE} marketplace`)
  const target = to ?? latestTag(remoteTags(url, { git }))
  if (!target) throw new Error(`${url} has no release tag v<x.y.z>`)
  if (compareVersions(bare(target), bare(ref)) <= 0) return { from: ref, to: target, base: state.base, upToDate: true }
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
    return { from: ref, to: target, base: state.base, upToDate: false, plugins, log, hostFiles: files, contract: contractCheck(state.registry, clones.new), inFlight: inFlight(root), clones }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
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
// `classes` is plan's `hostFiles`: a host file whose class changed since plan is refused.
// `choices` maps each edited host file to keep | replace | manual.
export async function applyUpdate(root, { to, clones, classes, choices = {} }) {
  const version = bare(to)
  let atTo = false
  try {
    const git = gitAt(clones.new)
    atTo = git('rev-parse', 'HEAD').trim() === git('rev-parse', `${to}^{commit}`).trim()
  } catch {}
  if (!atTo) throw new Error(`${clones.new} is not at ${to}; run plan again`)
  const state = integrationState(root)
  const { main, settings, settingsText, source, registry, registryText } = state
  const newMarketplace = readJson(join(clones.new, MARKETPLACE_FILE))
  if (!newMarketplace) throw new Error(`${clones.new} holds no ${MARKETPLACE_FILE}; run plan again`)

  const contract = contractCheck(registry, clones.new)
  if (!contract.compatible) {
    throw new Error(`v${version} moves the extension contract from ${contract.from} to ${contract.to}, a major change: the update is refused; every plugin must move to contract ${contract.to} first`)
  }
  const files = classified(state, clones)
  const planned = new Map(classes.map((file) => [file.path, file.class]))
  const moved = files.filter((f) => planned.get(f.path) !== f.class).map((f) => `${f.path} (${planned.get(f.path) ?? 'not listed'} at plan, ${f.class} now)`)
  if (moved.length) throw new Error(`${state.base} changed since plan: ${moved.join(', ')}; run plan again`)
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
    if (['new', 'replace'].includes(file.class)) writes.set(file.path, file.theirs)
    if (file.class !== 'edited') continue
    const choice = choices[file.path]
    if (choice === 'manual') manual.push(file.path)
    else if (choice === 'replace') writes.set(file.path, replaceFromUpdate(file.path, file.ours, file.theirs))
    else {
      const merged = mergeKeep(file.base, file.ours, file.theirs)
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
