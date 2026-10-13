#!/usr/bin/env node
// Dev tool: compares the Superpowers gate (plugins/adf/scripts/lib/superpowers.mjs) with the
// origin's .claude/scripts/check-superpowers.mjs. The origin module is imported, never run, and
// nothing is written in the origin project.
//
//   node scripts/parity/origin-superpowers.mjs <origin project root>
//
// Two corpora: every combination of generated install records and settings layers, and the
// real Claude Code state of this machine evaluated for the origin root and each of its
// worktrees. Each difference must be one the lessons file records as deliberate:
//   local-settings   .claude/settings.local.json now counts (the origin did not read it)
//   foreign-project  a project- or local-scope record of another project no longer counts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claudeHome, isAvailable, mergeSettings, PLUGIN_ID } from '../../plugins/adf/scripts/lib/superpowers.mjs'

const origin = process.argv[2]
const originGate = origin && join(origin, '.claude', 'scripts', 'check-superpowers.mjs')
if (!originGate || !existsSync(originGate)) {
  console.error('usage: origin-superpowers.mjs <origin project root with .claude/scripts/check-superpowers.mjs>')
  process.exit(2)
}
const theirs = await import(pathToFileURL(originGate).href)

const host = '/work/host'
const record = (scope, path, projectPath) => ({ scope, installPath: path, ...(projectPath ? { projectPath } : {}) })
const recordSets = {
  none: null,
  empty: [],
  user: [record('user', '/on-disk')],
  'user-gone': [record('user', '/gone')],
  'project-own': [record('project', '/on-disk', host)],
  'project-other': [record('project', '/on-disk', '/work/other')],
  'local-other': [record('local', '/on-disk', '/work/other')],
  'other-and-user-gone': [record('project', '/on-disk', '/work/other'), record('user', '/gone')],
  'gone-and-user': [record('user', '/gone'), record('user', '/on-disk')]
}
const flags = { unset: undefined, on: true, off: false }
const layer = (value) => (value === undefined ? null : { enabledPlugins: { [PLUGIN_ID]: value } })
const exists = (path) => path === '/on-disk'

// A difference is explained when undoing exactly one deliberate change in our gate makes it
// agree with the origin: counting every record as user scope (foreign-project), or not
// reading the local layer (local-settings).
const asUser = (installed) =>
  installed && { ...installed, plugins: { [PLUGIN_ID]: (installed.plugins?.[PLUGIN_ID] ?? []).map((r) => ({ ...r, scope: 'user' })) } }

function explain(their, { installedPlugins, user, project, local, exists: on, root }) {
  const run = (records, layers) => isAvailable({ installedPlugins: records, settings: mergeSettings(...layers), exists: on, root }).ok
  const reasons = []
  if (run(asUser(installedPlugins), [user, project, local]) === their.ok) reasons.push('foreign-project')
  if (run(installedPlugins, [user, project]) === their.ok) reasons.push('local-settings')
  if (reasons.length === 0 && run(asUser(installedPlugins), [user, project]) === their.ok) reasons.push('foreign-project+local-settings')
  return reasons.length > 0 ? reasons.join('|') : null
}

const differences = []
let compared = 0
for (const [name, records] of Object.entries(recordSets)) {
  const installedPlugins = records === null ? null : { version: 2, plugins: { [PLUGIN_ID]: records } }
  for (const user of Object.values(flags)) for (const project of Object.values(flags)) for (const local of Object.values(flags)) {
    compared++
    const their = theirs.isAvailable({ installedPlugins, settings: theirs.mergeSettings(layer(user), layer(project)), exists })
    const ours = isAvailable({ installedPlugins, settings: mergeSettings(layer(user), layer(project), layer(local)), exists, root: host })
    if (their.ok === ours.ok) continue
    const explained = explain(their, { installedPlugins, user: layer(user), project: layer(project), local: layer(local), exists, root: host })
    differences.push({ case: { records: name, user, project, local }, theirs: their.ok, ours: ours.ok, reason: ours.reason, explained })
  }
}

// The real state of this machine, for the origin and each of its worktrees.
const home = claudeHome()
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const installedPlugins = readJson(join(home, 'plugins', 'installed_plugins.json'))
const worktrees = join(origin, '.claude', 'worktrees')
const roots = [origin, ...(existsSync(worktrees) ? readdirSync(worktrees, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(worktrees, d.name)) : [])]
const machine = []
for (const root of roots.map((r) => resolve(r))) {
  const user = readJson(join(home, 'settings.json'))
  const project = readJson(join(root, '.claude', 'settings.json'))
  const local = readJson(join(root, '.claude', 'settings.local.json'))
  const their = theirs.isAvailable({ installedPlugins, settings: theirs.mergeSettings(user, project), exists: existsSync })
  const ours = isAvailable({ installedPlugins, settings: mergeSettings(user, project, local), exists: existsSync, root })
  machine.push({ root, theirs: their.ok, ours: ours.ok })
  if (their.ok !== ours.ok) {
    const explained = explain(their, { installedPlugins, user, project, local, exists: existsSync, root })
    differences.push({ case: { root }, theirs: their.ok, ours: ours.ok, reason: ours.reason, explained })
  }
}

const unexplained = differences.filter((d) => d.explained === null)
const byReason = {}
for (const d of differences) if (d.explained) byReason[d.explained] = (byReason[d.explained] ?? 0) + 1
console.log(JSON.stringify({
  compared,
  machineRoots: machine.length,
  differences: differences.length,
  machine,
  explained: byReason,
  unexplained
}, null, 2))
process.exitCode = unexplained.length === 0 ? 0 : 1
