// The run log: one archive of a flow run, packed by a teammate who tested the flow on a real
// project, so the maintainer fixes the port from the evidence. Nothing in the project is changed
// except the archive itself.
//
// Archive `.adf/runlog/<to>-<runtime>.tar.gz` (system `tar`), top-level entries:
//   sessions/<file>            a runtime session file whose working directory is the project's
//                              main directory, one of its worktrees, or under them, dated in the
//                              window: Codex `rollout-*.jsonl` (matched by `session_meta`
//                              `payload.cwd`, dated by its `sessions/YYYY/MM/DD` directory), or
//                              Claude Code `<session>.jsonl` (matched by project key, dated by
//                              its modification time) with `<session>/subagents/` beside it
//   changes/<name>/sdd/...     the change's `.superpowers/sdd/<name>/` files (ledger, run.json,
//                              reply and record files)
//   changes/<name>/openspec/...  the change's `openspec/changes/<name>/` (or its archived copy)
//   registry.json              `.claude/adf-extensions.json`, when present
//   versions.json              { runtime, runtimeVersion, node, git, plugins: { id: version },
//                              window: { from, to }, skipped }; a value that cannot be read is
//                              null, with the reason in `skipped`
// A change is in the window when its ledger has a record dated (`at`) inside it, in the main
// directory or in a worktree. `skipped` is [{ what, reason }]: a broken session file, a session
// the ledger names whose transcript is not found, a value that cannot be read. Env files
// (`.env*` in any letter case), `auth.json`, `*.pem` and `*.key` are never packed. The window is
// inclusive, in UTC dates. Codex sessions are dated by the runtime's `YYYY/MM/DD` directory and
// Claude Code's by file modification time, so a session near a window edge may be off by a day.
// `<cli> --version` is given 10 seconds; a timeout is named in `skipped`.
import { execFileSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCHIVE, CHANGES_DIR } from './changes.mjs'
import { mainCheckout, selectInstall } from './installed.mjs'
import { readLedger } from './ledger.mjs'
import { REGISTRY_PATH, readRegistry } from './registry.mjs'
import { cli, detectRuntime, runtimeHome } from './runtime.mjs'
import { encodeKeys, WORKTREE_KEY } from './transcripts.mjs'
import { gitIn, worktrees } from './workspace.mjs'

export const WARNING = 'The archive holds whole session transcripts: everything said in them, commands and their output included. Read it before you send it.'
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY = 86400000
const SELF = fileURLToPath(import.meta.url)
const HEAD_BYTES = 256 * 1024
const VERSION_TIMEOUT_MS = 10000
const SECRET = (name) => name === 'auth.json' || name.toLowerCase().startsWith('.env') || /\.(pem|key)$/i.test(name)

// The first line of a file, read from its first HEAD_BYTES only; null when there is no newline there.
function firstLine(path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const end = buffer.subarray(0, n).indexOf(10)
    return end < 0 ? null : buffer.subarray(0, end).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const inWindow = (d, window) => d >= window.from && d <= window.to

export function resolveWindow({ from, to }, now = Date.now()) {
  const end = to ?? day(now)
  const start = from ?? day(Date.parse(end) - 7 * DAY)
  for (const d of [start, end]) if (!DATE.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`"${d}" is not a date, use YYYY-MM-DD`)
  if (start > end) throw new Error(`--from ${start} is after --to ${end}`)
  return { from: start, to: end }
}

const realOrSelf = (path) => (existsSync(path) ? realpathSync(path) : resolve(path))

// Copy a directory, leaving out secrets and anything that is not a plain file or directory.
function copyTree(from, to) {
  cpSync(from, to, { recursive: true, force: true, filter: (src) => !SECRET(basename(src)) })
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// The directories a session may have run in: the main directory and every worktree of it.
function projectRoots(main, skipped) {
  const paths = [main]
  try {
    for (const w of worktrees(gitIn(main))) paths.push(w.path)
  } catch (error) {
    skipped.push({ what: 'worktrees', reason: `git worktree list failed: ${error.message.split('\n')[0]}` })
  }
  return [...new Set(paths)]
}

function changesIn(roots, window, skipped) {
  const found = new Map()
  for (const root of roots) {
    const base = join(root, '.superpowers', 'sdd')
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const ledger = join(base, name, 'ledger.jsonl')
      if (!existsSync(ledger)) continue
      let records
      try {
        records = readLedger(readFileSync(ledger, 'utf8'))
      } catch {
        skipped.push({ what: ledger, reason: 'the ledger does not parse; its change is not packed' })
        continue
      }
      if (!records.some((r) => typeof r.at === 'string' && inWindow(r.at.slice(0, 10), window))) continue
      found.set(name, [...(found.get(name) ?? []), { root, records }])
    }
  }
  return found
}

function packChange(stage, name, places) {
  for (const { root } of places) {
    const sdd = join(root, '.superpowers', 'sdd', name)
    if (existsSync(sdd)) copyTree(sdd, join(stage, 'changes', name, 'sdd'))
    const live = join(root, CHANGES_DIR, name)
    const archive = join(root, CHANGES_DIR, ARCHIVE)
    const archived = existsSync(archive) ? readdirSync(archive).filter((d) => /^\d{4}-\d{2}-\d{2}-/.test(d) && d.slice(11) === name) : []
    for (const dir of [live, ...archived.map((d) => join(archive, d))]) {
      if (existsSync(dir)) copyTree(dir, join(stage, 'changes', name, 'openspec'))
    }
  }
}

const under = (path, roots) => roots.some((r) => path === r || path.startsWith(r + sep))

function codexSessions(home, roots, window, skipped) {
  const out = []
  const base = join(home, 'sessions')
  const names = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])
  const real = roots.map(realOrSelf)
  for (const y of names(base)) {
    for (const m of names(join(base, y))) {
      for (const d of names(join(base, y, m))) {
        if (!inWindow(`${y}-${m}-${d}`, window)) continue
        for (const file of names(join(base, y, m, d)).filter((f) => f.endsWith('.jsonl'))) {
          const path = join(base, y, m, d, file)
          let meta
          try {
            const line = firstLine(path)
            if (line === null) throw new Error('no first line in the head')
            meta = JSON.parse(line)
          } catch {
            skipped.push({ what: path, reason: 'broken session file: the first line is missing, too long or not JSON' })
            continue
          }
          const cwd = meta?.type === 'session_meta' ? meta.payload?.cwd : null
          if (typeof cwd !== 'string') {
            skipped.push({ what: path, reason: 'broken session file: no session_meta with a cwd' })
            continue
          }
          if (under(realOrSelf(cwd), real)) out.push({ path, name: file })
        }
      }
    }
  }
  return out
}

