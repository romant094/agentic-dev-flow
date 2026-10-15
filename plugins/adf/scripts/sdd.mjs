#!/usr/bin/env node
// CLI over lib/sdd.mjs: refuses to start a change's execution while the shared SDD workspace
// `.superpowers/sdd/plan/` holds another plan's ledger, and calls the Superpowers skill's two
// scripts with the change's own output paths. Prints one JSON object on stdout.
//
//   sdd.mjs --change <name> [--root <dir>]
//   sdd.mjs init --change <name> [--root <dir>]
//       the same check, then write .superpowers/sdd/<name>/progress.md with its one identity
//       line, `# SDD ledger — plan: <root>/openspec/changes/<name>/plan.md`, when it is missing;
//       an existing one is kept when it names this change's plan and refused otherwise
//       ({ ok, change, foreign, progress, written })
//   sdd.mjs brief --change <name> --task <N> [--root <dir>] [--home <dir>]
//       run the skill's task-brief for plan task N into
//       .superpowers/sdd/<name>/task-<N>-brief.md ({ ok, change, task, file, said, stray })
//   sdd.mjs package --change <name> --base <ref> --head <ref> [--root <dir>] [--home <dir>]
//       resolve both refs to commit ids and run the skill's review-package into
//       .superpowers/sdd/<name>/review-<base7>..<head7>.diff
//       ({ ok, change, base, head, file, said, stray })
//
// brief and package find the skill in the Superpowers install recorded for the main checkout
// (--home names the Claude Code home: default $CLAUDE_CONFIG_DIR, else ~/.claude) and run its
// script with `bash` named explicitly, in --root; on Windows that is Git Bash's bash, which must
// be on PATH. Anything a call wrote to the shared default `.superpowers/sdd/plan/` is moved into
// the change's workspace and listed in `stray` ({ from, to }).
//
// --root <dir> names the host project, for brief and package the change worktree (default: the
// current directory).
// Exit 0: done, or the workspace is clean ({ ok: true, ... }). Exit 1: a foreign or
// unidentifiable ledger, or a skill script that failed ({ ok: false, error, ... }). Exit 2: a
// wrong call ({ ok: false, error, usage }).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMain } from './lib/main.mjs'
import { brief, checkSddWorkspace, initSdd, reviewPackage, stopMessage } from './lib/sdd.mjs'

export const USAGE =
  'Usage:\n  sdd.mjs [init] --change <name> [--root <dir>]\n  sdd.mjs brief --change <name> --task <N> [--root <dir>] [--home <dir>]\n  sdd.mjs package --change <name> --base <ref> --head <ref> [--root <dir>] [--home <dir>]'

// A wrong call, as opposed to a foreign ledger: exit 2.
export class UsageError extends Error {}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

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
  const home = option(args, '--home')
  const task = option(args, '--task')
  const base = option(args, '--base')
  const head = option(args, '--head')
  const [command] = args
  if (!change) throw new UsageError('usage: sdd.mjs [init|brief|package] --change <name> [--root <dir>]')
  if (['init', 'brief', 'package'].includes(command)) {
    // A placeholder such as `<name>` once gave a false STOP; init would also write under it.
    if (!NAME.test(change)) throw new UsageError(`change name "${change}" is not kebab-case`)
  }
  if (command === 'init') return init(root, change)
  if (command === 'brief') {
    if (!task) throw new UsageError('brief needs --task <N>')
    return brief(root, change, task, { home })
  }
  if (command === 'package') {
    if (!base || !head) throw new UsageError('package needs --base <ref> and --head <ref>')
    return reviewPackage(root, change, base, head, { home })
  }
  const { ok, foreign } = checkSddWorkspace({
    changeName: change,
    read: (f) => readFileSync(join(root, f), 'utf8'),
    list: (d) => readdirSync(join(root, d))
  })
  if (ok) return { ok, change, foreign }
  return { ok, change, foreign, error: stopMessage(change, foreign).join(' ') }
}

// Kept for callers of the CLI module; the work is lib/sdd.mjs's initSdd.
export const init = initSdd

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
