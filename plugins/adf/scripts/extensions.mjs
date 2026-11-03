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
//   extensions.mjs config <name|id> --config J
//                                            replace an enabled plugin's config, keeping its
//                                            place in the registry
//   extensions.mjs remove <name|id>          disable a plugin
//   extensions.mjs check                     validate the registry and every plugin
//   extensions.mjs where                     the plugin root the scripts run from:
//                                            { root, version, cached, warning }
//
// config and remove name a plugin by its name or its id (`name@marketplace`). add and config
// return `missingConfig`, the keys of the declaration's `requiredConfig` the config lacks, as
// a warning in `report`, never a refusal.
//
// init, branches, add, config and remove also run `check` and return it with `report`, the
// rendered text the command shows. add, config and remove change the registry before the check, so a failing
// check after them is reported, not refused. When that check passes and a plugin provides the
// tracker, init and add also run the tracker's `check` and return it as `tracker`, its notes
// in `report`; a degraded or refused tracker is reported, never a failure. Once the registry
// names a debt root, init and add also run the debt tree's check (lib/debt.mjs checkTree) and
// return it as `debt`, its errors in `report`; a failing debt check is reported, never a failure.
//
// --root <dir> names the host project (default: the current directory); --home <dir> the
// Claude Code home (default: $CLAUDE_CONFIG_DIR, else ~/.claude).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkTree } from './lib/debt.mjs'
import { fileURLToPath } from 'node:url'
import { declareInHost, marketplaceSource } from './lib/host-settings.mjs'
import { detectIntegration, readBranches, setBranches } from './lib/branches.mjs'
import { createPlanningGuide, createReviewPrompt, ignoreLocalDirs } from './lib/host-files.mjs'
import { addExtension, addReport, branchesReport, checkRegistry, configExtension, configReport, initRegistry, initReport, readDebtRoot, removeExtension, removeReport } from './lib/registry.mjs'
import { checkSuperpowers, claudeHome } from './lib/superpowers.mjs'
import { pluginRoot } from './lib/plugin-root.mjs'
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

// The debt tree's check, or nothing when the registry names no debt root.
function debtCheck(root) {
  const path = readDebtRoot(root)
  return path ? { debt: { root: path, ...checkTree(join(root, path)) } } : {}
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
      Object.assign(result, trackerCheck(root, result.check), debtCheck(root))
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
      const debt = debtCheck(root)
      return { ...added, check, ...tracker, ...debt, report: addReport(added, check, tracker.tracker, debt.debt) }
    }
    case 'config': {
      if (!target || config === undefined) throw new Error('usage: config <plugin name or id> --config <json>')
      const configured = configExtension(root, target, { config: JSON.parse(config), home })
      const check = checkRegistry(root, { ...core, home })
      return { ...configured, check, report: configReport(configured, check) }
    }
    case 'remove': {
      if (!target) throw new Error('usage: remove <plugin name or id>')
      const removed = removeExtension(root, target, { home })
      const check = checkRegistry(root, { ...core, home })
      return { ...removed, check, report: removeReport(removed, check) }
    }
    case 'check':
      return checkRegistry(root, { ...core, home })
    case 'where':
      return pluginRoot({ home, scriptUrl: new URL('./lib/plugin-root.mjs', import.meta.url).href })
    default:
      throw new Error('usage: extensions.mjs init|branches|add|config|remove|check|where [--root <dir>]')
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
