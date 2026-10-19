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
//   changes.mjs status [--change <name>] [--report]  each artifact: done, ready or blocked;
//                                                    --report adds the rendered propose report
//                                                    (the merge request is forge.mjs's own report)
//   changes.mjs instructions <artifact|apply> [--change <name>]
//                                                    what to write next, or how to apply
//   changes.mjs next [--change <name>]               the next artifact propose writes, with its
//                                                    instructions and dependency files, or
//                                                    {done:true}; refused while a written
//                                                    artifact fails one of its gates. Records the
//                                                    propose session in the ledger once per
//                                                    session (`ledger`), so a change continued in
//                                                    a later session is recorded too. For
//                                                    brainstorm also `knowledge`: { state, index,
//                                                    report }, the knowledge base's index from the
//                                                    knowledge role's `context`, absolute; null
//                                                    with no provider
//   changes.mjs done <artifact> [--change <name>]    moves a Superpowers skill's default-folder
//                                                    output into the change, reports copied
//                                                    project guidance, runs the artifact's gates
//   changes.mjs skip <artifact> [--change <name>]    records that an optional artifact is not
//                                                    written
//   changes.mjs schema                               validate the schema and print its graph
//   changes.mjs archive --change <name>              archive's move: copies the ledger into the
//                                                    change once, then moves the change to
//                                                    archive/<YYYY-MM-DD>-<name> (UTC); an
//                                                    existing target and a failed copy refuse;
//                                                    commits nothing (archive.mjs commit-specs
//                                                    does). { changeName, from, target, ledger:
//                                                    copied|none, already }
//
// --root <dir> names the host project or the change worktree (default: the current directory).
// Without --change the change is the one active change under the root. next, done, skip and
// archive write, and refuse the main checkout unless --allow-main is given.
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import {
  applyInstructions,
  archiveChange,
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
import { recordSessionOnce } from './lib/ledger.mjs'
import { markDone, nextArtifact } from './lib/propose.mjs'
import { callRole, CORE, knowledgeReport } from './lib/roles.mjs'
import { claudeHome } from './lib/superpowers.mjs'

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

// Brainstorm reads the knowledge base first: its index, from the knowledge role's `context`.
// With no provider, or one that fails, there is no index, and `report` says why.
function knowledgeIndex(root, read) {
  let context
  try {
    context = read(root)
  } catch (error) {
    context = { state: 'refused', error: error.message }
  }
  const index = context.state === 'done' && typeof context.index === 'string' && context.index !== '' ? join(root, context.index) : null
  return { state: context.state, index, report: knowledgeReport('context', context) }
}

const readKnowledge = (root) => callRole(root, 'knowledge', 'context', {}, { ...CORE, home: claudeHome() })

// Returns the result, or a promise of it for next and done, which run gates. `knowledge(root)`
// is the knowledge role's `context` call; the tests inject it.
export function run(argv, { schemaDir, env = process.env, knowledge = readKnowledge } = {}) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const given = option(args, '--change')
  const base = option(args, '--base')
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
      if (target) throw new Error(`status takes no "${target}"; usage: status [--change <name>] [--report]`)
      const name = change()
      const status = changeStatus(root, name, schema)
      if (!report) return status
      const text = statusReport(status, { root: resolve(root), branch: branchOf(root), base: changeMeta(root, name).base ?? null })
      return { ...status, report: text }
    }
    case 'instructions':
      if (!target) throw new Error('usage: instructions <artifact|apply> [--change <name>]')
      return target === 'apply'
        ? applyInstructions(root, change(), schema)
        : artifactInstructions(root, change(), target, schema)
    case 'next': {
      writing()
      const name = change()
      // Recorded after nextArtifact has found the change, so no ledger is made for a typo.
      return nextArtifact(resolve(root), name, schema).then((result) => ({
        ...result,
        ...(result.artifact === 'brainstorm' ? { knowledge: knowledgeIndex(resolve(root), knowledge) } : {}),
        ledger: recordSessionOnce(resolve(root), name, 'propose', { env })
      }))
    }
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
    case 'archive':
      if (target || !given) throw new Error('usage: archive --change <name>')
      writing()
      return archiveChange(resolve(root), given)
    default:
      throw new Error('usage: changes.mjs new|list|find|status|instructions|next|done|skip|schema|archive [--root <dir>]')
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
