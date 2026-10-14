#!/usr/bin/env node
// The `forge` role: push the change branch and keep its merge request.
//
//   forge.mjs check|open|finalize [--input <json> | --input-file <path>] [--root <dir>] [--home <dir>]
//
// Prints one JSON object. With no forge plugin enabled the state is `none`: nothing is pushed
// and no merge request exists; archive offers to merge the change into its base. Exit 1 only for
// `refused`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRole } from './lib/roles.mjs'
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

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const home = option(args, '--home') ?? claudeHome()
  const text = option(args, '--input')
  const file = option(args, '--input-file')
  const [operation] = args
  if (!operation || args.length > 1) throw new Error('usage: forge.mjs check|open|finalize [--input <json> | --input-file <path>] [--root <dir>]')
  const input = file ? JSON.parse(readFileSync(file, 'utf8')) : text ? JSON.parse(text) : {}
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
