// Every worktree the core makes is provisioned for the host's stack before anything runs in it,
// and torn down before the core removes it. The core knows no stack: it copies the untracked
// files the planning guide's `## Worktree copies` section names from the main checkout, then
// calls the `provision` hook, whose providers do the rest (contract/README.md). A removal calls
// the `teardown` hook first.
//
// The worktree's and the main checkout's `git status --porcelain` are compared before the hook
// and after it, and any difference refuses with the paths: a provider that changed a tracked
// path leaves a worktree `git worktree remove` refuses at archive, and one that wrote into the
// main checkout touched the developer's tree. The worktree's snapshot is taken after the copies,
// which are the guide's, not a provider's.
//
// A copy is made only where the worktree holds nothing, so a second run changes nothing, a copy
// a provider rewrote included, and only where git ignores it: a copy git sees would be an
// untracked file, which `git worktree remove` refuses. Nothing is written through a link: a link
// in a copy's place is unlinked first, and a copy under a linked directory is skipped. A skipped
// copy, a source missing from the main checkout among them, is named in a note.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { changeDir, META_FILE } from './changes.mjs'
import { mainCheckout } from './installed.mjs'
import { baseRef } from './plan-symbols.mjs'
import { callHook, CORE } from './roles.mjs'
import { claudeHome } from './superpowers.mjs'

export const KINDS = ['change', 'group', 'base-check', 'proof']
// The kinds a change's needs go to; a base-check or proof tree gets none.
export const NEEDS_KINDS = ['change', 'group']
export const COPIES_HEADING = '## Worktree copies'
const GUIDE = 'openspec/planning.md'

const defaultCore = () => ({ ...CORE, home: claudeHome() })

