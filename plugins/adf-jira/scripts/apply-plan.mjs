#!/usr/bin/env node
// Renders a plan for confirmation, or applies it.
//
//   apply-plan.mjs <plan.json>             print the summary and exit 1 without applying
//   apply-plan.mjs <plan.json> --confirm   apply; per-row state is written back to the file
//
// Refuses a plan git does not ignore (plans are local, in .adf/jira/<skill>/), a plan outside
// the allowlist (its own, and the configured one), a plan built against an older profile, and a
// profile more than 7 days old. Login placeholders (<JIRA_ASSIGNEE>,
// <JIRA_PM>, <JIRA_QA>) are resolved here, from the env file this process reads; the plan file
// keeps them, and the summary prints the resolved login.
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { JiraClient } from './lib/client.mjs'
import { loadContext } from './lib/context.mjs'
import { applyPlan } from './lib/apply.mjs'
import { assertAllowlist, assertConfiguredAllowlist, assertPlanIgnored, loadPlan } from './lib/plan.mjs'
import { assertResolvable, placeholderValues, resolvePlaceholders } from './lib/placeholders.mjs'
import { MAX_AGE_DAYS, isStale, readDiscovered } from './lib/profile.mjs'
import { renderPlan } from './lib/report.mjs'
import { isMain } from './lib/main.mjs'

// Returns the exit code; prints through `out` and `err`. deps: { cwd, home, processEnv, fetch,
// now, run (git common dir), ignored }, each defaulting to the real one.
export async function main(argv, deps = {}) {
  const { out = console.log, err = console.error, fetch = globalThis.fetch, now = () => new Date() } = deps
  const path = argv[0]
  if (!path) throw new Error('Usage: apply-plan.mjs <path-to-plan.json> [--confirm]')
  const confirm = argv.includes('--confirm')

  const { projectDir, config, env } = loadContext({ cwd: deps.cwd, home: deps.home ?? homedir(), processEnv: deps.processEnv ?? process.env, run: deps.run })
  assertPlanIgnored(projectDir, resolve(deps.cwd ?? process.cwd(), path), deps.ignored)
  const plan = loadPlan(path)
  assertAllowlist(plan)
  assertConfiguredAllowlist(plan, env.allowedProjects)

  const facts = readDiscovered(projectDir, config.profileDir)
  if (facts === null) {
    throw new Error('No discovered.json found; run /adf-jira:setup first.')
  }
  if (new Date(plan.discoveredAt).getTime() < new Date(facts.discoveredAt).getTime()) {
    throw new Error(
      `Plan is stale: built against facts discovered at ${plan.discoveredAt}, but discovered.json was refreshed at ${facts.discoveredAt}. The plan's transition ids may no longer be valid — rebuild the plan.`
    )
  }
  if (isStale(facts, now(), MAX_AGE_DAYS)) {
    throw new Error(`discovered.json is more than ${MAX_AGE_DAYS} days old; re-run discovery before applying.`)
  }

  const values = placeholderValues(env)
  assertResolvable(plan, values)
  const title = `adf-jira:apply — ${plan.operation}, ${plan.rows.length} row(s)`

  if (!confirm) {
    out(renderPlan({ plan: resolvePlaceholders(plan, values), planPath: path, title }))
    out('\nRe-run with --confirm to apply.')
    return 1
  }

  plan.confirmedAt = now().toISOString()
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  const outcome = await applyPlan({
    plan,
    client: new JiraClient(env, fetch),
    persist: (p) => writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`, 'utf8'),
    values
  })

  out(
    [
      `applied:       ${outcome.applied}`,
      `skipped (done): ${outcome.skippedDone}`,
      `skipped (drift): ${outcome.skippedDrift}`,
      ...(outcome.unchanged > 0 ? [`unchanged:     ${outcome.unchanged}`] : []),
      `failed:        ${outcome.failed}`
    ].join('\n')
  )
  if (outcome.abortedAfterConsecutiveFailures) {
    err('\nAborted after 3 consecutive failures — this looks systemic, not per-issue.')
    err(`Fix the cause, then re-run the same plan: ${path}`)
    return 1
  }
  if (outcome.failed > 0) {
    err(`\n${outcome.failed} row(s) failed. Re-running skips what already succeeded.`)
    return 1
  }
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  )
}
