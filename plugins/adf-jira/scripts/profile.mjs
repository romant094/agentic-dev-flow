#!/usr/bin/env node
// Prints where this project's Jira profile lives and the plugin's non-secret configuration, as
// one JSON object: what a skill needs before it builds a plan. Calls no network. It reads the
// env file inside its own process for one value, JIRA_GIT_AUTHOR, which is not secret; it
// prints no other value of the env file.
//
//   profile.mjs [--skill <name>]
//
// { ok, projectDir, config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate,
//   correctionTemplate, debtTemplate, profileDir }, gitAuthor, profile: { dir, discovered, conventions, local,
//   exists, ignored, discoveredAt, stale }, plans: { dir, ignored } }
// `gitAuthor` is JIRA_GIT_AUTHOR, the developer's git author name, or null when unset.
// `ignored` says whether git ignores the personal files; setup refuses to write them when it
// does not. `plans` is the directory of the named skill's plans, `.adf/jira/<skill>/` in the main
// checkout, with whether git ignores it; null without --skill. apply-plan.mjs refuses a plan
// git does not ignore.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './lib/context.mjs'
import { resolveLayers } from './lib/env.mjs'
import { plansDir } from './lib/plan.mjs'
import { MAX_AGE_DAYS, isIgnored, isStale, profilePaths } from './lib/profile.mjs'
import { isMain } from './lib/main.mjs'

export function describeProfile({ cwd = process.cwd(), now = new Date(), run, ignored = isIgnored, home = homedir(), processEnv = process.env, skill } = {}) {
  const { projectDir, config } = loadConfig({ cwd, run })
  const { resolved } = resolveLayers({ projectDir, homeDir: home, processEnv, envFile: config.envFile })
  const paths = profilePaths(projectDir, config.profileDir)
  let discoveredAt = null
  try {
    discoveredAt = JSON.parse(readFileSync(paths.discovered, 'utf8')).discoveredAt ?? null
  } catch {
    // no profile yet
  }
  const plans = skill === undefined ? null : plansDir(projectDir, skill)
  const { baseUrl = null, allowlist = null, debtEpic = null, fields, statuses, commentTemplate = null, correctionTemplate = null, debtTemplate = null, profileDir } = config
  return {
    ok: true,
    projectDir,
    config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate, correctionTemplate, debtTemplate, profileDir },
    gitAuthor: resolved.JIRA_GIT_AUTHOR ?? null,
    profile: {
      ...paths,
      exists: { discovered: existsSync(paths.discovered), conventions: existsSync(paths.conventions), local: existsSync(paths.local) },
      ignored: { discovered: ignored(projectDir, paths.discovered), local: ignored(projectDir, paths.local) },
      discoveredAt,
      stale: discoveredAt === null ? null : isStale({ discoveredAt }, now, MAX_AGE_DAYS)
    },
    plans: plans === null ? null : { dir: plans, ignored: ignored(projectDir, join(plans, 'probe.json')) }
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const at = args.indexOf('--skill')
    if (at !== -1 && args[at + 1] === undefined) throw new Error('Usage: profile.mjs [--skill <name>]')
    process.stdout.write(`${JSON.stringify(describeProfile({ skill: at === -1 ? undefined : args[at + 1] }), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
