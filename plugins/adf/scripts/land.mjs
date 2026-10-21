#!/usr/bin/env node
// CLI over lib/land.mjs: /adf:land, the hand-off of a change's tracker issues after its merge
// request is merged. Each step records its result in the main checkout's
// .superpowers/sdd/<change>/land/land.json, so a rerun resumes: a step done or skipped returns
// what it recorded, with `already`. Prints one JSON object on stdout; exit 1 on a refusal or a
// result with ok false, exit 2 on a usage error. --root is any checkout of the host (default: the
// current directory); --home names the Claude Code home where the plugins are found. Land never
// merges and never pushes.
//
//   land.mjs check --change <name>
//       the change's scope.json (the archived copy too), then the tracker's check. No scope, a
//       tracker skipped for the change, no taken or partial tracker issue, or no tracker plugin:
//       the whole land is skipped, with a line that says so, and every later step skips
//   land.mjs wait --change <name>
//       the forge's state of the merge request: merged is done (mergedAt, mergeCommit); open or
//       draft is waiting, to run again later; closed stops land (exit 1). With no forge, or one
//       that does not provide state, merged is decided from git ancestry with the local base
//   land.mjs comment-input --change <name>
//       one input file and one prompt per taken or partial tracker issue: { dispatches: [{ name,
//       key, state, agent, worktree, inputFile, promptFile, replyFile }] }; dispatch each as
//       `land-comment <KEY>`, read-only
//   land.mjs comment --change <name> --key <KEY> --file <reply json>
//       the reply checked against schema/land-comment.schema.json and the field rules
//       (lib/tracker.mjs checkFields), and recorded. { ok, valid, errors?, missing, next }
//   land.mjs handoff --change <name> [--yes]
//       refused until every issue has its fields. Without --yes the tracker's handoff plan and
//       its preview, held: { state: pending, held, plan, preview, report, waiting }; with it the
//       plan applied
//   land.mjs report --change <name>
//       read-only: { ok, complete, skipped, stopped, done, next, file, steps, report }
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkStep, commentInputStep, commentStep, handoffStep, landContext, Refusal, report, waitStep } from './lib/land.mjs'
import { isMain } from './lib/main.mjs'
import { claudeHome } from './lib/superpowers.mjs'

export const USAGE = `usage:
  land.mjs check|wait --change <name> [--root <dir>] [--home <dir>]
  land.mjs comment-input --change <name> [--root <dir>]
  land.mjs comment --change <name> --key <KEY> --file <reply json> [--root <dir>]
  land.mjs handoff --change <name> [--yes] [--root <dir>] [--home <dir>]
  land.mjs report --change <name> [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = {
  change: { type: 'string' },
  root: { type: 'string' },
  home: { type: 'string' },
  key: { type: 'string' },
  file: { type: 'string' },
  yes: { type: 'boolean' }
}
const TAKES = {
  check: ['home'],
  wait: ['home'],
  'comment-input': [],
  comment: ['key', 'file'],
  handoff: ['yes', 'home'],
  report: []
}
const usage = (message) => {
  throw new UsageError(`${message}\n${USAGE}`)
}

// deps: { now } as lib/land.mjs landContext takes it.
export function run(argv, { cwd = process.cwd(), deps = {} } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(`${error.message}\n${USAGE}`)
  }
  const { values, positionals } = parsed
  const [command, ...extra] = positionals
  if (!Object.hasOwn(TAKES, command ?? '') || extra.length > 0) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => !['change', 'root'].includes(k) && !TAKES[command].includes(k))
  if (stray.length > 0) usage(`${command} takes no --${stray[0]}`)
  if (!values.change) usage(`${command} needs --change <name>`)
  const ctx = landContext(resolve(cwd, values.root ?? '.'), values.change, { home: values.home ?? claudeHome(), ...deps })
  switch (command) {
    case 'check':
      return checkStep(ctx)
    case 'wait':
      return waitStep(ctx)
    case 'comment-input':
      return commentInputStep(ctx)
    case 'comment':
      if (!values.key || !values.file) usage('comment needs --key and --file')
      return commentStep(ctx, { key: values.key, file: resolve(cwd, values.file) })
    case 'handoff':
      return handoffStep(ctx, { yes: Boolean(values.yes) })
    default:
      return report(ctx)
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const isUsage = error instanceof UsageError
    const extra = error instanceof Refusal ? error.extra : {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...extra, ...(isUsage ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = isUsage ? 2 : 1
  }
}
