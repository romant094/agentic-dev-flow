#!/usr/bin/env node
// CLI over lib/workspace.mjs. Prints one JSON object on stdout and exits 1 on a refusal.
//
//   workspace.mjs suggest --change <name>
//       the branch policy, the current branch, the bases the developer may choose, a branch
//       name to propose, the worktree path, and any uncommitted tracked changes
//   workspace.mjs create --change <name> --branch <branch> --base integration|current
//       make the branch and its worktree; prints the worktree root and the base branch
//   workspace.mjs group-add|group-merge|group-remove --change <name> --group <n>
//       from the change worktree: make a task group's worktree from the change branch, merge
//       it back (conflicts are listed and the merge left in progress), remove a merged one
//   workspace.mjs groups --change <name>
//       the change's group worktrees
//
// --root <dir> names the host project's main checkout, or for a group command the change
// worktree (default: the current directory).
import { create, suggest } from './lib/workspace.mjs'
import { addGroup, listGroups, mergeGroup, removeGroup } from './lib/groups.mjs'
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
  const group = option(args, '--group')
  const [command] = args
  if (!change) throw new Error('usage: workspace.mjs <command> --change <name>')
  switch (command) {
    case 'suggest':
      return suggest(root, change)
    case 'create':
      return create(root, { change, branch, base })
    case 'group-add':
      return addGroup(root, { change, group })
    case 'group-merge':
      return mergeGroup(root, { change, group })
    case 'group-remove':
      return removeGroup(root, { change, group })
    case 'groups':
      return { groups: listGroups(root, change) }
    default:
      throw new Error('usage: workspace.mjs suggest|create|group-add|group-merge|group-remove|groups --change <name> [--root <dir>]')
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
