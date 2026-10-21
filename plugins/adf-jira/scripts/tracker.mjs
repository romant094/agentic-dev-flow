#!/usr/bin/env node
// CLI over lib/tracker.mjs: the `tracker` role of the ADF contract on Jira.
//
//   tracker.mjs check|gather|start|handoff          (payload on stdin)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done, degraded or refused. Exit codes: 0 done or degraded, 1 refused.
// The env file is read inside this process; no result carries a secret.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOperation } from './lib/tracker.mjs'
import { isMain } from './lib/main.mjs'

const USAGE = 'usage: tracker.mjs check|gather|start|handoff  (payload on stdin)'
const NOTHING_SENT = 'nothing was sent'
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function main(argv, readStdin, deps = {}) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  if (operation === undefined || rest.length !== 0) return refuse(`${USAGE}; ${NOTHING_SENT}.`)
  let payload
  try {
    payload = JSON.parse(readStdin())
  } catch {
    return refuse(`the input is not valid JSON; ${NOTHING_SENT}.`)
  }
  return runOperation(operation, payload, {
    fetch: globalThis.fetch,
    home: homedir(),
    processEnv: process.env,
    now: () => new Date(),
    pluginRoot: PLUGIN_ROOT,
    ...deps
  })
}

if (isMain(import.meta.url)) {
  let outcome
  try {
    outcome = await main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: `${error.message}; ${NOTHING_SENT}.` } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
