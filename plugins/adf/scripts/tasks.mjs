#!/usr/bin/env node
// CLI over lib/tasks.mjs. Prints one JSON object.
//
//   tasks.mjs tick <item> --change <name> [--root <dir>] [--commit]
//   tasks.mjs tick --plan-task <N> --change <name> [--root <dir>] [--commit]
//       Ticks task <item> (such as 1.2), or the item plan task N's back-reference names.
//       --plan-task refuses unless task N's review loop is clean: the last accepted review or
//       re-review of T<N> left nothing open, and every plan-mandated or unverifiable item is
//       ruled, or a ruling (`ledger.mjs ruling --subject T<N> --finding <id> --as
//       accepted|dismissed`) closes each item left (lib/loop.mjs).
//       --commit then commits the tasks file, and plan.md when it changed, with the message
//       "chore(openspec): tick <item> of <change>"; other staged paths are a refusal.
//       { item, ticked, already, sha?, paths? }
//   tasks.mjs lint --change <name> [--root <dir>]
//       { ok, findings: [{ severity, kind, line, message }] }: the checkbox grammar, item
//       numbers against their group, duplicates; a warning for a path or a command.
//
// Exit 1 on a refusal or an error finding, 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir } from './lib/changes.mjs'
import { commitTick, itemForPlanTask, lintTasks, tickGate, tickTask } from './lib/tasks.mjs'
import { isMain } from './lib/main.mjs'
import { loadSchema } from './lib/schema.mjs'

const USAGE =
  'usage: tasks.mjs tick <item> | --plan-task <N> --change <name> [--root <dir>] [--commit]; tasks.mjs lint --change <name> [--root <dir>]'

class Usage extends Error {}

function option(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const [, value] = args.splice(i, 2)
  if (value === undefined || value.startsWith('--')) throw new Usage(`${name} needs a value`)
  return value
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function exec(argv) {
  const args = [...argv]
  const root = option(args, '--root') ?? process.cwd()
  const change = option(args, '--change')
  const planTask = option(args, '--plan-task')
  const commit = flag(args, '--commit')
  const [command, item] = args
  if (!change) throw new Usage('--change is required')
  const tracks = loadSchema().apply?.tracks ?? 'tasks.md'
  const dir = changeDir(root, change)
  if (command === 'lint') {
    if (args.length > 1 || planTask || commit) throw new Usage('lint takes --change and --root only')
    const file = join(dir, tracks)
    if (!existsSync(file)) throw new Error(`${change} has no ${tracks}`)
    const findings = lintTasks(readFileSync(file, 'utf8'))
    const ok = !findings.some((f) => f.severity === 'error')
    return { code: ok ? 0 : 1, result: { ok, file: `openspec/changes/${change}/${tracks}`, findings } }
  }
  if (command !== 'tick' || args.length > 2 || Boolean(item) === Boolean(planTask)) throw new Usage('tick takes an item or --plan-task, not both')
  let target = item
  if (planTask) {
    if (!/^\d+$/.test(planTask)) throw new Usage('--plan-task must be a task number')
    const plan = join(dir, 'plan.md')
    if (!existsSync(plan)) throw new Error(`${change} has no plan.md`)
    target = itemForPlanTask(readFileSync(plan, 'utf8'), planTask)
    tickGate(root, change, planTask)
  }
  // The staged-path refusal comes before the tick, so a refused commit leaves nothing ticked.
  if (commit) commitTick(root, change, target, { tracks, dryRun: true })
  const result = tickTask(root, change, target, { tracks })
  if (commit) Object.assign(result, commitTick(root, change, target, { tracks }))
  return { code: 0, result: planTask ? { ...result, planTask: Number(planTask) } : result }
}

export function run(argv) {
  try {
    return exec(argv)
  } catch (error) {
    if (error instanceof Usage) return { code: 2, result: { ok: false, error: `${error.message}; ${USAGE}` } }
    return { code: 1, result: { ok: false, error: error.message } }
  }
}

if (isMain(import.meta.url)) {
  const { code, result } = run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = code
}
