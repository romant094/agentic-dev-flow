// A plan is the one shape every write takes: rows of steps, an allowlist, the profile it was
// built against, and per-row state. The allowlist gate rejects a whole plan, never filters it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIgnored } from './profile.mjs'

export const OPERATIONS = ['transition', 'edit', 'create', 'worklog', 'comment']
export const STATES = ['pending', 'done', 'failed', 'skipped-drift']
export const PLANS_ROOT = join('.adf', 'jira')
// The skills that write a plan; each has its own directory under PLANS_ROOT.
export const PLAN_SKILLS = ['bulk', 'comment', 'epic', 'setup', 'sync-debt', 'task', 'worklog']

// The directory of one skill's plans, in the project (the main checkout).
export function plansDir(projectDir, skill) {
  if (!PLAN_SKILLS.includes(skill)) throw new Error(`Unknown skill: ${String(skill)}; one of ${PLAN_SKILLS.join(', ')}.`)
  return join(projectDir, PLANS_ROOT, skill)
}

// A plan is personal and local: refused while git does not ignore where it would be written.
export function assertPlanIgnored(projectDir, path, ignored = isIgnored) {
  if (!ignored(projectDir, path)) {
    throw new Error(
      `Refusing to write the plan: git does not ignore ${path}. Plans are local and never committed; run /adf:init, which ignores .adf/, or add .adf/jira/ to .gitignore, check with git check-ignore -v, and re-run.`
    )
  }
}

export function projectOf(issueKey) {
  const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(issueKey)
  if (!match) throw new Error(`Not an issue key: ${issueKey}`)
  return match[1]
}

export function assertAllowlist(plan) {
  if (plan.allowlist.length === 0) {
    throw new Error('Plan carries an empty allowlist; refusing to run unscoped.')
  }
  const offenders = new Set()
  for (const row of plan.rows) {
    const project = row.project ?? projectOf(row.key)
    if (!plan.allowlist.includes(project)) offenders.add(row.project ?? row.key)
    for (const step of row.steps) {
      if (step.link === undefined) continue
      for (const key of [step.link.inwardIssue, step.link.outwardIssue]) {
        if (!plan.allowlist.includes(projectOf(key))) offenders.add(key)
      }
    }
  }
  if (offenders.size > 0) {
    throw new Error(
      `Plan rejected: ${offenders.size} issue(s) outside the allowlist (${plan.allowlist.join(', ')}): ${[...offenders].join(', ')}. Fix the selection rather than narrowing it — the whole plan is refused on purpose.`
    )
  }
}

// The plan's own allowlist is written by whoever built the plan; the configured one is the
// guard. A plan that names a project the configuration does not allow is refused whole.
export function assertConfiguredAllowlist(plan, allowedProjects) {
  const foreign = plan.allowlist.filter((p) => !allowedProjects.includes(p))
  if (foreign.length > 0) {
    throw new Error(
      `Plan rejected: its allowlist names ${foreign.join(', ')}, outside the configured allowlist (${allowedProjects.join(', ')}).`
    )
  }
}

export function validatePlan(value) {
  const plan = value
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Plan is not an object.')
  if (plan.version !== 1) throw new Error(`Unsupported plan version: ${String(plan.version)}`)
  if (!OPERATIONS.includes(plan.operation)) {
    throw new Error(`Unsupported plan operation: ${String(plan.operation)}`)
  }
  if (!Array.isArray(plan.allowlist)) throw new Error('Plan allowlist must be an array.')
  if (!Array.isArray(plan.rows)) throw new Error('Plan rows must be an array.')
  for (const row of plan.rows) {
    if (!row || typeof row !== 'object') throw new Error('Plan row is not an object.')
    if (typeof row.key !== 'string') throw new Error('Plan row is missing a key.')
    if (!STATES.includes(row.state)) {
      throw new Error(`Plan row ${row.key} has an unknown state: ${String(row.state)}`)
    }
    if (!Array.isArray(row.steps)) throw new Error(`Plan row ${row.key} is missing steps.`)
  }
  return plan
}

export function planFileName(operation, now) {
  const iso = now.toISOString()
  const date = iso.slice(0, 10)
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}`
  return `plan-${operation}-${date}-${time}.json`
}

export function writePlan(path, plan) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
}

export function savePlan(projectDir, skill, plan, now, ignored = isIgnored) {
  const path = join(plansDir(projectDir, skill), planFileName(plan.operation, now))
  assertPlanIgnored(projectDir, path, ignored)
  writePlan(path, plan)
  return path
}

export function loadPlan(path) {
  return validatePlan(JSON.parse(readFileSync(path, 'utf8')))
}
