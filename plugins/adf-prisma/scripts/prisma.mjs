#!/usr/bin/env node
// CLI over lib/prisma.mjs: the `provision` and `verify-check` hooks of the ADF contract.
//
//   prisma.mjs provision|verify-check          (payload on stdin)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done or refused. Exit codes: 0 done, 1 refused.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runOperation } from './lib/prisma.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: prisma.mjs provision|verify-check  (payload on stdin)'

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') }
}

export function main(argv, readStdin, ctx = { run }) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  if (rest.length !== 0) return refuse(USAGE)
  let payload
  try {
    payload = JSON.parse(readStdin())
  } catch {
    return refuse('the input is not valid JSON')
  }
  return runOperation(operation, payload, ctx)
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: error.message } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
