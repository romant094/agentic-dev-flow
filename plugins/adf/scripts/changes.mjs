#!/usr/bin/env node
// CLI over lib/changes.mjs and lib/propose.mjs. Every subcommand prints one JSON object on
// stdout and exits 1 on a refusal (a thrown error, or a result whose `ok` is false).
//
//   changes.mjs new <name> [--base <branch>]         create a change; --base records the
//                                                    branch it forked from
//   changes.mjs list                                 active changes with task progress
//   changes.mjs find                                 the active changes of every checkout of
//                                                    the repository (main and change worktrees),
//                                                    with `duplicates` and `choices` (a label
//                                                    per change and per unresolved worktree)
//   changes.mjs status [--change <name>] [--report [--forge <json>|@<file>]]
//                                                    each artifact: done, ready or blocked;
//                                                    --report adds the rendered propose report,
//                                                    with the merge request from a forge.mjs
//                                                    result when --forge passes one
//   changes.mjs instructions <artifact|apply> [--change <name>]
//                                                    what to write next, or how to apply
//   changes.mjs next [--change <name>]               the next artifact propose writes, with its
//                                                    instructions and dependency files, or
//                                                    {done:true}; refused while a written
//                                                    artifact fails one of its gates
//   changes.mjs done <artifact> [--change <name>]    moves a Superpowers skill's default-folder
//                                                    output into the change, reports copied
//                                                    project guidance, runs the artifact's gates
//   changes.mjs skip <artifact> [--change <name>]    records that an optional artifact is not
//                                                    written
//   changes.mjs schema                               validate the schema and print its graph
//
// --root <dir> names the host project or the change worktree (default: the current directory).
// Without --change the change is the one active change under the root. next, done and skip
// write, and refuse the main checkout unless --allow-main is given.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyInstructions,
  artifactInstructions,
  changeMeta,
  changeStatus,
  findChoices,
  inferChange,
  listChanges,
  newChange,
  refuseMainCheckout,
  skipArtifact,
  statusReport
} from './lib/changes.mjs'
import { buildOrder, loadSchema } from './lib/schema.mjs'
import { isMain } from './lib/main.mjs'
import { findChanges } from './lib/resolve.mjs'
import { markDone, nextArtifact } from './lib/propose.mjs'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function branchOf(root) {
  try {
    return execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

const readJsonArg = (value) => JSON.parse(value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value)

// Returns the result, or a promise of it for next and done, which run gates.
export function run(argv, { schemaDir } = {}) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const given = option(args, '--change')
  const base = option(args, '--base')
  const forge = option(args, '--forge')
  const report = flag(args, '--report')
  const allowMain = flag(args, '--allow-main')
  const [command, target] = args
  const schema = loadSchema(schemaDir)
  const change = () => inferChange(root, given, schema)
  const writing = () => refuseMainCheckout(root, { allowMain })
  switch (command) {
    case 'new':
      if (!target) throw new Error('usage: new <name>')
      return newChange(root, target, schema, { base })
    case 'list':
      return listChanges(root, schema)
    case 'find': {
      const found = findChanges(root, schema)
      return { ...found, ...findChoices(found) }
    }
    case 'status': {
      const name = change()
      const status = changeStatus(root, name, schema)
      if (!report) return status
      const text = statusReport(status, {
        root: resolve(root),
        branch: branchOf(root),
        base: changeMeta(root, name).base ?? null,
        forge: forge ? readJsonArg(forge) : null
      })
      return { ...status, report: text }
    }
    case 'instructions':
      if (!target) throw new Error('usage: instructions <artifact|apply> [--change <name>]')
      return target === 'apply'
        ? applyInstructions(root, change(), schema)
        : artifactInstructions(root, change(), target, schema)
    case 'next':
      writing()
      return nextArtifact(resolve(root), change(), schema)
    case 'done':
      if (!target) throw new Error('usage: done <artifact> [--change <name>]')
      writing()
      return markDone(resolve(root), change(), target, schema)
    case 'skip':
      if (!target) throw new Error('usage: skip <artifact> [--change <name>]')
      writing()
      return skipArtifact(root, change(), target, schema)
    case 'schema':
      return { name: schema.name, version: schema.version, order: buildOrder(schema), apply: schema.apply ?? null }
    default:
      throw new Error('usage: changes.mjs new|list|find|status|instructions|next|done|skip|schema [--root <dir>]')
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result?.ok === false) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
