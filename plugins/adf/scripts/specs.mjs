#!/usr/bin/env node
// CLI over lib/specs.mjs. Prints one JSON object on stdout with the fields of
// `openspec validate --all --json` (items, summary, version, root) and exits 1 when any item
// is invalid or the command is refused.
//
//   specs.mjs validate [--all]              every active change and every main spec
//   specs.mjs validate --change <name>      one active change's delta specs
//   specs.mjs validate --spec <capability>  one main spec
//   specs.mjs validate --change <name> --against-main
//       also each delta against its main spec, as archive will apply it, under `againstMain`
//       ({ ok, capabilities: [{ capability, mainSpec, findings }] }): a MODIFIED, REMOVED or
//       RENAMED-from header the main spec lacks, an ADDED or RENAMED-to name it already holds,
//       a REMOVED without Reason, Migration or Code Disposition, a RENAMED without Code
//       Disposition. Exit 1 on any finding as well.
//   specs.mjs capabilities [--change <name>]
//       the proposal's Capabilities section against the change's spec folders and the main
//       specs: { ok, new, modified, missingSpec, unlistedSpec, modifiedNotFound, newCollides,
//       badName, listedTwice }. Exit 1 when not ok.
//
// Without --change, capabilities and --against-main act on the one active change under the root.
//
// --strict also fails an item on a WARNING, as the CLI's --strict does. --root <dir> names the
// project holding openspec/ (default: the current directory).
import { resolve } from 'node:path'
import { changeAgainstMain, checkCapabilities, validateProject } from './lib/specs.mjs'
import { inferChange } from './lib/changes.mjs'
import { loadSchema } from './lib/schema.mjs'
import { isMain } from './lib/main.mjs'

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
  let change = option(args, '--change')
  const spec = option(args, '--spec')
  const strict = flag(args, '--strict')
  const all = flag(args, '--all')
  const againstMain = flag(args, '--against-main')
  const [command, ...rest] = args
  const root = resolve(rootOption ?? process.cwd())
  if (command === 'capabilities' && rest.length === 0 && !spec && !all && !strict && !againstMain) {
    change = inferChange(root, change, loadSchema())
    return { change, ...checkCapabilities(root, change) }
  }
  if (command !== 'validate' || rest.length > 0 || [all, change, spec].filter((x) => x).length > 1 || (againstMain && (all || spec))) {
    throw new Error('usage: specs.mjs validate [--all | --change <name> [--against-main] | --spec <capability>] [--strict] [--root <dir>] | specs.mjs capabilities [--change <name>] [--root <dir>]')
  }
  if (againstMain) change = inferChange(root, change, loadSchema())
  const result = validateProject(root, { change, spec, strict })
  return {
    ...result,
    ...(againstMain ? { againstMain: changeAgainstMain(root, change) } : {}),
    root: { path: root, source: rootOption ? 'option' : 'cwd' }
  }
}

export const failed = (result) =>
  result.ok === false || (result.summary?.totals.failed ?? 0) > 0 || result.againstMain?.ok === false

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = failed(result) ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
