#!/usr/bin/env node
// Stage 2 of keeping the user guide current. A script builds review packages from a release
// diff; the maintainer's session dispatches one read-only agent per package; the script checks
// each JSON reply.
//
//   guide-review.mjs input --from <tag> --out <dir> [--root <dir>]
//       writes <dir>/<section>.json for each section with a page to review; prints
//       { packages: [{ section, file, pages }] }; exit 1 for an unknown tag.
//       Run on a committed tree: input reads pages from the working tree, the diff and file list from commits.
//   guide-review.mjs check --package <file> --reply <file> [--root <dir>]
//       prints { ok, errors, findings }; exit 1 when the reply is invalid.
//
// A script prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage error.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/main.mjs'
import { matchGlob, readPages } from './lib/guide.mjs'
import { parseReply, readSchema, validateJson } from '../plugins/adf/scripts/lib/json-schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRoot = join(here, '..')
const PROMPT = 'scripts/guide-review/prompt.md'
const GUIDE = 'docs/guide/'

export const USAGE = `usage:
  guide-review.mjs input --from <tag> --out <dir> [--root <dir>]
  guide-review.mjs check --package <file> --reply <file> [--root <dir>]`

export class UsageError extends Error {}

// A page whose `sources:` match a changed file, or whose own path is changed.
export function selectPages({ pages, changed }) {
  return pages.filter((p) => changed.includes(p.path) || p.sources.some((g) => changed.some((f) => matchGlob(g, f))))
}

// The section of a page: its first path segment under docs/guide/; a top-level page goes with getting-started.
export function sectionOf(path) {
  const parts = path.slice(GUIDE.length).split('/')
  return parts.length > 1 ? parts[0] : 'getting-started'
}

// `files` (the repository's files) resolves each glob; without it a page keeps its globs.
export function buildPackages({ pages, changed, from, files, prompt }) {
  const bySection = new Map()
  for (const page of selectPages({ pages, changed })) {
    const sources = files ? files.filter((f) => page.sources.some((g) => matchGlob(g, f))) : page.sources
    const touched = changed.filter((f) => f === page.path || page.sources.some((g) => matchGlob(g, f)))
    const section = sectionOf(page.path)
    if (!bySection.has(section)) bySection.set(section, [])
    bySection.get(section).push({ path: page.path, sources, touched })
  }
  return [...bySection].sort(([a], [b]) => a.localeCompare(b)).map(([section, list]) => ({ section, from, ...(prompt ? { prompt } : {}), pages: list }))
}

export function checkReply({ reply, pkg, exists, lineCount, schema = readSchema(join(here, 'guide-review', 'reply.schema.json')) }) {
  const errors = validateJson(schema, reply)
  if (errors.length === 0) {
    reply.findings.forEach((f, i) => {
      const at = `$.findings[${i}]`
      const page = pkg.pages.find((p) => p.path === f.page)
      if (!page) return errors.push(`${at}: page ${f.page} is not in the package`)
      if (!page.sources.some((s) => s === f.source.path || matchGlob(s, f.source.path))) {
        return errors.push(`${at}: source ${f.source.path} is not a source of ${f.page}`)
      }
      if (!exists(f.source.path)) return errors.push(`${at}: source ${f.source.path} does not exist`)
      const lines = lineCount(f.source.path)
      if (f.source.line > lines) errors.push(`${at}: line ${f.source.line} is past the end of ${f.source.path} (${lines} lines)`)
    })
  }
  return { ok: errors.length === 0, errors, findings: errors.length === 0 ? reply.findings : [] }
}

function parseArgs(argv, valued) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (!valued.includes(argv[i]) || argv[i + 1] === undefined) throw new UsageError(`${USAGE}`)
    opts[argv[i].slice(2)] = argv[++i]
  }
  return opts
}

const gitIn = (root) => (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

export function run(argv, { root = defaultRoot, git = gitIn(root), readPages: pagesOf = () => readPages(root) } = {}) {
  const [command, ...rest] = argv
  if (command === 'input') {
    const opts = parseArgs(rest, ['--from', '--out', '--root'])
    if (!opts.from || !opts.out) throw new UsageError(USAGE)
    root = opts.root ?? root
    if (opts.root) git = gitIn(root)
    try {
      git(['rev-parse', '--verify', '--quiet', `${opts.from}^{commit}`])
    } catch {
      return { ok: false, error: `unknown tag ${opts.from}` }
    }
    const lines = (text) => text.split('\n').filter(Boolean)
    const changed = lines(git(['diff', '--name-only', `${opts.from}...HEAD`]))
    const files = lines(git(['ls-files']))
    const pages = opts.root ? readPages(root) : pagesOf()
    const packages = buildPackages({ pages, changed, from: opts.from, files, prompt: PROMPT })
    mkdirSync(opts.out, { recursive: true })
    const summary = packages.map((pkg) => {
      const file = join(opts.out, `${pkg.section}.json`)
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
      return { section: pkg.section, file, pages: pkg.pages.length }
    })
    return { packages: summary }
  }
  if (command === 'check') {
    const opts = parseArgs(rest, ['--package', '--reply', '--root'])
    if (!opts.package || !opts.reply) throw new UsageError(USAGE)
    root = opts.root ?? root
    const pkg = JSON.parse(readFileSync(opts.package, 'utf8'))
    const parsed = parseReply(readFileSync(opts.reply, 'utf8'))
    if (parsed.errors.length) return { ok: false, errors: parsed.errors, findings: [] }
    const abs = (path) => join(root, path)
    return checkReply({
      reply: parsed.reply,
      pkg,
      exists: (path) => existsSync(abs(path)),
      lineCount: (path) => readFileSync(abs(path), 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length,
    })
  }
  throw new UsageError(USAGE)
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
