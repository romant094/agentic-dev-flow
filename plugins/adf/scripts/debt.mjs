#!/usr/bin/env node
// CLI over lib/debt.mjs, the core's technical debt store (format: contract/debt-format.md).
// Prints one JSON object on stdout; exit 1 on a refusal or a failing check, exit 2 on a usage
// error. --root is the host project (default: the current directory); the tree is the
// registry's `debt.root` under it, or --tree <dir>, which overrides it. Nothing is committed
// and nothing is sent anywhere.
//
//   debt.mjs root [--set <path>]
//       the registry's debt.root; --set records it and creates the tree's root index when
//       missing. { ok, root: <path> | null, created }
//   debt.mjs list [--kind debt|flow]
//       every block, sub-block and entry, computed from the files.
//       { ok, root, blocks: [{ id, kind, covers, index, columns, subBlocks, bodyFiles }],
//         entries: [entry] }
//       entry (kind debt) { id, kind, block, subBlock, title, anchors, class, source, tracker }
//       entry (kind flow) { id, kind, block, title, plugin, pluginVersion, change, class,
//                           source, filed, body }
//   debt.mjs add --block <id> --title <t> --anchors <a1,a2> --class defect|debt|decision
//                --source <s> [--sub <sub-block>] [--covers <text>]
//       the block's next id; anchors split at a comma not followed by a digit, so
//       `file.ts:187,207` is one. A new block gets its directory and its root-index row
//       (--covers fills its Covers cell). The same block, title and source again changes
//       nothing.
//       { ok, created, newBlock, entry, files }
//   debt.mjs anchor --id <id> --anchor <site>
//       one more code site for an existing entry. { ok, added, entry }
//   debt.mjs remove --id <id>
//       delete a resolved entry; no other id changes. { ok, removed, files }
//   debt.mjs check
//       the tree's rules. { ok, errors: [{ file, line, message }] }
//   debt.mjs flow --change <name> --file <json>
//       a record of kind flow from { plugin, pluginVersion, class, title, body, source?,
//       change? }; class defect|deferred wording|decision; source defaults to the change. The
//       same plugin, change and title again changes nothing. { ok, created, record, files }
//   debt.mjs mark-filed --id <flow id> --url <issue url>
//       the issue the maintainer filed the record as. { ok, changed, record }
import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { addAnchor, addEntry, addFlowRecord, checkTree, ensureRootIndex, listTree, markFiled, removeEntry } from './lib/debt.mjs'
import { isMain } from './lib/main.mjs'
import { readDebtRoot, setDebtRoot } from './lib/registry.mjs'

export const USAGE = `usage:
  debt.mjs root [--set <path>] [--root <dir>]
  debt.mjs list [--kind debt|flow] [--root <dir>] [--tree <dir>]
  debt.mjs add --block <id> --title <t> --anchors <a1,a2> --class defect|debt|decision --source <s> [--sub <sub-block>] [--covers <text>] [--root <dir>] [--tree <dir>]
  debt.mjs anchor --id <id> --anchor <site> [--root <dir>] [--tree <dir>]
  debt.mjs remove --id <id> [--root <dir>] [--tree <dir>]
  debt.mjs check [--root <dir>] [--tree <dir>]
  debt.mjs flow --change <name> --file <json> [--root <dir>] [--tree <dir>]
  debt.mjs mark-filed --id <flow id> --url <url> [--root <dir>] [--tree <dir>]`

export class UsageError extends Error {}

// The options each subcommand takes, besides --root and --tree; the required ones first.
const TAKES = {
  root: { required: [], optional: ['set'] },
  list: { required: [], optional: ['kind'] },
  add: { required: ['block', 'title', 'anchors', 'class', 'source'], optional: ['sub', 'covers'] },
  anchor: { required: ['id', 'anchor'], optional: [] },
  remove: { required: ['id'], optional: [] },
  check: { required: [], optional: [] },
  flow: { required: ['change', 'file'], optional: [] },
  'mark-filed': { required: ['id', 'url'], optional: [] }
}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

function treeOf(root, cwd, values) {
  if (values.tree) return resolve(cwd, values.tree)
  const path = readDebtRoot(root)
  if (!path) throw new Error('the registry sets no debt.root; run /adf:init')
  return join(root, path)
}

function readJson(cwd, file) {
  let text
  try {
    text = readFileSync(resolve(cwd, file), 'utf8')
  } catch {
    throw new Error(`cannot read ${file}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`)
  }
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [command, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(TAKES, command)) throw new UsageError(USAGE)
  const { required, optional } = TAKES[command]
  const stray = Object.keys(values).filter((k) => !['root', 'tree', ...required, ...optional].includes(k))
  if (stray.length > 0) throw new UsageError(`--${stray.join(', --')} does not belong to ${command}`)
  const missing = required.filter((k) => values[k] === undefined)
  if (missing.length > 0) throw new UsageError(`${command} needs --${missing.join(', --')}`)
  const root = resolve(cwd, values.root ?? '.')
  if (command === 'root') {
    if (values.tree) throw new UsageError('root reads and sets the registry; --tree does not belong to it')
    if (values.set === undefined) return { ok: true, root: readDebtRoot(root), created: false }
    setDebtRoot(root, values.set)
    return { ok: true, root: values.set, ...ensureRootIndex(join(root, values.set)) }
  }
  const tree = treeOf(root, cwd, values)
  const where = relative(root, tree) || '.'
  switch (command) {
    case 'list': {
      if (values.kind !== undefined && !['debt', 'flow'].includes(values.kind)) throw new UsageError('--kind is debt or flow')
      return { ok: true, root: where, ...listTree(tree, { kind: values.kind }) }
    }
    case 'add': {
      // A comma before a digit stays: `file.ts:187,207` is one anchor with two lines.
      const anchors = values.anchors
        .split(/,(?!\d)/)
        .map((a) => a.trim())
        .filter(Boolean)
      return { ok: true, ...addEntry(tree, { block: values.block, title: values.title, anchors, class: values.class, source: values.source, subBlock: values.sub ?? null, covers: values.covers ?? null }) }
    }
    case 'anchor':
      return { ok: true, ...addAnchor(tree, { id: values.id, anchor: values.anchor }) }
    case 'remove':
      return { ok: true, ...removeEntry(tree, { id: values.id }) }
    case 'check':
      return checkTree(tree)
    case 'flow':
      return { ok: true, ...addFlowRecord(tree, values.change, readJson(cwd, values.file)) }
    case 'mark-filed':
      return { ok: true, ...markFiled(tree, { id: values.id, url: values.url }) }
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok === false ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
