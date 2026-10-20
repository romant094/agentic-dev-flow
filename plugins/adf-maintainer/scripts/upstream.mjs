#!/usr/bin/env node
// CLI over lib/upstream.mjs: the `upstream` role of the ADF contract on GitHub.
//
//   upstream.mjs check|file          (payload on stdin)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done, degraded or refused. Exit codes: 0 done or degraded, 1 refused.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runOperation } from './lib/upstream.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: upstream.mjs check|file  (payload on stdin)'
const NOTHING_SENT = 'nothing was sent'

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') }
}

export function main(argv, readStdin) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  if (rest.length !== 0) return refuse(`${USAGE}; ${NOTHING_SENT}.`)
  let payload
  try {
    payload = JSON.parse(readStdin())
  } catch {
    return refuse(`the input is not valid JSON; ${NOTHING_SENT}.`)
  }
  return runOperation(operation, payload, { run, platform: process.platform })
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: `${error.message}; ${NOTHING_SENT}.` } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
