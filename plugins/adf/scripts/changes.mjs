#!/usr/bin/env node
// CLI over lib/changes.mjs. Every subcommand prints one JSON object on stdout and exits 1 on
// a refusal.
//
//   changes.mjs new <name>                           create a change
//   changes.mjs list                                 active changes with task progress
//   changes.mjs status --change <name>               each artifact: done, ready or blocked
//   changes.mjs instructions <artifact|apply> --change <name>
//                                                    what to write next, or how to apply
//   changes.mjs schema                               validate the schema and print its graph
//
// --root <dir> names the host project (default: the current directory).
import { fileURLToPath } from 'node:url'
import { applyInstructions, artifactInstructions, changeStatus, listChanges, newChange } from './lib/changes.mjs'
import { buildOrder, loadSchema } from './lib/schema.mjs'

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

export function run(argv, { schemaDir } = {}) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const change = option(args, '--change')
  const [command, target] = args
  const schema = loadSchema(schemaDir)
  const needChange = () => {
    if (!change) throw new Error(`usage: ${command} --change <name>`)
    return change
  }
  switch (command) {
    case 'new':
      if (!target) throw new Error('usage: new <name>')
      return newChange(root, target, schema)
    case 'list':
      return listChanges(root, schema)
    case 'status':
      return changeStatus(root, needChange(), schema)
    case 'instructions':
      if (!target) throw new Error('usage: instructions <artifact|apply> --change <name>')
      return target === 'apply'
        ? applyInstructions(root, needChange(), schema)
        : artifactInstructions(root, needChange(), target, schema)
    case 'schema':
      return { name: schema.name, version: schema.version, order: buildOrder(schema), apply: schema.apply ?? null }
    default:
      throw new Error('usage: changes.mjs new|list|status|instructions|schema [--root <dir>]')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
