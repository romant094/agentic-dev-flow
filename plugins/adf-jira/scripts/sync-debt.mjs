#!/usr/bin/env node
// The deterministic steps of /adf-jira:sync-debt (lib/sync-debt.mjs), one JSON result each on
// stdout; exit 1 on a refusal or a result with ok false, exit 2 on a usage error. The debt tree
// is read and written only through the core's debt CLI (core-debt.mjs), in the current
// checkout; plans go to .adf/jira/sync-debt/ in the main checkout. Nothing here calls Jira:
// apply-plan.mjs applies the plans, on the developer's yes.
//
//   sync-debt.mjs state
//       { ok, root, epic, initial, order, groups: [{ key, entries: [entry] }],
//         keyless: [entry + related: { groups: [{ key, by }], entries: [{ id, by }] }] }
//       entry { id, block, subBlock, title, anchors, class, files }; `by` names block,
//       sub-block, anchor-file
//   sync-debt.mjs check-groups --file <grouping.json>
//       the agent's grouping against the tree. { ok, errors, join, create, wait }
//   sync-debt.mjs plan --file <grouping.json> [--type <issue type> --attach parent|epic-link]
//       the plans: a create row per new group, an edit row per existing group; --type and
//       --attach are required when a new group is filed. { ok, plans: { create, edit }, rows,
//       waiting, preview }
//   sync-debt.mjs track --plan <plan.json> [--plan <plan.json>]
//       after apply: each applied row's key into its entries (core `track`), then the core's
//       check. { ok, tracked, waiting, untouched, notApplied, created, updated, unchanged,
//       errors, check }
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callCore } from './core-debt.mjs'
import { loadConfig } from './lib/context.mjs'
import { loadDebtTemplate } from './lib/debt-description.mjs'
import { isMain } from './lib/main.mjs'
import { loadPlan, savePlan } from './lib/plan.mjs'
import { isIgnored, isStale, MAX_AGE_DAYS, readDiscovered } from './lib/profile.mjs'
import { buildPlans, checkGrouping, debtState, PlanRefusal, trackResults } from './lib/sync-debt.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const USAGE = `usage:
  sync-debt.mjs state
  sync-debt.mjs check-groups --file <grouping.json>
  sync-debt.mjs plan --file <grouping.json> [--type <issue type> --attach parent|epic-link]
  sync-debt.mjs track --plan <plan.json> [--plan <plan.json>]`

export class UsageError extends Error {}

const TAKES = { state: [], 'check-groups': ['file'], plan: ['file', 'type', 'attach'], track: ['plan'] }
const REQUIRED = { 'check-groups': ['file'], plan: ['file'], track: ['plan'] }

function parse(argv) {
  const [command, ...rest] = argv
  if (!Object.hasOwn(TAKES, command ?? '')) throw new UsageError(USAGE)
  const values = {}
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value\n${USAGE}`)
    const name = flag.slice(2)
    if (!TAKES[command].includes(name)) throw new UsageError(`${command} takes no ${flag}\n${USAGE}`)
    if (name === 'plan') values.plan = [...(values.plan ?? []), value]
    else if (values[name] !== undefined) throw new UsageError(`${flag} is given twice`)
    else values[name] = value
  }
  const missing = (REQUIRED[command] ?? []).filter((k) => values[k] === undefined)
  if (missing.length) throw new UsageError(`${command} needs --${missing.join(', --')}\n${USAGE}`)
  return { command, values }
}

function readJson(cwd, file) {
  let text
  try {
    text = readFileSync(resolve(cwd, file), 'utf8')
  } catch {
    throw new PlanRefusal(`cannot read ${file}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new PlanRefusal(`${file} is not JSON: ${error.message}`)
  }
}

function treeState(cwd, core) {
  const listed = callCore(['list', '--kind', 'debt', '--root', cwd], { cwd, core })
  if (listed.ok === false) throw new PlanRefusal(`the core's debt list refused: ${listed.error}`)
  return debtState(listed)
}

// deps: { cwd, run (git common dir), core (the core plugin's directory), now, ignored, pluginRoot }.
export function main(argv, deps = {}) {
  const { cwd = process.cwd(), run, core, now = () => new Date(), ignored = isIgnored, pluginRoot = PLUGIN_ROOT } = deps
  const { command, values } = parse(argv)
  const { projectDir, config } = loadConfig({ cwd, run })

  if (command === 'state') {
    return { ok: true, epic: config.debtEpic ?? null, initial: config.statuses.initial, ...treeState(cwd, core) }
  }

  if (command === 'check-groups') {
    const grouping = readJson(cwd, values.file)
    const errors = checkGrouping(treeState(cwd, core), grouping)
    const count = (name) => (Array.isArray(grouping?.[name]) ? grouping[name].length : 0)
    return { ok: errors.length === 0, errors, join: count('join'), create: count('create'), wait: count('wait') }
  }

  if (command === 'plan') {
    const grouping = readJson(cwd, values.file)
    const facts = readDiscovered(projectDir, config.profileDir)
    if (facts === null) throw new PlanRefusal('no discovered.json; run /adf-jira:setup first')
    if (isStale(facts, now(), MAX_AGE_DAYS)) throw new PlanRefusal(`discovered.json is more than ${MAX_AGE_DAYS} days old; run /adf-jira:setup to refresh it`)
    const template = loadDebtTemplate({ root: cwd, pluginRoot, debtTemplate: config.debtTemplate })
    const built = buildPlans({ state: treeState(cwd, core), grouping, config, facts, template, type: values.type, attach: values.attach })
    const save = (plan) => (plan ? savePlan(projectDir, 'sync-debt', plan, now(), ignored) : null)
    const plans = { create: save(built.create), edit: save(built.edit) }
    return {
      ok: true,
      plans,
      rows: { create: built.create?.rows.length ?? 0, edit: built.edit?.rows.length ?? 0 },
      waiting: built.waiting,
      preview: built.preview,
      next: 'render each plan with apply-plan.mjs <plan>, show it, and apply it with --confirm on the developer\'s yes; then sync-debt.mjs track --plan <plan> for each'
    }
  }

  const results = trackResults(values.plan.map((file) => loadPlan(resolve(cwd, file))))
  const tracked = []
  const errors = []
  for (const { id, key } of results.track) {
    const out = callCore(['track', '--id', id, '--key', key, '--root', cwd], { cwd, core })
    if (out.ok === false) errors.push(`${id}: ${out.error}`)
    else tracked.push({ id, key, changed: out.changed })
  }
  const check = callCore(['check', '--root', cwd], { cwd, core })
  const { track, ...rest } = results
  return { ok: errors.length === 0 && check.ok === true, tracked, ...rest, errors, check }
}

if (isMain(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    const usage = error instanceof UsageError
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = usage ? 2 : 1
  }
}
