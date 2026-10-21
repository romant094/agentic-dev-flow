// The `provision` hook of the ADF contract (1.6) for an npm-workspaces monorepo.
//
// A worktree gets a real `node_modules` directory, and so does each workspace whose
// `node_modules` exists in the main checkout. Inside it:
//
// - a workspace self-link (a symlink in the main checkout that resolves inside the repository
//   and outside every `node_modules`) is recreated with the same relative link text, so it
//   resolves to the worktree's own package;
// - a directory that holds a self-link (a scope such as `@acme`) is made real and recursed;
// - `.bin` is made real: each relative link is recreated with the same text, so it resolves
//   through the worktree's own entries (a third-party bin into the main checkout, a workspace
//   bin into the worktree);
// - a cache named in `unshared` is left out: the worktree fills its own;
// - every other entry is an absolute symlink to the main checkout's entry.
//
// The main checkout is only read. Nothing is written through a link: each directory on the
// way to a write is lstat-ed, and a link where a real directory is needed is unlinked first.
// A link the worktree's own tracked tree holds is never removed: the run refuses instead.
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PLUGIN_NAME = 'adf-npm-workspaces'
export const DEFAULT_UNSHARED = ['.vite', '.vite-temp']
export const INSTALL_RULE =
  "Never run npm install, ci, add, update or uninstall in a worktree: its node_modules links into the main checkout's, so the command rewrites the main checkout's dependencies. A dependency update is its own change."

const KINDS = ['change', 'group', 'base-check', 'proof']
const CONFIG_KEYS = ['build', 'unshared']
const TAIL_LINES = 20

class Refusal extends Error {}

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')
const toPosix = (path) => path.split(sep).join('/')

function validate(payload) {
  if (payload === null || typeof payload !== 'object') throw new Refusal('the payload is not a JSON object')
  const config = payload.config ?? {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Refusal('config is not an object')
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) throw new Refusal(`unknown config field(s): ${unknown.join(', ')}; the plugin takes ${CONFIG_KEYS.join(' and ')}`)
  if (config.build !== undefined && !isStringList(config.build)) throw new Refusal('config.build is not a list of commands')
  if (config.unshared !== undefined && !isStringList(config.unshared)) throw new Refusal('config.unshared is not a list of names')
  const input = payload.input
  if (input === null || typeof input !== 'object') throw new Refusal('input is not an object')
  for (const key of ['worktree', 'main']) {
    if (typeof input[key] !== 'string' || !isAbsolute(input[key])) throw new Refusal(`input.${key} is not an absolute path`)
  }
  if (!KINDS.includes(input.kind)) throw new Refusal(`input.kind is not one of ${KINDS.join(', ')}`)
  return {
    worktree: resolve(input.worktree),
    main: resolve(input.main),
    build: config.build ?? [],
    unshared: [...new Set([...DEFAULT_UNSHARED, ...(config.unshared ?? [])])]
  }
}

const lstat = (path) => lstatSync(path, { throwIfNoEntry: false })

