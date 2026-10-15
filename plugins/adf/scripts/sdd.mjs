#!/usr/bin/env node
// CLI over lib/sdd.mjs: refuses to start a change's execution while the shared SDD workspace
// `.superpowers/sdd/plan/` holds another plan's ledger. Prints one JSON object on stdout.
//
//   sdd.mjs --change <name> [--root <dir>]
//   sdd.mjs init --change <name> [--root <dir>]
//       the same check, then write .superpowers/sdd/<name>/progress.md with its one identity
//       line, `# SDD ledger — plan: <root>/openspec/changes/<name>/plan.md`, when it is missing;
//       an existing one is kept when it names this change's plan and refused otherwise
//       ({ ok, change, foreign, progress, written })
//
// --root <dir> names the host project (default: the current directory).
// Exit 0: the workspace is clean ({ ok: true, change, foreign: null }). Exit 1: a foreign or
// unidentifiable ledger is there ({ ok: false, change, foreign, error }). Exit 2: no change
// name ({ ok: false, error, usage }).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { checkSddWorkspace, initSddWorkspace, stopMessage } from './lib/sdd.mjs'

export const USAGE = 'Usage:\n  sdd.mjs [init] --change <name> [--root <dir>]'

// A wrong call, as opposed to a foreign ledger: exit 2.
export class UsageError extends Error {}

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  return value
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const args = [...argv]
  const root = option(args, '--root') ?? cwd
  const change = option(args, '--change')
  if (!change) throw new UsageError('usage: sdd.mjs [init] --change <name> [--root <dir>]')
  if (args[0] === 'init') {
    // A placeholder such as `<name>` once gave a false STOP; init would also write under it.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(change)) throw new UsageError(`change name "${change}" is not kebab-case`)
    return init(root, change)
  }
  const { ok, foreign } = checkSddWorkspace({
    changeName: change,
    read: (f) => readFileSync(join(root, f), 'utf8'),
    list: (d) => readdirSync(join(root, d))
  })
  if (ok) return { ok, change, foreign }
  return { ok, change, foreign, error: stopMessage(change, foreign).join(' ') }
}

// A foreign ledger in the change's own workspace is refused in the same words as one on the
// shared path.
export function init(root, change) {
  const out = initSddWorkspace({
    changeName: change,
    planPath: join(resolve(root), 'openspec', 'changes', change, 'plan.md'),
    read: (f) => readFileSync(join(root, f), 'utf8'),
    list: (d) => readdirSync(join(root, d)),
    write: (f, text) => {
      mkdirSync(dirname(join(root, f)), { recursive: true })
      writeFileSync(join(root, f), text, 'utf8')
    }
  })
  const result = { ok: out.ok, change, foreign: out.foreign, progress: out.progress, written: out.written }
  return out.ok ? result : { ...result, error: stopMessage(change, out.foreign).join(' ') }
}

if (isMain(import.meta.url)) {
  try {
    const out = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (!out.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, usage: USAGE })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
