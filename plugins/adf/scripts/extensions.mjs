#!/usr/bin/env node
// CLI over lib/registry.mjs. Every subcommand prints one JSON object on stdout and exits 1
// on a refusal, so a command file reads the result instead of parsing prose.
//
//   extensions.mjs init                      create the registry if missing
//   extensions.mjs add <path> [--config J]   enable a plugin
//   extensions.mjs remove <name>             disable a plugin
//   extensions.mjs check                     validate the registry and every plugin
//
// --root <dir> names the host project (default: the current directory).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addExtension, checkRegistry, initRegistry, removeExtension } from './lib/registry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(readFileSync(join(here, '..', 'contract', 'contract.json'), 'utf8'))
const core = { coreContract: contract.version, points: contract.points }

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const config = option(args, '--config')
  const [command, target] = args
  switch (command) {
    case 'init':
      return { ...initRegistry(root, contract.version), contract: contract.version }
    case 'add':
      if (!target) throw new Error('usage: add <plugin path> [--config <json>]')
      return addExtension(root, target, { ...core, config: config && JSON.parse(config) })
    case 'remove':
      if (!target) throw new Error('usage: remove <plugin name>')
      return removeExtension(root, target)
    case 'check':
      return checkRegistry(root, core)
    default:
      throw new Error('usage: extensions.mjs init|add|remove|check [--root <dir>]')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