function realpath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function sortedEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// The workspace directories the root package.json names, relative to the main checkout. A
// pattern segment is a literal name or holds `*` (any name not starting with a dot); a
// negation or a `**` pattern is reported and skipped.
export function expandWorkspaces(main, patterns, notes) {
  const found = new Set()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.startsWith('!') || pattern.includes('**')) {
      notes.push(`workspaces pattern ${JSON.stringify(pattern)} is not supported; its node_modules was not provisioned.`)
      continue
    }
    let dirs = ['']
    for (const segment of pattern.split('/').filter((s) => s !== '' && s !== '.')) {
      if (!segment.includes('*')) {
        dirs = dirs.map((dir) => (dir ? `${dir}/${segment}` : segment))
        continue
      }
      const re = new RegExp(`^${segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
      dirs = dirs.flatMap((dir) => {
        try {
          return sortedEntries(join(main, dir))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && re.test(entry.name))
            .map((entry) => (dir ? `${dir}/${entry.name}` : entry.name))
        } catch {
          return []
        }
      })
    }
    for (const dir of dirs) if (dir && lstat(join(main, dir, 'package.json'))?.isFile()) found.add(dir)
  }
  return [...found].sort()
}

function workspacePatterns(pkg) {
  if (Array.isArray(pkg?.workspaces)) return pkg.workspaces
  if (Array.isArray(pkg?.workspaces?.packages)) return pkg.workspaces.packages
  return null
}

export function provisionTree({ worktree, main, unshared }) {
  const actions = []
  const notes = []
  const act = (op, path) => actions.push({ op, path: toPosix(relative(worktree, path)) })

  // Lexical, so a self-link whose target is not built yet in the main checkout still counts.
  const isSelfLink = (linkPath) => {
    const target = resolve(dirname(linkPath), readlinkSync(linkPath))
    const rel = relative(main, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
    return !rel.split(sep).includes('node_modules')
  }

  const holdsSelfLink = (dir) => {
    try {
      return sortedEntries(dir).some((entry) => entry.isSymbolicLink() && isSelfLink(join(dir, entry.name)))
    } catch {
      return false
    }
  }

  // Make `rel` (relative to the worktree) a real directory. Segments from `owned` on are the
  // plugin's own (a node_modules and what is under it): a link or a file there is removed.
  // Before `owned` they belong to the worktree's tree: a link or a file there is a refusal.
  const ensureRealDir = (rel, owned) => {
    const segments = rel.split('/')
    let path = worktree
    segments.forEach((segment, index) => {
      path = join(path, segment)
      const st = lstat(path)
      if (st?.isDirectory()) return
      if (st && index < owned) {
        throw new Refusal(`${toPosix(relative(worktree, path))} in the worktree is not a real directory; writing under it would write through it`)
      }
      if (st?.isSymbolicLink()) {
        unlinkSync(path)
        act('unlink', path)
      } else if (st) {
        rmSync(path, { force: true })
        act('remove', path)
      }
      mkdirSync(path)
      act('mkdir', path)
    })
  }

  const placeLink = (path, text) => {
    const st = lstat(path)
    if (st?.isSymbolicLink() && readlinkSync(path) === text) return
    if (st?.isSymbolicLink()) unlinkSync(path)
    else if (st) rmSync(path, { recursive: true, force: true })
    symlinkSync(text, path)
    act(st ? 'relink' : 'link', path)
  }

  const dropShared = (path) => {
    if (!lstat(path)?.isSymbolicLink()) return
    unlinkSync(path)
    act('unlink', path)
  }

  // Mirror the main checkout's directory `rel` into the worktree. The parent is real already.
  const mirror = (rel, owned, isBin = false) => {
    ensureRealDir(rel, owned)
    const from = join(main, rel)
    for (const entry of sortedEntries(from)) {
      const source = join(from, entry.name)
      const path = join(worktree, rel, entry.name)
      if (unshared.includes(entry.name)) {
        dropShared(path)
        continue
      }
      if (entry.isSymbolicLink()) {
        const text = readlinkSync(source)
        if (isSelfLink(source)) placeLink(path, isAbsolute(text) ? relative(dirname(source), resolve(text)) : text)
        else if (isBin && !isAbsolute(text)) placeLink(path, text)
        else placeLink(path, source)
      } else if (entry.isDirectory() && entry.name === '.bin') {
        mirror(`${rel}/${entry.name}`, owned, true)
      } else if (entry.isDirectory() && holdsSelfLink(source)) {
        mirror(`${rel}/${entry.name}`, owned)
      } else {
        placeLink(path, source)
      }
    }
  }

  mirror('node_modules', 0)

  const pkg = readJson(join(main, 'package.json'))
  for (const ws of expandWorkspaces(main, workspacePatterns(pkg) ?? [], notes)) {
    if (!lstat(join(main, ws, 'node_modules'))?.isDirectory()) continue
    if (!lstat(join(worktree, ws))) {
      notes.push(`workspace ${ws} is not in the worktree; its node_modules was not provisioned.`)
      continue
    }
    mirror(`${ws}/node_modules`, ws.split('/').length)
  }

  return { actions, notes }
}

function tail(text) {
  const lines = text.trimEnd().split('\n')
  return lines.slice(-TAIL_LINES).join('\n')
}

export const runShell = (command, cwd) => {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return { status: r.error ? null : r.status, output: r.error ? r.error.message : `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

export function provision(payload, { run = runShell } = {}) {
  const refuse = (error, extra = {}) => ({ code: 1, result: { state: 'refused', error, ...extra } })
  let options
  try {
    options = validate(payload)
  } catch (error) {
    if (error instanceof Refusal) return refuse(`${error.message}; nothing was provisioned.`)
    throw error
  }
  const { worktree, main, build, unshared } = options

  if (!lstat(worktree)?.isDirectory()) return refuse(`the worktree ${worktree} is not a directory; nothing was provisioned.`)
  if (realpath(worktree) === realpath(main)) {
    return refuse(`the worktree ${worktree} is the main checkout; nothing was provisioned.`)
  }

  const pkg = readJson(join(main, 'package.json'))
  let reason = null
  if (!pkg) reason = `${main}/package.json is missing or not valid JSON`
  else if (!workspacePatterns(pkg)) reason = `${main}/package.json has no workspaces`
  else if (!lstat(join(main, 'node_modules')) || !realpath(join(main, 'node_modules'))) reason = `${main}/node_modules does not exist`
  if (reason) {
    const notes = [`Nothing was provisioned: ${reason}.`]
    if (build.length > 0) notes.push('config.build did not run, since nothing was provisioned.')
    notes.push(INSTALL_RULE)
    return { code: 0, result: { state: 'done', actions: [], notes } }
  }

  let tree
  try {
    tree = provisionTree({ worktree, main, unshared })
  } catch (error) {
    if (error instanceof Refusal) return refuse(`${error.message}; node_modules is provisioned only in part.`)
    throw error
  }
  const { actions, notes: treeNotes } = tree

  const notes = [
    actions.length > 0
      ? `Provisioned node_modules from ${main}: ${actions.length} action(s).`
      : 'node_modules was provisioned already; nothing changed.',
    ...treeNotes
  ]
  for (const command of build) {
    const { status, output } = run(command, worktree)
    if (status !== 0) {
      return refuse(
        `config.build command ${JSON.stringify(command)} failed (exit ${status ?? 'none'}) in ${worktree}; node_modules was provisioned, and the commands after it did not run. Output tail:\n${tail(output)}`,
        { actions }
      )
    }
    notes.push(`Ran ${JSON.stringify(command)} in the worktree.`)
  }
  notes.push(INSTALL_RULE)
  return { code: 0, result: { state: 'done', actions, notes } }
}

export function runOperation(operation, payload, deps = {}) {
  if (operation !== 'provision') {
    return { code: 1, result: { state: 'refused', error: `unknown operation ${JSON.stringify(operation)}; the plugin provides provision; nothing was provisioned.` } }
  }
  return provision(payload, deps)
}
