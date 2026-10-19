#!/usr/bin/env node
// CLI over lib/preflight.mjs: everything a phase checks before its first step of work, in one
// call. Prints one JSON object on stdout; exit 1 on a refusal, exit 2 on a usage error.
//
//   preflight.mjs --phase propose|apply|verify|review|archive --change <name> [--root <dir>] [--home <dir>]
//
// apply, verify, review and archive: --root is the change worktree. The Superpowers gate (read for the main
// checkout); the root is its working tree's top level and not the main checkout; the current
// branch is read without error, named, and not protected; the change exists there; its state
// (apply: plan done and tasks left; verify and review: their dependencies done). review also
// reads the verify record: its `Verdict:` line not FAIL, the record committed, and no commit
// after it touching a path outside the change directory (`verify`: { verdict, commit }). apply also runs the plan
// symbol check (--phase apply) and `sdd.mjs init`. archive needs the review artifact done and no
// uncommitted file outside the change directory, unless an archive is already under way
// (`archive`: { started, next }); a change already moved passes with `archived`, its path. On a
// pass the phase's session is recorded in the ledger.
//
// propose: --root is the main checkout. The gate; the root is the main checkout; the inputs of
// the branch policy from `workspace.mjs suggest` under `workspace`, with `exists` for a change
// already in flight; uncommitted tracked work refuses.
//
// --root defaults to the current directory; --home names the Claude Code home (default:
// $CLAUDE_CONFIG_DIR, else ~/.claude).
//
//   {"ok", "refusal"?, "phase", "change", "main", "root", "branch", "protected", "base", "state",
//    "progress", "sdd", "planFindings"?, "verify"?, "archive"?, "archived"?, "ledger", "workspace"?}
import { isMain } from './lib/main.mjs'
import { PHASES, preflight } from './lib/preflight.mjs'

export const USAGE = 'usage: preflight.mjs --phase propose|apply|verify|review|archive --change <name> [--root <dir>] [--home <dir>]'

export class UsageError extends Error {}

function parse(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--phase', '--change', '--root', '--home'].includes(arg)) throw new UsageError(`unexpected argument "${arg}"`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return values
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { phase, change, root = cwd, home } = parse(argv)
  if (!PHASES.includes(phase) || !change) throw new UsageError(USAGE)
  return preflight({ phase, change, root, home, env })
}

if (isMain(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
