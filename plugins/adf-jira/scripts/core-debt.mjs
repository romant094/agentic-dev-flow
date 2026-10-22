#!/usr/bin/env node
// Runs the ADF core's debt store CLI (`scripts/debt.mjs` of the `adf` plugin) with the same
// arguments, so a skill of this plugin reads and writes the debt tree only through the core.
//
//   core-debt.mjs list --kind debt
//   core-debt.mjs track --id <id> --key <KEY>
//
// The core is found beside this plugin (a checkout of the marketplace), else in Claude Code's
// install records: the `adf` plugin of this plugin's marketplace, the install for this project
// first. Prints the core's own output; with no core it prints { ok: false, error } and exits 1.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainCheckout } from './lib/config.mjs'
import { isMain } from './lib/main.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEBT = join('scripts', 'debt.mjs')

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function findCore({ pluginRoot = PLUGIN_ROOT, home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), projectDir, exists = existsSync } = {}) {
  const sibling = join(pluginRoot, '..', 'adf')
  if (exists(join(sibling, DEBT))) return sibling
  let records
  try {
    records = JSON.parse(readFileSync(join(home, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
  } catch {
    return null
  }
  const own = Object.entries(records).find(
    ([id, list]) => id.startsWith('adf-jira@') && Array.isArray(list) && list.some((r) => r.installPath && real(r.installPath) === real(pluginRoot))
  )
  const marketplace = own ? own[0].split('@')[1] : null
  const installs = Object.entries(records)
    .filter(([id]) => (marketplace ? id === `adf@${marketplace}` : id.startsWith('adf@')))
    .flatMap(([, list]) => (Array.isArray(list) ? list : []))
    .filter((r) => r.installPath && exists(join(r.installPath, DEBT)))
  const here = projectDir ? installs.find((r) => r.projectPath && real(r.projectPath) === real(projectDir)) : undefined
  return (here ?? installs.find((r) => r.scope === 'user') ?? installs[0])?.installPath ?? null
}

// The core's debt CLI run with `argv` from `cwd`, its one JSON result parsed: what a script of
// this plugin reads the tree through. Throws when no core is found or its output is not JSON;
// a refusal is returned as the core printed it, `ok` false.
export function callCore(argv, { cwd = process.cwd(), core = findCore({ projectDir: mainCheckout(cwd) }) } = {}) {
  if (!core) throw new Error('the adf core plugin is not installed for this project; install it, then rerun')
  const run = spawnSync(process.execPath, [join(core, DEBT), ...argv], { cwd, encoding: 'utf8' })
  try {
    return JSON.parse(run.stdout)
  } catch {
    throw new Error(`the core's debt.mjs ${argv[0]} printed no JSON${run.stderr ? `: ${run.stderr.trim()}` : ''}`)
  }
}

if (isMain(import.meta.url)) {
  const core = findCore({ projectDir: mainCheckout(process.cwd()) })
  if (!core) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'the adf core plugin is not installed for this project; install it, then rerun' })}\n`)
    process.exitCode = 1
  } else {
    const run = spawnSync(process.execPath, [join(core, DEBT), ...process.argv.slice(2)], { stdio: 'inherit' })
    process.exitCode = run.status ?? 1
  }
}