function attempt(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
const isLink = (path) => attempt(() => lstatSync(path).isSymbolicLink()) === true
const inside = (path) => typeof path === 'string' && path !== '' && !isAbsolute(path) && !normalize(path).startsWith('..')

// The paths of the `## Worktree copies` section: every backticked token, as `## Packages` is
// read; HTML comments ignored. [] when the section is absent.
export function copiesIn(text) {
  const m = /^##\s+Worktree copies\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(String(text ?? '').replace(/<!--[\s\S]*?-->/g, ''))
  if (!m) return []
  return [...new Set([...m[1].matchAll(/`([^`]+)`/g)].map((t) => t[1].trim().replace(/\/+$/, '')).filter(Boolean))]
}

export function readCopies(root) {
  const file = join(resolve(root), GUIDE)
  return existsSync(file) ? copiesIn(readFileSync(file, 'utf8')) : []
}

// The change's base as `{ ref, commit }`, read from its `.adf.json` in `root` and resolved as
// plan-symbols resolves it; both null when it cannot be read.
export function changeBase(root, change) {
  const meta = attempt(() => JSON.parse(readFileSync(join(changeDir(root, change), META_FILE), 'utf8')))
  const ref = attempt(() => baseRef(meta, (name) => attempt(() => git(root, 'rev-parse', '--verify', '--quiet', name)) !== null))
  const commit = ref ? attempt(() => git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) : null
  return { ref: ref ?? null, commit: commit || null }
}

// `git status --porcelain` as lines; a failed read refuses, since the comparison guards.
function status(dir) {
  const out = git(dir, 'status', '--porcelain')
  return out === '' ? [] : out.split('\n')
}

function differ(before, after) {
  const a = new Set(before)
  const b = new Set(after)
  return [...new Set([...before.filter((l) => !b.has(l)), ...after.filter((l) => !a.has(l))].map((l) => l.slice(3)))]
}

function copyOne(main, worktree, path) {
  if (!inside(path)) return { skipped: 'not a path inside the project' }
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (isLink(join(worktree, dir))) return { skipped: `${dir} is a link in the worktree; nothing is written through it` }
  }
  const from = join(main, path)
  const to = join(worktree, path)
  if (!existsSync(from)) return { skipped: 'not in the main checkout' }
  if (!isLink(to) && existsSync(to)) return { kept: true }
  // A directory pattern (`dir/`) matches only a path that reads as a directory.
  const probe = statSync(from).isDirectory() ? `${path}/` : path
  if (attempt(() => git(worktree, 'check-ignore', '-q', probe)) === null) {
    return { skipped: 'git does not ignore it in the worktree, so the copy would be an untracked file git worktree remove refuses' }
  }
  if (isLink(to)) unlinkSync(to)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, dereference: true })
  return { copied: true }
}

// The lines a command shows for one hook call: each provider's state, notes, hint or error, and
// the absent entries and the providers a refusal left uncalled.
export function hookLines(hook) {
  const lines = []
  for (const r of hook.results ?? []) {
    lines.push(`${r.plugin}: ${r.state}${r.state === 'degraded' && r.hint ? `; ${r.hint}` : ''}${r.state === 'refused' ? `; ${r.error ?? 'no reason given'}` : ''}`)
    for (const note of Array.isArray(r.notes) ? r.notes : []) lines.push(`  ${note}`)
  }
  for (const a of hook.absent ?? []) lines.push(`${a.id} is in the registry but ${a.reason === 'disabled' ? 'disabled' : 'not installed'}; its ${hook.point} was skipped`)
  if (hook.skipped?.length) lines.push(`not called after the refusal: ${hook.skipped.join(', ')}`)
  return lines
}

// Provisions `worktree`, made from the change in `root` (the change worktree, or the worktree a
// proof is made from: its registry and planning guide are read). `files` and `needs` come from
// the plan (lib/plan.mjs planInputs); `needs` is passed to a change or group worktree only.
// Returns { ok, state, worktree, kind, copies, hook, notes, report, error? }: `state` is the
// hook's, or `refused` when the comparison found a difference; `notes` holds the copies' notes.
export function provisionWorktree(root, { worktree, kind, change, files = [], needs = [] }, core = defaultCore()) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  if (!change) throw new Error('no change name')
  if (!worktree || !existsSync(worktree)) throw new Error(`the worktree ${worktree} does not exist`)
  const tree = realpathSync(worktree)
  const main = realpathSync(mainCheckout(tree))
  if (tree === main) throw new Error(`${tree} is the main checkout; only a worktree the core made is provisioned`)
  const branch = attempt(() => git(tree, 'branch', '--show-current')) || null
  const input = { worktree: tree, main, kind, change, branch, base: changeBase(root, change), files, needs: NEEDS_KINDS.includes(kind) ? needs : [] }

  const mainBefore = status(main)
  const copies = { copied: [], kept: [], skipped: [] }
  const notes = []
  for (const path of readCopies(root)) {
    const done = copyOne(main, tree, path)
    if (done.skipped) {
      copies.skipped.push({ path, reason: done.skipped })
      notes.push(`copy ${path} skipped: ${done.skipped}`)
      continue
    }
    copies[done.copied ? 'copied' : 'kept'].push(path)
  }
  const treeBefore = status(tree)

  const hook = callHook(root, 'provision', input, core)
  const changed = [...differ(treeBefore, status(tree)).map((p) => `${p} (worktree)`), ...differ(mainBefore, status(main)).map((p) => `${p} (main checkout)`)]
  const errors = []
  if (hook.state === 'refused') errors.push(`provision refused: ${hook.results.at(-1)?.error ?? 'no reason given'}`)
  if (changed.length) errors.push(`provision changed what git tracks or sees: ${changed.join(', ')}; a provider writes only ignored paths of the worktree, never the main checkout`)
  const state = errors.length ? 'refused' : hook.state
  const report = [
    `Provision (${kind}) ${tree}: ${state}`,
    ...(copies.copied.length ? [`copied: ${copies.copied.join(', ')}`] : []),
    ...(copies.kept.length ? [`kept: ${copies.kept.join(', ')}`] : []),
    ...notes,
    ...hookLines(hook),
    ...errors
  ].join('\n')
  return { ok: errors.length === 0, state, worktree: tree, kind, input, copies, hook, notes, report, ...(errors.length ? { error: errors.join('; ') } : {}) }
}

// Calls `teardown` for a worktree about to be removed, while it still exists. Returns { ok,
// state, hook, report, error? }: a refused teardown is `ok: false`, and its caller does not
// remove the worktree; a degraded one is `ok: true`, its hint in the report.
export function teardownWorktree(root, { worktree, kind, change, branch = null }, core = defaultCore()) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  const tree = existsSync(worktree) ? realpathSync(worktree) : resolve(worktree)
  const input = { worktree: tree, main: realpathSync(mainCheckout(root)), kind, change, branch }
  const hook = callHook(root, 'teardown', input, core)
  const report = [`Teardown (${kind}) ${tree}: ${hook.state}`, ...hookLines(hook)].join('\n')
  if (hook.state === 'refused') return { ok: false, state: 'refused', hook, report, error: `teardown refused, so ${tree} is not removed: ${hook.results.at(-1)?.error ?? 'no reason given'}` }
  return { ok: true, state: hook.state, hook, report }
}
