#!/usr/bin/env node
// CLI over lib/postgres.mjs: the `provision` and `teardown` hooks of the ADF contract for
// PostgreSQL.
//
//   postgres.mjs provision|teardown          (payload on stdin)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done, degraded or refused. Exit codes: 0 done or degraded, 1 refused.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runOperation } from './lib/postgres.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: postgres.mjs provision|teardown  (payload on stdin)'
const NOTHING_DONE = 'nothing was done'

// `env` is added to this process's environment: the password reaches psql only there.
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') }
}

export function main(argv, readStdin) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  if (rest.length !== 0) return refuse(`${USAGE}; ${NOTHING_DONE}.`)
  let payload
  try {
    payload = JSON.parse(readStdin())
  } catch {
    return refuse(`the input is not valid JSON; ${NOTHING_DONE}.`)
  }
  return runOperation(operation, payload, { run })
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: `${error.message}; ${NOTHING_DONE}.` } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
