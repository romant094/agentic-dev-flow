#!/usr/bin/env node
// CLI over lib/commit.mjs: every commit the flow makes. Prints one JSON object on stdout; exit 1
// on a refusal, exit 2 on a usage error.
//
//   commit.mjs --root <change worktree> --only <path> [--only <path> ...] --message <message>
//
// Stages only the given paths (relative to --root, or absolute inside it), refuses when anything
// else is staged, on a protected branch, on a detached HEAD and in the main checkout, then
// commits those paths alone. --root defaults to the current directory. The message is used as
// given; nothing is appended to it.
//
//   {"ok":true,"commit":"<sha>","branch":"<branch>","files":["<path>", ...]}
//   {"ok":false,"error":"<the refusal>"}
import { isMain } from './lib/main.mjs'
import { commitPaths } from './lib/commit.mjs'

export const USAGE = 'usage: commit.mjs --root <dir> --only <path> [--only <path> ...] --message <message>'

export class UsageError extends Error {}

function parse(argv) {
  const values = { only: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--root', '--only', '--message'].includes(arg)) throw new UsageError(`unexpected argument "${arg}"`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (arg === '--only') values.only.push(value)
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  return values
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { root = cwd, only, message } = parse(argv)
  if (only.length === 0 || message === undefined) throw new UsageError(USAGE)
  return commitPaths(root, { only, message })
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
