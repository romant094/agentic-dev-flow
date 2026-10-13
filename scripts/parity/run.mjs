#!/usr/bin/env node
// Runs every parity tool against the origin project and prints one line per tool. Run after
// every iteration; each ported script gets a tool here.
//
//   npm run parity -- <origin project root>      (or ADF_ORIGIN=<root> npm run parity)
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const origin = process.argv[2] ?? process.env.ADF_ORIGIN
if (!origin) {
  console.error('usage: npm run parity -- <origin project root>, or set ADF_ORIGIN')
  process.exit(2)
}

let failed = 0
for (const tool of readdirSync(here).filter((f) => f.startsWith('openspec-') || f.startsWith('origin-')).sort()) {
  const run = spawnSync('node', [join(here, tool), origin], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (run.status !== 0) failed++
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${tool}${run.status === 0 ? '' : `\n${run.stdout.slice(-2000)}${run.stderr.slice(-2000)}`}`)
}
process.exitCode = failed === 0 ? 0 : 1
