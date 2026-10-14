#!/usr/bin/env node
// CLI over lib/registry.mjs. Every subcommand prints one JSON object on stdout and exits 1
// on a refusal, so a command file reads the result instead of parsing prose.
//
//   extensions.mjs init                      create the registry if missing; declare ADF
//                                            in the host's .claude/settings.json; ignore
//                                            the flow's local state; add the planning guide
//   extensions.mjs branches --integration B [--protected B1,B2]
//                                            set the branch policy in the registry
//   extensions.mjs add <id|path> [--config J]
//                                            enable a plugin, installed (name@marketplace)
//                                            or at a path; copy the host files it declares
//   extensions.mjs remove <name>             disable a plugin
//   extensions.mjs check                     validate the registry and every plugin
//
// --root <dir> names the host project (default: the current directory); --home <dir> the
// Claude Code home (default: $CLAUDE_CONFIG_DIR, else ~/.claude).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declareInHost, marketplaceSource } from './lib/host-settings.mjs'
import { detectIntegration, readBranches, setBranches } from './lib/branches.mjs'
import { createPlanningGuide, ignoreLocalDirs } from './lib/host-files.mjs'
import { addExtension, checkRegistry, initRegistry, removeExtension } from './lib/registry.mjs'
import { claudeHome } from './lib/superpowers.mjs'

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
  const home = option(args, '--home') ?? claudeHome()
  const integration = option(args, '--integration')
  const protectedList = option(args, '--protected')
  const [command, target] = args
  switch (command) {
    case 'init':
      return {
        ...initRegistry(root, contract.version),
        contract: contract.version,
        settings: declareInHost(root, { source: marketplaceSource(home) }),
        gitignore: ignoreLocalDirs(root),
        planningGuide: createPlanningGuide(root),
        branches: readBranches(root),
        detectedIntegration: detectIntegration(root)
      }
    case 'branches':
      if (!integration) throw new Error('usage: branches --integration <branch> [--protected <b1,b2>]')
      return setBranches(root, { integration, protected: protectedList ? protectedList.split(',').map((b) => b.trim()) : [] })
    case 'add':
      if (!target) throw new Error('usage: add <plugin id or path> [--config <json>]')
      return addExtension(root, target, { ...core, home, config: config && JSON.parse(config) })
    case 'remove':
      if (!target) throw new Error('usage: remove <plugin name>')
      return removeExtension(root, target, { home })
    case 'check':
      return checkRegistry(root, { ...core, home })
    default:
      throw new Error('usage: extensions.mjs init|branches|add|remove|check [--root <dir>]')
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
