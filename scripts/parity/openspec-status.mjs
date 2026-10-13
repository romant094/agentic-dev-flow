#!/usr/bin/env node
// Dev tool: compares the change engine (plugins/adf/scripts/lib/changes.mjs) with the openspec
// CLI on a copy of a project's openspec/ directory. Every archived change is copied in as an
// active one, so the corpus is every change the project ever made. Read-only on the source.
//
//   node scripts/parity/openspec-status.mjs <project root> [<schema name>]
//
// Compared: `status` (artifact status, missing dependencies, applyRequires, isComplete),
// `instructions apply` (state, progress, task list) and `list` (names, task counts, status).
// The schema names differ by design and are not compared. A change pinned to another schema
// than <schema name> (default sdd-plus-superpowers, the one this flow descends from) is skipped
// and counted.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyInstructions, changeStatus, listChanges } from '../../plugins/adf/scripts/lib/changes.mjs'
import { loadSchema } from '../../plugins/adf/scripts/lib/schema.mjs'

const source = process.argv[2]
const origin = process.argv[3] ?? 'sdd-plus-superpowers'
if (!source || !existsSync(join(source, 'openspec'))) {
  console.error('usage: openspec-status.mjs <project root with openspec/>')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'adf-parity-'))
cpSync(join(source, 'openspec'), join(root, 'openspec'), { recursive: true })
const changes = join(root, 'openspec', 'changes')
const archive = join(changes, 'archive')
if (existsSync(archive)) {
  for (const name of readdirSync(archive)) cpSync(join(archive, name), join(changes, `zz-${name}`), { recursive: true })
  rmSync(archive, { recursive: true })
}

const schema = loadSchema()
const openspec = (...args) => JSON.parse(execFileSync('openspec', [...args, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
const pick = (status) => ({
  artifacts: status.artifacts.map(({ id, status: s, missingDeps }) => ({ id, status: s, missingDeps: missingDeps ?? [] })),
  applyRequires: status.applyRequires,
  isComplete: status.isComplete
})
const pickApply = (a) => ({ state: a.state, progress: a.progress, tasks: a.tasks, missingArtifacts: a.missingArtifacts ?? [] })
const pickList = (l) => l.changes.map(({ name, completedTasks, totalTasks, status }) => ({ name, completedTasks, totalTasks, status })).sort((a, b) => a.name.localeCompare(b.name))

const differences = []
// No metadata file: openspec falls back to the project config's schema, assumed to be <schema name>.
const pinned = (name) => {
  const meta = join(changes, name, '.openspec.yaml')
  return existsSync(meta) ? /^schema:\s*(\S+)/m.exec(readFileSync(meta, 'utf8'))?.[1] : origin
}
const all = readdirSync(changes, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
const names = all.filter((name) => pinned(name) === origin)
const skipped = all.filter((name) => pinned(name) !== origin).map((name) => ({ name, schema: pinned(name) }))
for (const name of names) {
  const theirs = pick(openspec('status', '--change', name))
  const ours = pick(changeStatus(root, name, schema))
  if (!isDeepStrictEqual(theirs, ours)) differences.push({ name, command: 'status', theirs, ours })
  const theirApply = pickApply(openspec('instructions', 'apply', '--change', name))
  const ourApply = pickApply(applyInstructions(root, name, schema))
  if (!isDeepStrictEqual(theirApply, ourApply)) differences.push({ name, command: 'instructions apply', theirs: theirApply, ours: ourApply })
}
const theirList = pickList(openspec('list'))
const ourList = pickList(listChanges(root, schema))
// list does not read the schema's graph, so every change is compared there.
if (!isDeepStrictEqual(theirList, ourList)) differences.push({ command: 'list', theirs: theirList, ours: ourList })

console.log(JSON.stringify({ compared: names.length, skipped, differences }, null, 2))
rmSync(root, { recursive: true })
process.exitCode = differences.length === 0 ? 0 : 1
