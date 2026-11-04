#!/usr/bin/env node
// CLI over lib/init.mjs and lib/window.mjs `seedWindow`: what /adf:init infers and writes beyond
// the registry. Prints one JSON object on stdout; exit 1 on a refusal, 2 on a usage error.
// Nothing is committed.
//
//   init.mjs suggest [--root <dir>]
//       what the planning guide holds and what init offers: { suite: { current, candidates:
//       [{ command, source, why }] }, copies: { current, candidates } }. The suite candidates come
//       from the CI configuration, then the package scripts; the copy candidates are the `.env*`
//       files git ignores in the main checkout. Nothing is written; `suite.mjs set` writes a
//       confirmed command. `trustHooks` is true in Codex, which runs a hook only after the
//       developer trusts it in `/hooks`
//   init.mjs copies --path <p> [--path <p> ...] [--root <dir>]
//       add confirmed paths to `## Worktree copies`, creating the guide or the section when
//       absent: { file, copies }
//   init.mjs seed [--date YYYY-MM-DD] [--root <dir>]
//       after the branch policy is set: write the window marker `.adf/retro/<date>-window.json`
//       whose cut-off is the integration ref's tip, so the changes archived before ADF do not
//       count toward the first window or the corpus lint: { seeded, ref, path?, cutoff?,
//       archivedBefore?, reason? }
//   init.mjs scan [--root <dir>]
//       the lines of the host's agent instruction files that name a previous flow's commands;
//       changes nothing: { mentions: [{ file, line, text, kinds }], report }
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyCandidates, oldFlowMentions, oldFlowReport, suiteCandidates, writeCopies } from './lib/init.mjs'
import { isMain } from './lib/main.mjs'
import { detectRuntime } from './lib/runtime.mjs'
import { readCopies } from './lib/provision.mjs'
import { readCommand } from './lib/suite.mjs'
import { seedWindow } from './lib/window.mjs'

export const USAGE = 'usage: init.mjs suggest [--root <dir>] | init.mjs copies --path <p> [--path <p> ...] [--root <dir>] | init.mjs seed [--date YYYY-MM-DD] [--root <dir>] | init.mjs scan [--root <dir>]'

export class UsageError extends Error {}

const ALLOWED = { suggest: [], copies: ['path'], seed: ['date'], scan: [] }

function parse(argv) {
  const values = { path: [] }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--root', '--path', '--date'].includes(arg)) {
      if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (arg === '--path') values.path.push(value)
    else if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    else values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

export function run(argv, { cwd = process.cwd(), env = process.env, runtime = detectRuntime({ env, scriptPath: fileURLToPath(import.meta.url) }) } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(ALLOWED, sub)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && !(k === 'path' && values.path.length === 0) && !ALLOWED[sub].includes(k))
  if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  const root = resolve(cwd, values.root ?? '.')
  switch (sub) {
    case 'suggest':
      return {
        suite: { current: readCommand(root).command, candidates: suiteCandidates(root) },
        copies: { current: readCopies(root), candidates: copyCandidates(root) },
        trustHooks: runtime === 'codex'
      }
    case 'copies':
      if (values.path.length === 0) throw new UsageError('copies needs at least one --path')
      return writeCopies(root, values.path)
    case 'seed':
      return seedWindow(root, values.date ? { date: values.date } : {})
    case 'scan': {
      const mentions = oldFlowMentions(root)
      return { mentions, report: oldFlowReport(mentions) }
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
