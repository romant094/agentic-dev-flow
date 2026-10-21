#!/usr/bin/env node
// CLI over lib/plan.mjs. Prints one JSON object on stdout.
//
//   plan.mjs lint --change <name> [--root <dir>]
//       { ok, testFirst, tasks, findings }: plan.md against tasks.md, the task fields, the
//       design risks, the Execution Graph and the Delete sweep. Exit 1 on an error finding;
//       warnings (cross-package span, an export named elsewhere, a `**Needs:**` word with no
//       provision plugin in the registry) do not fail.
//   plan.mjs graph --change <name> --groups "A=1,2;B=3" [--depends "C=A,B"]
//                  [--coupling '{"A/B":{"coupling":"medium","criticality":"low","reason":"…"}}'] [--write]
//       The Execution Graph of the partition the agent chose: Files union per group, the
//       coupling floor per pair, waves and dependencies. Without --write it prints the graph
//       and the table text; with --write it puts the tables into plan.md. Exit 1 on a refusal:
//       a task in no group or two, a floor lowered, a medium pair with no criticality, a third
//       tier, or (with --write) a pair whose weak-or-medium floor no --coupling decision settles.
//   plan.mjs schedule --change <name> [--root <dir>] [--cap 3]
//       { single, cap, groups: [{ n, letter, tasks, wave, dependsOn, done, merged, kept, state }],
//       startNow, waiting }. Exit 1 when the graph is missing or defective.
//   plan.mjs unplanned --change <name> [--root <dir>]
//       { files: [{ file, verb, commits, owner, votes }] }: files base..HEAD touched that no task
//       names, with the task that owns each. Exit 0 either way; `files` empty is the pass.
//   plan.mjs added --change <name> --path <p> --why <text> [--task <N>] [--verb <Verb>]
//                  [--date YYYY-MM-DD] [--root <dir>] [--commit]
//       Appends the "Added during apply" bullet to the owning task's Files block. Without
//       --task the owner is the one `unplanned` proposes; none is a refusal. --commit then
//       commits plan.md alone through lib/commit.mjs, with the message
//       "docs(openspec): record work added during apply to <change>" (`commit`: its sha, or
//       null when plan.md was already committed); without it the next tick commits the plan.
//
// Exit 2 on a usage error.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { changeDir, inferChange } from './lib/changes.mjs'
import { commitPaths } from './lib/commit.mjs'
import { PLANNING_GUIDE } from './lib/host-files.mjs'
import { groupState } from './lib/groups.mjs'
import { isMain } from './lib/main.mjs'
import {
  addDuringApply,
  addedMessage,
  computeGraph,
  DEFAULT_CAP,
  lintPlanText,
  parseDependsSpec,
  parseGroupsSpec,
  parsePlan,
  parseTaskItems,
  renderGraph,
  schedule,
  sweepDeletes,
  testFirst,
  unplannedIn,
  writeGraph
} from './lib/plan.mjs'
import { CORE, hookProviders } from './lib/roles.mjs'
import { loadSchema } from './lib/schema.mjs'
import { claudeHome } from './lib/superpowers.mjs'
import { gitIn } from './lib/workspace.mjs'

const USAGE = 'usage: plan.mjs lint|graph|schedule|unplanned|added [--change <name>] [--root <dir>] (see the header for each command; without --change, the one active change under the root)'

class Usage extends Error {}
class Refusal extends Error {}

