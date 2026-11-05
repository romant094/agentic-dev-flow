#!/usr/bin/env node
// CLI over lib/quick.mjs: the quick task's large-item filter and estimate, run in the main
// checkout before the change's branch is made. Prints one JSON object on stdout; exit 1 on a
// refusal or a result with ok false, exit 2 on a usage error. --root is any checkout of the host
// (default: the current directory); the state lives in the main checkout's
// .superpowers/sdd/<change>/quick/.
//
//   quick.mjs filter --change <name>
//       excludes each large candidate of the change's scope as `scope.mjs select --exclude`
//       does: a tracker epic or story, a debt entry that is not a defect, a debt entry anchored in
//       more than 3 files. A key the developer named is flagged, never excluded.
//       { ok, excluded, flagged, candidates, next }
//   quick.mjs estimate-input --change <name>
//       writes the prompt, the candidates and the reply schema of the read-only quick-estimate
//       dispatch. { ok, file, name, candidates, replyFile, ... }
//   quick.mjs estimate-check --change <name> --file <reply json>
//       the reply checked against schema/quick-estimate.schema.json and the script's rules; the
//       verdicts of the tracker issues recorded as `scope.mjs answer --verdict` does; the reply
//       stored as estimate.json. { ok, valid, errors?, items, next }; a refusal is exit 1
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isMain } from './lib/main.mjs'
import { detectRuntime } from './lib/runtime.mjs'
import { estimateCheck, estimateInput, filter, Refusal } from './lib/quick.mjs'

export const USAGE = `usage:
  quick.mjs filter --change <name> [--root <dir>]
  quick.mjs estimate-input --change <name> [--root <dir>]
  quick.mjs estimate-check --change <name> --file <reply json> [--root <dir>]`

export class UsageError extends Error {}

const OPTIONS = {
  change: { type: 'string' },
  root: { type: 'string' },
  file: { type: 'string' }
}
const TAKES = { filter: [], 'estimate-input': [], 'estimate-check': ['file'] }
const usage = (message) => {
  throw new UsageError(`${message}\n${USAGE}`)
}

export function run(argv, { cwd = process.cwd(), env = process.env, runtime = detectRuntime({ env, scriptPath: fileURLToPath(import.meta.url) }) } = {}) {
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
  const root = resolve(cwd, values.root ?? '.')
  switch (command) {
    case 'filter':
      return filter(root, values.change)
    case 'estimate-input':
      return estimateInput(root, values.change, { runtime })
    default:
      if (!values.file) usage('estimate-check needs --file')
      return estimateCheck(root, values.change, { file: resolve(cwd, values.file) })
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
