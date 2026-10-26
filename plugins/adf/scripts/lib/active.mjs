// The active change: which change a command acts on when the developer names none. A local
// pointer, `.adf/active.json`, kept in the checkout itself, one entry per branch:
//
//   { "<branch>": { "change": "<name>", "at": "<ISO time>" } }
//
// In a change worktree the entry is the worktree branch's; in stay-on-branch mode the main
// checkout holds one entry per branch it had checked out. Never global: no checkout reads a
// pointer as its own unless it holds it, and `.adf/*` is ignored by init, so it is never
// committed. Propose writes it, any command given a change name sets it, and a command given
// none reads it instead of asking. A switch to another change is recorded in the ledger of the
// change switched to (`switch`, lib/ledger.mjs SCRIPTED); the old change stays as it is.
//
// The resolution (resolveActive), from the checkout the session runs in:
//   a name     the change of that name in flight, its pointer set; refused, with the list, when
//              no checkout holds it
//   no name    the pointer of this checkout's branch; else the one pointer of any checkout that
//              names a change in flight there; else the one change in flight; else ask
//   archived   (land) the change is archived and its worktree gone: archive's `remove` hands the
//              worktree's entry to the main checkout (handOver), and the one entry of any
//              checkout naming an archived change land has not finished is used; else ask
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { archivedDirs, changeDir, findChoices } from './changes.mjs'
import { mainCheckout } from './installed.mjs'
import { landFinished } from './land.mjs'
import { appendScripted } from './ledger.mjs'
import { checkouts, findChanges } from './resolve.mjs'

export const ACTIVE_FILE = '.adf/active.json'

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// The checkout a path lies in, and the key of its entry: its branch, or HEAD when detached.
export const checkoutOf = (cwd) => real(git(cwd, 'rev-parse', '--show-toplevel'))
export function branchKey(root) {
  try {
    return git(root, 'branch', '--show-current') || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

export function readPointers(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, ACTIVE_FILE), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writePointers(root, pointers) {
  const file = join(root, ACTIVE_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(pointers, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return file
}

// The entry of the checkout's branch, or null.
export const pointerOf = (root) => readPointers(root)[branchKey(root)] ?? null

// Points the checkout's branch at `change`. A pointer that named another change is a switch,
// recorded in the ledger of `change` in this checkout. Returns { file, key, previous, switched,
// record? }.
export function setPointer(root, change, { env = process.env, now = new Date().toISOString() } = {}) {
  const key = branchKey(root)
  const pointers = readPointers(root)
  const previous = pointers[key]?.change ?? null
  const file = writePointers(root, { ...pointers, [key]: { change, at: now } })
  if (previous === null || previous === change) return { file, key, previous, switched: false }
  const { record } = appendScripted(root, change, 'switch', { from: previous, to: change, pointer: `${ACTIVE_FILE}#${key}` }, { env, now })
  return { file, key, previous, switched: true, record }
}

// Archive's `remove`: the worktree's entry for `change` goes to the main checkout, under the same
// branch, before the worktree and its pointer go. Returns { handed, key }.
export function handOver(fromRoot, toRoot, change) {
  const key = branchKey(fromRoot)
  const entry = readPointers(fromRoot)[key]
  if (entry?.change !== change) return { handed: false, key }
  writePointers(toRoot, { ...readPointers(toRoot), [key]: entry })
  return { handed: true, key }
}

const ask = (reason, extra) => ({ ok: true, ask: true, change: null, reason, ...extra })

function resolveArchived(here, name) {
  const main = real(mainCheckout(here))
  const archived = (root, change) => archivedDirs(root, change).length > 0 && !existsSync(changeDir(root, change))
  if (name) {
    const holder = checkouts(here).find((c) => archived(c.root, name))
    if (!holder) return { ok: false, change: null, error: `no checkout holds an archived change "${name}"` }
    return { ok: true, ask: false, change: name, root: main, source: 'named' }
  }
  const named = new Set()
  for (const c of checkouts(here)) {
    for (const entry of Object.values(readPointers(c.root))) {
      if (entry?.change && archived(c.root, entry.change) && !landFinished(main, entry.change)) named.add(entry.change)
    }
  }
  if (named.size === 1) return { ok: true, ask: false, change: [...named][0], root: main, source: 'pointer' }
  return ask(named.size ? 'more than one pointer names an archived change land has not finished' : 'no pointer names an archived change land has not finished', { candidates: [...named].sort() })
}

// Which change a command acts on, from the checkout `cwd` lies in; see the header. Returns
// { ok, ask, change, root, branch, source: named | pointer | only, switched?, pointer? }, or
// { ok: true, ask: true, reason, choices, duplicates } for the developer to choose, or { ok:
// false, error, choices } for a name no checkout holds.
export function resolveActive(cwd, { name = null, schema, archived = false, env = process.env, now } = {}) {
  const here = checkoutOf(cwd)
  if (archived) return resolveArchived(here, name)
  const found = findChanges(here, schema)
  const { choices, duplicates } = findChoices(found)
  const inFlight = found.changes.map((c) => ({ ...c, root: real(c.root) }))
  const use = (entry, source, extra = {}) => ({ ok: true, ask: false, change: entry.name, root: entry.root, branch: entry.branch, source, ...extra })
  if (name) {
    const copies = inFlight.filter((c) => c.name === name)
    if (copies.length === 0) return { ok: false, change: null, error: `no change "${name}" is in flight in any checkout`, choices }
    const entry = copies.length === 1 ? copies[0] : (copies.find((c) => pointerOf(c.root)?.change === name) ?? copies.find((c) => c.root === here))
    if (!entry) return ask(`${name} is in more than one checkout; ask which root to use`, { choices: choices.filter((c) => c.name === name), duplicates })
    const set = setPointer(entry.root, name, { env, ...(now ? { now } : {}) })
    return use(entry, 'named', { switched: set.switched, pointer: { file: set.file, key: set.key }, ...(set.record ? { record: set.record.id } : {}) })
  }
  const pointed = (root) => {
    const pointer = pointerOf(root)
    return pointer ? inFlight.find((c) => c.root === root && c.name === pointer.change) : undefined
  }
  const own = pointed(here)
  if (own) return use(own, 'pointer')
  const others = [...new Set(checkouts(here).map((c) => real(c.root)))].map(pointed).filter(Boolean)
  if (others.length === 1) return use(others[0], 'pointer')
  if (others.length > 1) return ask('more than one checkout points at a change in flight', { choices, duplicates })
  if (inFlight.length === 1 && found.unresolved.length === 0) return use(inFlight[0], 'only')
  if (inFlight.length === 0 && found.unresolved.length === 0) return { ok: true, ask: false, change: null, report: 'no change is in flight' }
  return ask('no pointer, and more than one change is in flight', { choices, duplicates })
}
