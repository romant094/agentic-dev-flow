#!/usr/bin/env node
// The `forge` role: push the change branch and keep its merge request.
//
//   forge.mjs check|open|push|finalize [--input <json> | --input-file <path>] [--root <dir>] [--home <dir>]
//   forge.mjs open|push|finalize --change <name> [--summary "<scope>: <description>" | --title <t>]
//                                [--draft true|false] [--input ...] [--root <change worktree>]
//       With --change, the core reads what it already holds: the branch from git in --root, the
//       base from the change's .adf.json, the protected branches from the registry, and the
//       title's type from the branch prefix (feat/... gives feat). --input then carries only
//       what no state holds (finalize's body); a value it repeats must agree. The main checkout
//       is refused. Without --change the input is passed as given, as before.
//
// Prints one JSON object. With no forge plugin enabled the state is `none`: nothing is pushed
// and no merge request exists; archive offers to merge the change into its base. Exit 1 only for
// `refused`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRole, forgeInput } from './lib/roles.mjs'
import { changeDir, inferChange, META_FILE, refuseMainCheckout } from './lib/changes.mjs'
import { readBranches } from './lib/branches.mjs'
import { loadSchema } from './lib/schema.mjs'
import { execFileSync } from 'node:child_process'
import { claudeHome } from './lib/superpowers.mjs'
import { isMain } from './lib/main.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(readFileSync(join(here, '..', 'contract', 'contract.json'), 'utf8'))

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function readState(root, change) {
  let branch = null
  try {
    branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    branch = null
  }
  let base = null
  try {
    base = JSON.parse(readFileSync(join(changeDir(root, change), META_FILE), 'utf8')).base ?? null
  } catch {
    base = null
  }
  return { change, branch, base, protected: readBranches(root)?.protected ?? null }
}

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const home = option(args, '--home') ?? claudeHome()
  const text = option(args, '--input')
  const file = option(args, '--input-file')
  const change = option(args, '--change')
  const title = option(args, '--title')
  const summary = option(args, '--summary')
  const draft = option(args, '--draft')
  const [operation] = args
  if (!operation || args.length > 1) throw new Error('usage: forge.mjs check|open|push|finalize [--change <name> [--summary <s> | --title <t>] [--draft true|false]] [--input <json> | --input-file <path>] [--root <dir>]')
  if (draft !== undefined && !['true', 'false'].includes(draft)) throw new Error('--draft must be true or false')
  let input = file ? JSON.parse(readFileSync(file, 'utf8')) : text ? JSON.parse(text) : {}
  if (change !== undefined || title !== undefined || summary !== undefined) {
    if (operation === 'check') throw new Error('check takes no --change, --title or --summary')
    refuseMainCheckout(root)
    const name = inferChange(root, change, loadSchema())
    input = forgeInput(operation, readState(root, name), { input, title, summary, draft: draft === undefined ? undefined : draft === 'true' })
  }
  return callRole(root, 'forge', operation, input, { coreContract: contract.version, points: contract.points, home })
}

if (isMain(import.meta.url)) {
  let result
  try {
    result = run(process.argv.slice(2))
  } catch (error) {
    result = { state: 'refused', error: error.message }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.state === 'refused' ? 1 : 0
}