function claudeSessions(home, roots, window, skipped) {
  const out = []
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return out
  const keys = new Set(roots.flatMap((r) => [...encodeKeys(r), ...encodeKeys(realOrSelf(r))]))
  const mine = (entry) => [...keys].some((k) => entry === k || entry.startsWith(k + WORKTREE_KEY))
  for (const entry of readdirSync(projects).filter(mine)) {
    const dir = join(projects, entry)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const path = join(dir, file)
      try {
        if (!inWindow(day(statSync(path).mtimeMs), window)) continue
      } catch (error) {
        skipped.push({ what: path, reason: `cannot read: ${error.message}` })
        continue
      }
      const subagents = join(dir, basename(file, '.jsonl'), 'subagents')
      out.push({ path, name: file, subagents: existsSync(subagents) ? subagents : null })
    }
  }
  return out
}

function run(file, args, timeout) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim()
}

function versions({ runtime, main, home, window, skipped }) {
  const attempt = (what, fn) => {
    try {
      return fn()
    } catch (error) {
      skipped.push({ what, reason: String(error.message).split('\n')[0] })
      return null
    }
  }
  const plugins = {}
  const core = readJsonFile(join(dirname(SELF), '..', '..', '.claude-plugin', 'plugin.json'))
  if (core?.name) plugins[core.name] = core.version ?? null
  let registry = null
  try {
    registry = readRegistry(main)
  } catch {
    // No registry: no extension plugins to name; the registry's own absence is reported by the caller.
  }
  for (const entry of registry?.extensions ?? []) {
    if (typeof entry.plugin === 'string') plugins[entry.plugin] = attempt(`plugin ${entry.plugin}`, () => selectInstall(entry.plugin, main, { runtime, home }).version)
  }
  return {
    runtime,
    runtimeVersion: attempt(`${cli(runtime)} --version`, () => run(cli(runtime), ['--version'], VERSION_TIMEOUT_MS)),
    node: process.version,
    git: attempt('git --version', () => run('git', ['--version'])),
    plugins,
    window,
    skipped
  }
}

export function collect(root, { from, to, env = process.env, now = Date.now() } = {}) {
  const window = resolveWindow({ from, to }, now)
  const main = mainCheckout(root)
  const runtime = detectRuntime({ env, scriptPath: SELF })
  const home = runtimeHome(runtime, env)
  const skipped = []
  const roots = projectRoots(main, skipped)
  const stage = mkdtempSync(join(tmpdir(), 'adf-runlog-'))
  try {
    mkdirSync(join(stage, 'sessions'))
    mkdirSync(join(stage, 'changes'))
    const sessions = runtime === 'codex' ? codexSessions(home, roots, window, skipped) : claudeSessions(home, roots, window, skipped)
    for (const s of sessions) {
      try {
        cpSync(s.path, join(stage, 'sessions', s.name))
        if (s.subagents) copyTree(s.subagents, join(stage, 'sessions', basename(s.name, '.jsonl'), 'subagents'))
      } catch (error) {
        skipped.push({ what: s.path, reason: `cannot copy: ${error.message}` })
      }
    }
    const changes = changesIn(roots, window, skipped)
    for (const [name, places] of changes) packChange(stage, name, places)
    // A session the ledger names, with no file packed: gone, or outside the window.
    const packed = sessions.map((s) => s.name)
    for (const [name, places] of changes) {
      const ids = new Set(places.flatMap((p) => p.records).filter((r) => r.kind === 'session' && r.sessionId).map((r) => r.sessionId))
      for (const id of ids) if (!packed.some((n) => n.includes(id))) skipped.push({ what: `session ${id}`, reason: `named by the ledger of ${name}; no transcript found in the window` })
    }
    const registryFile = join(main, REGISTRY_PATH)
    if (existsSync(registryFile)) cpSync(registryFile, join(stage, 'registry.json'))
    else {
      writeFileSync(join(stage, 'registry.json'), 'null\n')
      skipped.push({ what: REGISTRY_PATH, reason: 'no registry in the project' })
    }
    writeFileSync(join(stage, 'versions.json'), `${JSON.stringify(versions({ runtime, main, home, window, skipped }), null, 2)}\n`)
    const dir = join(main, '.adf', 'runlog')
    mkdirSync(dir, { recursive: true })
    const archive = join(dir, `${window.to}-${runtime}.tar.gz`)
    execFileSync('tar', ['-czf', archive, '-C', stage, 'sessions', 'changes', 'registry.json', 'versions.json'])
    return { ok: true, archive, bytes: statSync(archive).size, sessions: sessions.length, changes: [...changes.keys()].sort(), skipped, warning: WARNING }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