function options(argv, flags, switches = []) {
  const args = [...argv]
  const command = args.shift()
  const out = {}
  while (args.length) {
    const flag = args.shift()
    const name = flag.replace(/^--/, '')
    if (switches.includes(name)) out[name] = true
    else if (flags.includes(name)) {
      const value = args.shift()
      if (value === undefined || value.startsWith('--')) throw new Usage(`${flag} needs a value`)
      out[name] = value
    } else throw new Usage(`unknown argument ${flag}`)
  }
  const root = resolve(out.root ?? process.cwd())
  // Without --change: the one active change under the root (lib/changes.mjs inferChange).
  if (!out.change) out.change = inferChange(root, undefined, loadSchema())
  return { command, ...out, root }
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
const rel = (change, file) => `openspec/changes/${change}/${file}`

function changeFiles(root, change) {
  const dir = changeDir(root, change)
  if (!existsSync(dir)) throw new Refusal(`no change "${change}" in ${root}/openspec/changes`)
  const planPath = join(dir, 'plan.md')
  const planText = read(planPath)
  if (planText === null) throw new Refusal(`${rel(change, 'plan.md')} does not exist`)
  const tracks = loadSchema().apply?.tracks ?? 'tasks.md'
  return { dir, planPath, planText, tracks, tasksText: read(join(dir, tracks)) }
}

// `git grep` over the tracked tree, the change records excluded. Exit 1 is "no match".
function grepIn(root) {
  return async ({ fixed, word }) => {
    const args = ['grep', '-l', '-F', ...(word ? ['-w'] : []), ...fixed.flatMap((p) => ['-e', p]), '--', '.', ':!openspec/changes', ':!.superpowers']
    try {
      return gitIn(root)(...args).split('\n').filter(Boolean)
    } catch (error) {
      if (error.status === 1) return []
      throw error
    }
  }
}

// Whether the registry holds a `provision` provider, enabled or absent; an unreadable registry
// holds none.
function provisioned(root) {
  try {
    const { plugins, absent } = hookProviders(root, 'provision', { ...CORE, home: claudeHome() })
    return plugins.length + absent.length > 0
  } catch {
    return false
  }
}

async function lint(o) {
  const { planText, tasksText, tracks, dir } = changeFiles(o.root, o.change)
  const { tasks, findings } = lintPlanText({
    provisioned: provisioned(o.root),
    planText,
    tasksText,
    designText: read(join(dir, 'design.md')),
    guideText: read(join(o.root, PLANNING_GUIDE)),
    planFile: rel(o.change, 'plan.md'),
    tasksFile: rel(o.change, tracks),
    designFile: rel(o.change, 'design.md')
  })
  if (tasksText === null) findings.push({ severity: 'error', kind: 'no-tasks-file', file: rel(o.change, tracks), line: null, message: `${rel(o.change, tracks)} does not exist` })
  const swept = await sweepDeletes(tasks, { grep: grepIn(o.root), read: (p) => readFileSync(join(o.root, p), 'utf8') })
  findings.push(...swept.map((f) => ({ ...f, file: rel(o.change, 'plan.md') })))
  const ok = !findings.some((f) => f.severity === 'error')
  return { code: ok ? 0 : 1, result: { ok, testFirst: testFirst(tasks), tasks: tasks.map((t) => ({ number: t.number, implements: t.implements, level: t.level })), findings } }
}

function graph(o) {
  if (!o.groups) throw new Usage('--groups is required, such as "A=1,2;B=3"')
  const { planText, planPath } = changeFiles(o.root, o.change)
  let spec, depends, coupling
  try {
    spec = parseGroupsSpec(o.groups)
    depends = parseDependsSpec(o.depends)
    coupling = o.coupling ? JSON.parse(o.coupling) : {}
  } catch (error) {
    throw new Usage(error.message)
  }
  const { tasks } = parsePlan(planText)
  const g = computeGraph(tasks, spec, { depends, coupling })
  const groups = g.groups.map(({ letter, tasks: t, files, wave, dependsOn }) => ({ letter, tasks: t, files, wave, dependsOn }))
  const pairs = g.pairs.map(({ a, b, floor, shared, coupling: c, criticality, reason }) => ({ a, b, floor, shared, coupling: c, ...(criticality ? { criticality } : {}), reason }))
  const errors = [...g.errors, ...(o.write ? g.undecided.map((p) => `pair ${p}: the floor is weak-or-medium; decide weak or medium in --coupling`) : [])]
  const table = renderGraph(g)
  const result = { ok: errors.length === 0, groups, pairs, undecided: g.undecided, errors, table, written: false }
  if (result.ok && o.write) {
    writeFileSync(planPath, writeGraph(planText, table))
    result.written = true
  }
  return { code: result.ok ? 0 : 1, result }
}

function changeBranch(root) {
  try {
    return gitIn(root)('branch', '--show-current')
  } catch {
    return ''
  }
}

function scheduleCmd(o) {
  const cap = o.cap === undefined ? DEFAULT_CAP : Number(o.cap)
  if (!Number.isInteger(cap) || cap < 1) throw new Usage('--cap must be a positive integer')
  const { planText, tasksText } = changeFiles(o.root, o.change)
  const branch = changeBranch(o.root)
  const items = parseTaskItems(tasksText ?? '')
  // A group is merged when the change branch holds its branch's merge commit (lib/groups.mjs).
  const state = groupState(o.root, o.change)
  const result = schedule(planText, { state, ticked: (id) => items.some((i) => i.id === id && i.done), cap })
  return { code: result.ok ? 0 : 1, result: { ...result, branch, root: o.root } }
}

function unplanned(root, change, planText) {
  try {
    return unplannedIn(root, change, planText)
  } catch (error) {
    throw new Refusal(error.message)
  }
}

function unplannedCmd(o) {
  const { planText } = changeFiles(o.root, o.change)
  return { code: 0, result: { ok: true, ...unplanned(o.root, o.change, planText) } }
}

function added(o) {
  if (!o.path || !o.why) throw new Usage('--path and --why are required')
  const { planText, planPath } = changeFiles(o.root, o.change)
  let task = o.task === undefined ? undefined : Number(o.task)
  if (task !== undefined && !Number.isInteger(task)) throw new Usage('--task must be a task number')
  let verb = o.verb
  if (task === undefined || verb === undefined) {
    const found = unplanned(o.root, o.change, planText).files.find((f) => f.file === o.path)
    if (task === undefined) {
      if (!found?.owner) throw new Refusal(`no task owns ${o.path} by the commits that touched it; pass --task`)
      task = found.owner
    }
    verb ??= found?.verb ?? 'Modify'
  }
  const date = o.date ?? new Date().toISOString().slice(0, 10)
  let out
  try {
    out = addDuringApply(planText, { task, path: o.path, why: o.why, verb, date })
  } catch (error) {
    throw new Refusal(error.message)
  }
  if (out.added) writeFileSync(planPath, out.text)
  const result = { ok: true, task, added: out.added, line: out.line, bullet: out.bullet }
  if (o.commit) {
    const path = rel(o.change, 'plan.md')
    const dirty = gitIn(o.root)('status', '--porcelain', '--', path) !== ''
    result.commit = dirty ? commitPaths(o.root, { only: [path], message: addedMessage(o.change) }).commit : null
  }
  return { code: 0, result }
}

export async function run(argv) {
  try {
    const command = argv[0]
    const spec = {
      lint: [['root'], []],
      graph: [['root', 'groups', 'depends', 'coupling'], ['write']],
      schedule: [['root', 'cap'], []],
      unplanned: [['root'], []],
      added: [['root', 'path', 'why', 'task', 'verb', 'date'], ['commit']]
    }[command]
    if (!spec) throw new Usage(`unknown command "${command ?? ''}"`)
    const o = options(argv, ['change', ...spec[0]], spec[1])
    if (command === 'lint') return await lint(o)
    if (command === 'graph') return graph(o)
    if (command === 'schedule') return scheduleCmd(o)
    if (command === 'unplanned') return unplannedCmd(o)
    return added(o)
  } catch (error) {
    if (error instanceof Usage) return { code: 2, result: { ok: false, error: `${error.message}\n${USAGE}` } }
    return { code: 1, result: { ok: false, error: error.message } }
  }
}

if (isMain(import.meta.url)) {
  const { code, result } = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = code
}
