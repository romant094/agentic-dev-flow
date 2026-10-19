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
//   group-merge, once the merge is made (by it, or by the resolver's commit and a second call):
//       { merged: true, already, mergeCommit, firstParent, package } — package is
//       `sdd.mjs package` of firstParent..mergeCommit, the merge review's input
//       ({ ok, file, ... }, or { ok: false, error }: the merge stands either way)
//   workspace.mjs group-finish --change <name> --group <n> [--home <dir>]
//       after the merge review passed: remove the group's worktree and branch, then push the
//       change branch through the forge role with the branch and the protected list read from
//       the registry: { removed, push: { state, hint?, error? } }. state `none` means no forge
//       plugin is enabled and nothing was pushed; the push is kept for apply's report in
//       .superpowers/sdd/<change>/push.json
//   workspace.mjs groups --change <name>
//       the change's group worktrees
//   workspace.mjs remove --change <name>
//       archive's last step, from the main checkout: remove the change's worktree, never
//       forced, keeping its branch: { ok, state: removed|in-place|absent, change, path?,
//       branch? }. A change made in place, or whose worktree is already gone, is reported, not
//       failed; a worktree with uncommitted changes is refused with its `git status --porcelain`
//   workspace.mjs base-check-add|base-check-remove --change <name>
//       from the change worktree: make a detached worktree of the change's base (the
//       .adf.json base, the remote-tracking ref when it exists) to check whether a whole-suite
//       failure is pre-existing; remove it again, never forced
//
// --root <dir> names the host project's main checkout, or for a group or base-check
// command the change worktree (default: the current directory). --home names the Claude Code
// home, where the Superpowers skill and the forge plugin are found (default:
// $CLAUDE_CONFIG_DIR, else ~/.claude).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, remove, suggest } from './lib/workspace.mjs'
import { addBaseCheck, addGroup, finishGroup, listGroups, mergeGroup, removeBaseCheck, removeGroup } from './lib/groups.mjs'
import { isMain } from './lib/main.mjs'
import { reviewPackage } from './lib/sdd.mjs'
import { claudeHome } from './lib/superpowers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const contract = () => JSON.parse(readFileSync(join(here, '..', 'contract', 'contract.json'), 'utf8'))

// The merge review's package; a failure to cut it leaves the merge standing and is reported.
function withPackage(root, change, merge, home) {
  if (!merge.merged) return merge
  let pkg
  try {
    pkg = reviewPackage(root, change, merge.firstParent, merge.mergeCommit, { home })
  } catch (error) {
    pkg = { ok: false, error: error.message }
  }
  return { ...merge, package: pkg }
}

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
  const home = option(args, '--home')
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
      return withPackage(root, change, mergeGroup(root, { change, group }), home)
    case 'group-finish': {
      const c = contract()
      return finishGroup(root, { change, group }, { coreContract: c.version, points: c.points, home: home ?? claudeHome() })
    }
    case 'group-remove':
      return removeGroup(root, { change, group })
    case 'groups':
      return { groups: listGroups(root, change) }
    case 'remove':
      return remove(root, { change })
    case 'base-check-add':
      return addBaseCheck(root, { change })
    case 'base-check-remove':
      return removeBaseCheck(root, { change })
    default:
      throw new Error('usage: workspace.mjs suggest|create|group-add|group-merge|group-remove|group-finish|groups|base-check-add|base-check-remove|remove --change <name> [--root <dir>]')
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
