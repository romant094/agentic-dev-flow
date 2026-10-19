#!/usr/bin/env node
// Dev tool, not part of the plugin: writes each case's expected.md or error.txt from openspec
// 1.5.0's own buildUpdatedSpec.
//
//   node freeze.mjs <openspec dist dir>
//
// The fixtures were frozen with the openspec 1.5.0 installed globally:
//   node freeze.mjs "$(npm root -g)/@fission-ai/openspec/dist"
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASES_DIR, listCases, openspecBuild } from './cases.mjs'

const dist = process.argv[2]
if (!dist) {
  process.stderr.write('usage: node freeze.mjs <openspec dist dir>\n')
  process.exit(2)
}
for (const name of listCases()) {
  const result = await openspecBuild(dist, name)
  rmSync(join(CASES_DIR, name, 'expected.md'), { force: true })
  rmSync(join(CASES_DIR, name, 'error.txt'), { force: true })
  if (result.error !== undefined) writeFileSync(join(CASES_DIR, name, 'error.txt'), `${result.error}\n`)
  else writeFileSync(join(CASES_DIR, name, 'expected.md'), result.rebuilt)
  process.stdout.write(`${name}: ${result.error !== undefined ? 'error' : 'rebuilt'}\n`)
}
