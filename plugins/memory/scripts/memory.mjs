#!/usr/bin/env node
// CLI over lib/memory.mjs: the `knowledge` role of the ADF contract on a wiki memory.
//
// As the role (the core's call): the operation, and one JSON object on stdin,
// { root, config, input }:
//   memory.mjs context|log|check
// By hand, with flags (the knowledge base is <root>/.claude/memory; root defaults to the
// current directory):
//   memory.mjs context [--root <dir>]
//   memory.mjs check [--exclude <glob> ...] [--root <dir>]
//   memory.mjs sort [--root <dir>]
//   memory.mjs log --type ingest|query|lint|task --title <t> --bullet <b> [--bullet <b> ...]
//                  [--amend] [--root <dir>]
//   memory.mjs log --type task --title <t> --commit <sha>[,<sha>] --reason <r> [--amend] [--root <dir>]
//
// `log` reads the time from the clock, in UTC, and the author from `git config user.name`;
// it rotates the log first, then inserts the entry at its timestamp's place. `--amend`
// replaces the uncommitted entry with the same title, and is refused when there is none.
//
// `check` leaves out the pages the `exclude` globs match, relative to the knowledge base
// (`reports/**`): from the core, the plugin's `config.exclude` in the registry; by hand,
// `--exclude`. `sort` is not a role operation: it puts the log's entries back in timestamp
// order, newest first, after a merge broke it, and reports `moved`; a sorted log is untouched.
//
// Prints one JSON object: `state` done or refused. Exit 0 done, 1 refused, 2 usage error.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { check, context, log, sort } from './lib/memory.mjs'
import { isMain } from './lib/main.mjs'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
export const USAGE = [
  'usage:',
  '  memory.mjs context|log|check|sort             (payload { root, config, input } on stdin)',
  '  memory.mjs context|sort [--root <dir>]',
  '  memory.mjs check [--exclude <glob> ...] [--root <dir>]',
  '  memory.mjs log --type <ingest|query|lint|task> --title <t> (--bullet <b> ... | --commit <sha> --reason <r>) [--amend] [--root <dir>]'
].join('\n')

const OPTIONS = {
  root: { type: 'string' },
  type: { type: 'string' },
  title: { type: 'string' },
  bullet: { type: 'string', multiple: true },
  commit: { type: 'string' },
  reason: { type: 'string' },
  amend: { type: 'boolean' },
  exclude: { type: 'string', multiple: true }
}

const usage = (error) => ({ code: 2, result: { state: 'refused', error, usage: USAGE } })

// The input of an operation from flags: only what was given, so `log` sees what is missing.
function fromFlags(operation, args) {
  const { values, positionals } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: true })
  if (positionals.length) throw new Error(`unexpected argument ${positionals[0]}`)
  const root = resolve(values.root ?? process.cwd())
  if (operation === 'check') {
    const extra = Object.keys(values).filter((k) => k !== 'root' && k !== 'exclude')
    if (extra.length) throw new Error('check takes only --exclude and --root')
    return { root, input: {}, config: values.exclude ? { exclude: values.exclude } : {} }
  }
  if (operation !== 'log') {
    const extra = Object.keys(values).filter((k) => k !== 'root')
    if (extra.length) throw new Error(`${operation} takes only --root`)
    return { root, input: {}, config: {} }
  }
  const input = {}
  for (const key of ['type', 'title', 'commit', 'reason']) if (values[key] !== undefined) input[key] = values[key]
  if (values.bullet) input.bullets = values.bullet
  if (values.amend) input.amend = true
  return { root, input, config: {} }
}

const gitIn = (root) => (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' }
}

export function main(argv, readStdin, { now = new Date() } = {}) {
  const [operation, ...rest] = argv
  if (!['context', 'log', 'check', 'sort'].includes(operation)) return usage(`unknown operation ${operation ?? '(none)'}`)
  let root
  let input
  let config
  if (rest.length > 0) {
    try {
      ;({ root, input, config } = fromFlags(operation, rest))
    } catch (error) {
      return usage(error.message)
    }
  } else {
    const text = readStdin()
    let payload = {}
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        return usage('the payload on stdin is not valid JSON')
      }
    }
    root = resolve(payload.root ?? process.cwd())
    input = payload.input ?? {}
    config = payload.config ?? {}
  }
  let result
  if (operation === 'context') result = context(root, pluginDir)
  else if (operation === 'check') result = check(root, { exclude: config.exclude ?? [] })
  else if (operation === 'sort') result = sort(root)
  else result = log(root, input, { now, git: gitIn(root), template: readFileSync(join(pluginDir, 'host', 'log.md'), 'utf8') })
  return { code: result.state === 'done' ? 0 : 1, result }
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => (process.stdin.isTTY ? '' : readFileSync(0, 'utf8')))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: error.message } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`)
  process.exitCode = outcome.code
}
