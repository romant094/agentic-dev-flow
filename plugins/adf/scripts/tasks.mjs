#!/usr/bin/env node
// CLI over lib/tasks.mjs. Prints one JSON object.
//
//   tasks.mjs tick <item> --change <name> [--root <dir>] [--commit]
//   tasks.mjs tick --plan-task <N> --change <name> [--root <dir>] [--evidence <file>] [--commit]
//       Ticks task <item> (such as 1.2), or the item plan task N's back-reference names.
//       --plan-task refuses unless task N's review loop is clean: the last accepted review or
//       re-review of T<N> left nothing open, and every plan-mandated or unverifiable item is
//       ruled, or a ruling (`ledger.mjs ruling --subject T<N> --finding <id> --as
//       accepted|dismissed`) closes each item left (lib/loop.mjs).
//       --evidence, for a verification-only task (its Commit step says none) whose check no
//       agent runs, such as a bench pass, takes the place of the review: a non-empty file
//       inside the change directory that records the check (lib/tasks.mjs evidenceGate).
//       --commit then commits the tasks file, plan.md when it changed, and the evidence file,
//       with the message "chore(openspec): tick <item> of <change>"; other staged paths are a
//       refusal.
//       { item, ticked, already, planTask?, evidence?, sha?, paths? }
//   tasks.mjs lint --change <name> [--root <dir>]
//       { ok, findings: [{ severity, kind, line, message }] }: the checkbox grammar, item
//       numbers against their group, duplicates; a warning for a path or a command; an error
//       (`scope-key`) for each taken or partial key of the change's scope.json that no task
//       names, by the rule verify's tasks check applies (lib/scope.mjs scopeNaming).
//
// Exit 1 on a refusal or an error finding, 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeDir, parseTasks } from './lib/changes.mjs'
import { scopeNaming } from './lib/scope.mjs'
import { commitTick, evidenceGate, itemForPlanTask, lintTasks, tickGate, tickTask } from './lib/tasks.mjs'
import { isMain } from './lib/main.mjs'
import { schemaOf } from './lib/schema.mjs'
import { CHANGES_DIR } from './lib/layout.mjs'

const USAGE =
  'usage: tasks.mjs tick <item> | --plan-task <N> [--evidence <file>] --change <name> [--root <dir>] [--commit]; tasks.mjs lint --change <name> [--root <dir>]'

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
  const evidenceFile = option(args, '--evidence')
  const commit = flag(args, '--commit')
  const [command, item] = args
  if (!change) throw new Usage('--change is required')
  const tracks = schemaOf(root, change).apply?.tracks ?? 'tasks.md'
  const dir = changeDir(root, change)
  if (command === 'lint') {
    if (args.length > 1 || planTask || evidenceFile || commit) throw new Usage('lint takes --change and --root only')
    const file = join(dir, tracks)
    if (!existsSync(file)) throw new Error(`${change} has no ${tracks}`)
    const text = readFileSync(file, 'utf8')
    // The scope's keys are mapped onto the tasks here, at propose, by verify's own rule.
    const unnamed = scopeNaming(root, change, parseTasks(text)).unnamed.map(({ key, state }) => ({
      severity: 'error',
      kind: 'scope-key',
      line: null,
      message: `${key} (${state}) is named by no task: name it, as a whole word, on the task that addresses it`
    }))
    const findings = [...lintTasks(text), ...unnamed]
    const ok = !findings.some((f) => f.severity === 'error')
    return { code: ok ? 0 : 1, result: { ok, file: `${CHANGES_DIR}/${change}/${tracks}`, findings } }
  }
  if (command !== 'tick' || args.length > 2 || Boolean(item) === Boolean(planTask)) throw new Usage('tick takes an item or --plan-task, not both')
  if (evidenceFile && !planTask) throw new Usage('--evidence closes a plan task: pass --plan-task')
  let target = item
  let evidence = null
  if (planTask) {
    if (!/^\d+$/.test(planTask)) throw new Usage('--plan-task must be a task number')
    const plan = join(dir, 'plan.md')
    if (!existsSync(plan)) throw new Error(`${change} has no plan.md`)
    const planText = readFileSync(plan, 'utf8')
    target = itemForPlanTask(planText, planTask)
    if (evidenceFile) evidence = evidenceGate(root, change, planTask, planText, evidenceFile)
    else tickGate(root, change, planTask)
  }
  // The staged-path refusal comes before the tick, so a refused commit leaves nothing ticked.
  if (commit) commitTick(root, change, target, { tracks, evidence, dryRun: true })
  const result = tickTask(root, change, target, { tracks })
  if (commit) Object.assign(result, commitTick(root, change, target, { tracks, evidence }))
  return { code: 0, result: planTask ? { ...result, planTask: Number(planTask), ...(evidence ? { evidence } : {}) } : result }
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
