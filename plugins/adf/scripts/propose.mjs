#!/usr/bin/env node
// CLI over lib/propose.mjs: the fixed sequences of /adf:propose. Prints one JSON object on
// stdout; exit 1 on a refusal, exit 2 on a usage error.
//
//   propose.mjs create --change <name> --branch <branch> --base integration|current [--root <main>]
//       From the main checkout, after `preflight.mjs --phase propose` passed and the developer
//       chose the base and confirmed the branch: makes the branch and its worktree, the change
//       with its base recorded, and the propose session in the ledger. A scope gathered for the
//       change (scope.mjs) that holds an item or a skipped tracker is copied into the change as
//       scope.json, which the commit carries; `scope` names it.
//       { ok, change, root, branch, base, baseRef, changeRoot, ledger, scope? }
//   propose.mjs commit [--change <name>] [--root <worktree>]
//       Refused until every artifact apply needs is done and every gate of every written
//       artifact passes; then commits openspec/changes/<name>/ alone with the message
//       "docs(openspec): propose <name>" (lib/commit.mjs: nothing else staged, not protected,
//       not the main checkout). { ok, commit, branch, files, gates }
//
// --root defaults to the current directory. Without --change, commit acts on the one active
// change under the root.
import { resolve } from 'node:path'
import { inferChange } from './lib/changes.mjs'
import { isMain } from './lib/main.mjs'
import { commitChange, createChange } from './lib/propose.mjs'
import { loadSchema } from './lib/schema.mjs'

export const USAGE = 'usage: propose.mjs create --change <name> --branch <branch> --base integration|current [--root <dir>] | propose.mjs commit [--change <name>] [--root <dir>]'
class Usage extends Error {}

function parse(argv) {
  const args = [...argv]
  const command = args.shift()
  const out = {}
  while (args.length) {
    const flag = args.shift()
    if (!['--change', '--branch', '--base', '--root'].includes(flag)) throw new Usage(`unknown argument ${flag}`)
    const value = args.shift()
    if (value === undefined || value.startsWith('--')) throw new Usage(`${flag} needs a value`)
    out[flag.slice(2)] = value
  }
  return { command, ...out, root: resolve(out.root ?? process.cwd()) }
}

export async function run(argv, { env = process.env } = {}) {
  try {
    const o = parse(argv)
    const schema = loadSchema()
    if (o.command === 'create') {
      if (!o.change || !o.branch || !o.base) throw new Usage('create needs --change, --branch and --base')
      return { code: 0, result: createChange(o.root, { change: o.change, branch: o.branch, base: o.base }, schema, { env }) }
    }
    if (o.command === 'commit') {
      if (o.branch || o.base) throw new Usage('commit takes --change and --root only')
      const result = await commitChange(o.root, inferChange(o.root, o.change, schema), schema)
      return { code: result.ok ? 0 : 1, result }
    }
    throw new Usage(`unknown command "${o.command ?? ''}"`)
  } catch (error) {
    if (error instanceof Usage) return { code: 2, result: { ok: false, error: `${error.message}; ${USAGE}` } }
    return { code: 1, result: { ok: false, error: error.message } }
  }
}

if (isMain(import.meta.url)) {
  const { code, result } = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = code
}
