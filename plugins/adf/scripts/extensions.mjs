#!/usr/bin/env node
// CLI over lib/registry.mjs. Every subcommand prints one JSON object on stdout and exits 1
// on a refusal, so a command file reads the result instead of parsing prose.
//
//   extensions.mjs init                      create the registry if missing; declare ADF
//                                            in the host's .claude/settings.json; ignore
//                                            the flow's local state; add the planning guide
//                                            and the review prompt (review.prompt);
//                                            then the Superpowers gate (`superpowers`) and
//                                            the registry check (`check`)
//   extensions.mjs branches --integration B [--protected B1,B2]
//                                            set the branch policy in the registry
//   extensions.mjs add <id|path> [--config J]
//                                            enable a plugin, installed (name@marketplace)
//                                            or at a path; copy the host files it declares
//   extensions.mjs remove <name>             disable a plugin
//   extensions.mjs check                     validate the registry and every plugin
//
// init, branches, add and remove also run `check` and return it with `report`, the rendered
// text the command shows. add and remove change the registry before the check, so a failing
// check after them is reported, not refused. When that check passes and a plugin provides the
// tracker, init and add also run the tracker's `check` and return it as `tracker`, its notes
// in `report`; a degraded or refused tracker is reported, never a failure.
//
// --root <dir> names the host project (default: the current directory); --home <dir> the
// Claude Code home (default: $CLAUDE_CONFIG_DIR, else ~/.claude).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declareInHost, marketplaceSource } from './lib/host-settings.mjs'
import { detectIntegration, readBranches, setBranches } from './lib/branches.mjs'
import { createPlanningGuide, createReviewPrompt, ignoreLocalDirs } from './lib/host-files.mjs'
import { addExtension, addReport, branchesReport, checkRegistry, initRegistry, initReport, removeExtension, removeReport } from './lib/registry.mjs'
import { checkSuperpowers, claudeHome } from './lib/superpowers.mjs'
import { trackerCall } from './lib/tracker.mjs'
import { isMain } from './lib/main.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(readFileSync(join(here, '..', 'contract', 'contract.json'), 'utf8'))
const core = { coreContract: contract.version, points: contract.points }

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

// The tracker's `check` after a passing registry check, or nothing when no plugin provides it.
function trackerCheck(root, check) {
  if (!check.ok || !check.plugins.some((p) => p.points.includes('tracker'))) return {}
  return { tracker: trackerCall(root, 'check', {}, core) }
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
    case 'init': {
      const result = {
        ...initRegistry(root, contract.version),
        contract: contract.version,
        settings: declareInHost(root, { source: marketplaceSource(home) }),
        gitignore: ignoreLocalDirs(root),
        planningGuide: createPlanningGuide(root),
        reviewPrompt: createReviewPrompt(root),
        branches: readBranches(root),
        detectedIntegration: detectIntegration(root),
        superpowers: checkSuperpowers(root, { home }),
        check: checkRegistry(root, { ...core, home })
      }
      Object.assign(result, trackerCheck(root, result.check))
      return { ...result, report: initReport(result) }
    }
    case 'branches': {
      if (!integration) throw new Error('usage: branches --integration <branch> [--protected <b1,b2>]')
      const branches = setBranches(root, { integration, protected: protectedList ? protectedList.split(',').map((b) => b.trim()) : [] })
      const check = checkRegistry(root, { ...core, home })
      return { ...branches, check, report: branchesReport(branches, check) }
    }
    case 'add': {
      if (!target) throw new Error('usage: add <plugin id or path> [--config <json>]')
      const added = addExtension(root, target, { ...core, home, config: config && JSON.parse(config) })
      const check = checkRegistry(root, { ...core, home })
      const tracker = trackerCheck(root, check)
      return { ...added, check, ...tracker, report: addReport(added, check, tracker.tracker) }
    }
    case 'remove': {
      if (!target) throw new Error('usage: remove <plugin name>')
      const removed = removeExtension(root, target, { home })
      const check = checkRegistry(root, { ...core, home })
      return { ...removed, check, report: removeReport(removed, check) }
    }
    case 'check':
      return checkRegistry(root, { ...core, home })
    default:
      throw new Error('usage: extensions.mjs init|branches|add|remove|check [--root <dir>]')
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
