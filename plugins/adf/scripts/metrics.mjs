#!/usr/bin/env node
// CLI over lib/metrics.mjs, the change's metrics record (format: contract/metrics-format.md), and
// lib/prices.mjs, the dated price table. Prints one JSON object on stdout; exit 1 on a refusal,
// exit 2 on a usage error. --root is the host project (default: the current directory): for
// extract, the change's checkout. Nothing is committed.
//
//   metrics.mjs extract --change <name> [--out <file>] [--projects <dir>]
//       build the record and write it, by default to the change's directory (active, else its
//       newest archived one) as metrics.json; --projects is the transcript directory (default
//       ~/.claude/projects). A record that fails its schema is refused and not written.
//       { ok, file, coverage: { <group>: "record" | <reason> }, warnings }
//   metrics.mjs render --file <record>
//       the record, of either schema version, as Markdown. { ok, markdown }
//   metrics.mjs candidates
//       the review layers and verify checks quiet for three archived changes in a row, over
//       every archived record (schemaVersion 1 converted). { ok, records, skipped, layers, checks }
//   metrics.mjs cost --file <record>
//       USD for the record's tokens at the price table under .adf/prices/.
//       { ok, usd, byModel, unpriced: [{ model, day, reason }], entries }
//   metrics.mjs prices fetch [--url <url>]
//       fetch the pricing page (default: the registry's metrics.pricesUrl, else the runtime's)
//       and add a price entry only when the prices changed. A failed fetch keeps the last entry
//       (`stale`); with no entry at all it is refused (`none`).
//       { ok, url, state, path?, from?, last?, reason? }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { changeDirOf } from './lib/changes.mjs'
import { isMain } from './lib/main.mjs'
import { buildRecord, candidates, cost, RECORD_FILE, renderRecord } from './lib/metrics.mjs'
import { pricesUrl, readTable, updateTable } from './lib/prices.mjs'

export const USAGE = `usage:
  metrics.mjs extract --change <name> [--out <file>] [--projects <dir>] [--root <dir>]
  metrics.mjs render --file <record>
  metrics.mjs candidates [--root <dir>]
  metrics.mjs cost --file <record> [--root <dir>]
  metrics.mjs prices fetch [--url <url>] [--root <dir>]`

export class UsageError extends Error {}

// The options each command takes, besides --root; the required ones first.
const TAKES = {
  extract: { required: ['change'], optional: ['out', 'projects'] },
  render: { required: ['file'], optional: [] },
  candidates: { required: [], optional: [] },
  cost: { required: ['file'], optional: [] },
  'prices fetch': { required: [], optional: ['url'] }
}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

function readJson(cwd, file) {
  let text
  try {
    text = readFileSync(resolve(cwd, file), 'utf8')
  } catch {
    throw new Error(`cannot read ${file}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`)
  }
}

const posix = (root, path) => relative(root, path).split(sep).join('/')

// `now` is a function that returns a Date, for every command; `fetch`, `projectsDir` and `home`
// go to lib/prices.mjs and lib/metrics.mjs as they are.
export async function run(argv, { cwd = process.cwd(), fetch, now, projectsDir, home } = {}) {
  const { values, rest } = parse(argv)
  const command = rest.join(' ')
  if (!Object.hasOwn(TAKES, command)) throw new UsageError(USAGE)
  const { required, optional } = TAKES[command]
  const stray = Object.keys(values).filter((k) => !['root', ...required, ...optional].includes(k))
  if (stray.length > 0) throw new UsageError(`--${stray.join(', --')} does not belong to ${command}`)
  const missing = required.filter((k) => values[k] === undefined)
  if (missing.length > 0) throw new UsageError(`${command} needs --${missing.join(', --')}`)
  const root = resolve(cwd, values.root ?? '.')
  switch (command) {
    case 'extract': {
      const dir = values.out ? null : changeDirOf(root, values.change)
      if (!values.out && !dir) return { ok: false, error: `no change "${values.change}" in openspec/changes or its archive; pass --out` }
      const file = values.out ? resolve(cwd, values.out) : join(dir, RECORD_FILE)
      let record
      try {
        record = buildRecord({ root, change: values.change, now: now?.(), home, ...(values.projects ? { projectsDir: resolve(cwd, values.projects) } : projectsDir ? { projectsDir } : {}) })
      } catch (error) {
        return { ok: false, error: error.message, ...(error.errors ? { errors: error.errors } : {}) }
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
      const coverage = Object.fromEntries(Object.entries(record.sources.coverage).map(([g, c]) => [g, c === 'record' ? c : c.none]))
      return { ok: true, file: posix(root, file), coverage, warnings: record.sources.warnings }
    }
    case 'render':
      return { ok: true, markdown: renderRecord(readJson(cwd, values.file)) }
    case 'candidates':
      return { ok: true, ...candidates(root) }
    case 'cost':
      return { ok: true, ...cost(readJson(cwd, values.file), readTable(root)) }
    case 'prices fetch': {
      const url = values.url ?? pricesUrl(root)
      const result = await updateTable(root, { url, fetch, now })
      return { ok: result.state !== 'none', url, ...result, ...(result.path ? { path: result.path.split(sep).join('/') } : {}) }
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
