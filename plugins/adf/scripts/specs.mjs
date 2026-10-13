#!/usr/bin/env node
// CLI over lib/specs.mjs. Prints one JSON object on stdout with the fields of
// `openspec validate --all --json` (items, summary, version, root) and exits 1 when any item
// is invalid or the command is refused.
//
//   specs.mjs validate [--all]              every active change and every main spec
//   specs.mjs validate --change <name>      one active change's delta specs
//   specs.mjs validate --spec <capability>  one main spec
//
// --strict also fails an item on a WARNING, as the CLI's --strict does. --root <dir> names the
// project holding openspec/ (default: the current directory).
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProject } from './lib/specs.mjs'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  if (value === undefined) throw new Error(`${name} needs a value`)
  return value
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

export function run(argv) {
  const args = [...argv]
  const rootOption = option(args, '--root')
  const change = option(args, '--change')
  const spec = option(args, '--spec')
  const strict = flag(args, '--strict')
  const all = flag(args, '--all')
  const [command, ...rest] = args
  if (command !== 'validate' || rest.length > 0 || [all, change, spec].filter((x) => x).length > 1) {
    throw new Error('usage: specs.mjs validate [--all | --change <name> | --spec <capability>] [--strict] [--root <dir>]')
  }
  const root = resolve(rootOption ?? process.cwd())
  const result = validateProject(root, { change, spec, strict })
  return { ...result, root: { path: root, source: rootOption ? 'option' : 'cwd' } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.summary.totals.failed > 0 ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
