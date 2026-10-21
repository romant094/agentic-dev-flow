#!/usr/bin/env node
// CLI over lib/workspace.mjs. Prints one JSON object on stdout and exits 1 on a refusal, or
// when the result says `ok: false`.
//
//   workspace.mjs suggest --change <name>
//       the branch policy, the current branch, the bases the developer may choose, a branch
//       name to propose, the worktree path, and any uncommitted tracked changes
//   workspace.mjs create --change <name> --branch <branch> --base integration|current
//       make the branch and its worktree; prints the worktree root and the base branch
//   workspace.mjs provision --change <name> [--worktree <path>] [--kind change|group|base-check|proof]
//                          [--need <word> ...]
//       from the change worktree: provision a worktree the core made (default: the change
//       worktree itself, kind change). Copies the paths the planning guide's `## Worktree copies`
//       names from the main checkout where the worktree holds nothing, then calls the
//       `provision` hook with the plan's paths and needs (`**Needs:**`, plus each --need; a
//       change or group worktree only). Refused when the worktree's or the main checkout's
//       `git status --porcelain` changed: { ok, state, worktree, kind, input, copies, hook,
//       notes, report, error? }. Show `report`: it holds each provider's notes. Re-runnable
//   workspace.mjs group-add|group-merge|group-remove --change <name> --group <n>
//       from the change worktree: make a task group's worktree from the change branch and
//       provision it (`provision`; `ok: false` when that refused, the worktree left made),
//       merge it back (conflicts are listed and the merge left in progress), remove a merged one
//       after its `teardown` hook (a refused teardown keeps it)
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
//       failed; a worktree whose ledger the archived change holds no copy of is refused; a
//       worktree with uncommitted changes is refused with its `git status --porcelain`; the
//       `teardown` hook runs last, and a refused teardown is refused here
//   workspace.mjs base-check-add|base-check-remove --change <name>
//       from the change worktree: make a detached worktree of the change's base (the
//       .adf.json base, the remote-tracking ref when it exists) to check whether a whole-suite
//       failure is pre-existing, and provision it with no needs; remove it again after its
//       teardown, never forced
//
// --root <dir> names the host project's main checkout, or for a group, base-check or provision
// command the change worktree (default: the current directory). --home names the Claude Code
// home, where the Superpowers skill and the installed plugins are found (default:
// $CLAUDE_CONFIG_DIR, else ~/.claude).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, remove, suggest } from './lib/workspace.mjs'
import { addBaseCheck, addGroup, finishGroup, listGroups, mergeGroup, removeBaseCheck, removeGroup } from './lib/groups.mjs'
import { isMain } from './lib/main.mjs'
import { NEED_WORD, planInputs } from './lib/plan.mjs'
import { KINDS, NEEDS_KINDS, provisionWorktree } from './lib/provision.mjs'
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

function repeated(args, name) {
  const values = []
  for (let value = option(args, name); value !== undefined; value = option(args, name)) values.push(value)
  return values
}

// The plan's needs and each --need, for a change or group worktree; a --need for another kind is
// refused, since its tree gets none.
function provision(root, { change, worktree, kind, need }, core) {
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`)
  const bad = need.filter((w) => !NEED_WORD.test(w))
  if (bad.length) throw new Error(`--need takes a lowercase word, not ${bad.join(', ')}`)
  if (need.length && !NEEDS_KINDS.includes(kind)) throw new Error(`--need applies to a ${NEEDS_KINDS.join(' or ')} worktree, not ${kind}`)
  const { files, needs } = planInputs(root, change)
  return provisionWorktree(root, { worktree, kind, change, files, needs: [...new Set([...needs, ...need])] }, core)
}

export function run(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const change = option(args, '--change')
  const branch = option(args, '--branch')
  const base = option(args, '--base')
  const group = option(args, '--group')
  const home = option(args, '--home')
  const worktree = option(args, '--worktree')
  const kind = option(args, '--kind')
  const need = repeated(args, '--need')
  const [command] = args
  if (!change) throw new Error('usage: workspace.mjs <command> --change <name>')
  // The contract and home the hooks of a worktree are called with.
  const c = contract()
  const core = { coreContract: c.version, points: c.points, home: home ?? claudeHome() }
  switch (command) {
    case 'suggest':
      return suggest(root, change)
    case 'create':
      return create(root, { change, branch, base })
    case 'provision':
      return provision(root, { change, worktree: worktree ?? root, kind: kind ?? 'change', need }, core)
    case 'group-add':
      return addGroup(root, { change, group }, { core })
    case 'group-merge':
      return withPackage(root, change, mergeGroup(root, { change, group }), home)
    case 'group-finish':
      return finishGroup(root, { change, group }, core)
    case 'group-remove':
      return removeGroup(root, { change, group }, { core })
    case 'groups':
      return { groups: listGroups(root, change) }
    case 'remove':
      return remove(root, { change }, { core })
    case 'base-check-add':
      return addBaseCheck(root, { change }, { core })
    case 'base-check-remove':
      return removeBaseCheck(root, { change }, { core })
    default:
      throw new Error('usage: workspace.mjs suggest|create|provision|group-add|group-merge|group-remove|group-finish|groups|base-check-add|base-check-remove|remove --change <name> [--root <dir>]')
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result?.ok === false) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
