#!/usr/bin/env node
// CLI over lib/workspace.mjs. Prints one JSON object on stdout and exits 1 on a refusal.
//
//   workspace.mjs suggest --change <name>
//       the branch policy, the current branch, the bases the developer may choose, a branch
//       name to propose, the worktree path, and any uncommitted tracked changes
//   workspace.mjs create --change <name> --branch <branch> --base integration|current
//       make the branch and its worktree; prints the worktree root and the base branch
//
// --root <dir> names the host project's main checkout (default: the current directory).
import { create, suggest } from './lib/workspace.mjs'
import { isMain } from './lib/main.mjs'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const change = option(args, '--change')
  const branch = option(args, '--branch')
  const base = option(args, '--base')
  const [command] = args
  if (!change) throw new Error('usage: workspace.mjs suggest|create --change <name>')
  switch (command) {
    case 'suggest':
      return suggest(root, change)
    case 'create':
      return create(root, { change, branch, base })
    default:
      throw new Error('usage: workspace.mjs suggest|create --change <name> [--root <dir>]')
  }
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
