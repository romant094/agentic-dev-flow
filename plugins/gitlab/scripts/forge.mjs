#!/usr/bin/env node
// CLI over lib/forge.mjs: the `forge` role of the ADF contract on GitLab.
//
//   forge.mjs check|open|finalize                      (payload on stdin)
//   forge.mjs finalize --input-file <path>             (payload from a file)
//
// The payload is one JSON object, { root, config, input }; the result is one JSON object on
// stdout with `state` done, degraded or refused. Exit codes: 0 done or degraded, 1 refused.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOperation } from './lib/forge.mjs'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: forge.mjs check|open|finalize [--input-file <path>]  (payload on stdin otherwise)'
const NOTHING_SENT = 'nothing was pushed and no merge request was touched'

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') }
}

// Outside the repository, so an untracked file never blocks a worktree removal.
const saveInput = (payload) => {
  const file = join(mkdtempSync(join(tmpdir(), 'adf-forge-')), 'finalize.json')
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

export function main(argv, readStdin) {
  const refuse = (error) => ({ code: 1, result: { state: 'refused', error } })
  const [operation, ...rest] = argv
  let text
  if (rest.length === 0) text = readStdin()
  else if (rest.length === 2 && rest[0] === '--input-file') text = readFileSync(rest[1], 'utf8')
  else return refuse(`${USAGE}; ${NOTHING_SENT}.`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return refuse(`the input is not valid JSON; ${NOTHING_SENT}.`)
  }
  return runOperation(operation, payload, {
    run,
    platform: process.platform,
    pluginDir,
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    saveInput
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let outcome
  try {
    outcome = main(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  } catch (error) {
    outcome = { code: 1, result: { state: 'refused', error: `${error.message}; ${NOTHING_SENT}.` } }
  }
  process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`)
  process.exitCode = outcome.code
}
