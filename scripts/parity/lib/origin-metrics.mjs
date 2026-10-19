// Shared by the metrics parity tools (origin-metrics-records.mjs, origin-metrics-transcripts.mjs,
// origin-metrics-findings.mjs, origin-window.mjs): read-only git on the origin, and a temporary
// copy of the origin's metrics scripts and their imports, taken with `git show HEAD:` into a
// directory under the system temp directory (prefix `adf-parity-metrics-`). Nothing is written
// in the origin; the caller removes the copy with `remove()`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ARCHIVE = 'openspec/changes/archive'
// The origin's metrics scripts and every script they import, relative to `.claude/scripts/`.
export const ORIGIN_SCRIPTS = [
  'adf-metrics.mjs',
  'adf-metrics-facts.mjs',
  'adf-metrics-findings.mjs',
  'adf-metrics-window.mjs',
  'ledger.mjs',
  'check-plan-symbols.mjs',
  'check-reply.mjs',
  'adf-regression/normative-duplication.mjs'
]

export function originArg(name) {
  const origin = process.argv[2]
  if (!origin || !existsSync(join(origin, '.git'))) {
    console.error(`usage: ${name} <origin project root, a git checkout>`)
    process.exit(2)
  }
  return realpathSync(origin)
}

// `git -C <origin> ...` returning stdout; `orNull` returns null on a failure instead of throwing.
export function gitOn(origin) {
  const git = (...args) => execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  git.orNull = (...args) => {
    try {
      return git(...args)
    } catch {
      return null
    }
  }
  return git
}

// The copy of the origin's scripts: `{ dir, path(name), load(name), remove() }`.
export function copyOriginScripts(origin) {
  const git = gitOn(origin)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-parity-metrics-')))
  try {
    for (const name of ORIGIN_SCRIPTS) {
      const target = join(dir, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, git('show', `HEAD:.claude/scripts/${name}`))
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return {
    dir,
    path: (name) => join(dir, name),
    load: (name) => import(pathToFileURL(join(dir, name)).href),
    remove: () => rmSync(dir, { recursive: true, force: true })
  }
}

// The archive directories of `ref` holding a metrics.json, sorted, and each record's text.
export function archivedRecordTexts(git, ref = 'HEAD') {
  return git('ls-tree', '-r', '--name-only', ref, `${ARCHIVE}/`)
    .split('\n')
    .filter((p) => /^openspec\/changes\/archive\/[^/]+\/metrics\.json$/.test(p))
    .sort()
    .map((path) => ({ dir: path.split('/')[3], text: git('show', `${ref}:${path}`) }))
}

// The origin's async `read`, `list` and `git` its extractor takes, rooted at the origin.
export function originIo(origin) {
  const run = gitOn(origin)
  return {
    git: async (args) => run(...args),
    read: async (p) => readFileSync(p, 'utf8'),
    list: async (d) => readdirSync(d)
  }
}

export const count = (map, key, n = 1) => (map[key] = (map[key] ?? 0) + n)
