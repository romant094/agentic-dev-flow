#!/usr/bin/env node
// CLI over lib/prepare.mjs, the worktree preparation recipe of `openspec/planning.md`. Prints one
// JSON object on stdout; exit 1 on a refusal or a failed step, 2 on a usage error.
//
//   prepare.mjs recipe [--root <dir>]
//       the recipe's steps: { file, steps: [{ command, inputs }] }
//   prepare.mjs candidates [--root <dir>]
//       the steps /adf:init offers the developer, from the package manifest and the workspace
//       layout: { candidates: [{ command, inputs, why }] }; nothing is written
//   prepare.mjs add --command "<cmd>" --input <path> [--input <path> ...] [--root <dir>]
//       write one confirmed step under `## Worktree preparation`, replacing the step of the
//       same command, creating the file or the section when absent: { file, steps }
//   prepare.mjs run [--worktree <dir>] [--root <dir>] [--force]
//       run in <worktree> (default <root>) each step whose inputs changed since its last run
//       there, the recipe read from <root>; --force runs every step:
//       { ok, worktree, ran, skipped, report, error? }
import { join, resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { addStep, candidates, prepareWorktree, readRecipe } from './lib/prepare.mjs'

export const USAGE =
  'usage: prepare.mjs recipe [--root <dir>] | prepare.mjs candidates [--root <dir>] | prepare.mjs add --command "<cmd>" --input <path> [--input <path> ...] [--root <dir>] | prepare.mjs run [--worktree <dir>] [--root <dir>] [--force]'

export class UsageError extends Error {}

const VALUED = ['--root', '--command', '--worktree']
const FLAGS = ['--force']
const ALLOWED = { recipe: [], candidates: [], add: ['command', 'input'], run: ['worktree', 'force'] }

function parse(argv) {
  const values = { input: [] }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (FLAGS.includes(arg)) {
      values[arg.slice(2)] = true
      continue
    }
    if (arg !== '--input' && !VALUED.includes(arg)) {
      if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (arg === '--input') values.input.push(value)
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(ALLOWED, sub)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && !(k === 'input' && values.input.length === 0) && !ALLOWED[sub].includes(k))
  if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  const root = resolve(cwd, values.root ?? '.')
  switch (sub) {
    case 'recipe':
      return { file: join(root, 'openspec', 'planning.md'), steps: readRecipe(root) }
    case 'candidates':
      return { candidates: candidates(root) }
    case 'add':
      if (!values.command) throw new UsageError('add needs --command')
      if (values.input.length === 0) throw new UsageError('add needs at least one --input')
      return addStep(root, { command: values.command, inputs: values.input })
    case 'run':
      return prepareWorktree(resolve(cwd, values.worktree ?? root), { guideRoot: root, force: Boolean(values.force) })
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
