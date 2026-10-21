#!/usr/bin/env node
// CLI over lib/provision.mjs: the `provision` hook of the ADF contract for an npm-workspaces
// monorepo.
//
//   provision.mjs provision          (payload on stdin)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done or refused. Exit codes: 0 done, 1 refused.
import { readFileSync } from 'node:fs'
import { runOperation } from './lib/provision.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: provision.mjs provision  (payload on stdin)'
const NOTHING_DONE = 'nothing was provisioned'

export function main(argv, readStdin, deps = {}) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  if (rest.length !== 0) return refuse(`${USAGE}; ${NOTHING_DONE}.`)
  let payload
  try {
    payload = JSON.parse(readStdin())
  } catch {
    return refuse(`the input is not valid JSON; ${NOTHING_DONE}.`)
  }
  return runOperation(operation, payload, deps)
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: `${error.message}; node_modules may be provisioned only in part.` } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
