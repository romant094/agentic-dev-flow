#!/usr/bin/env node
// Prints where this project's Jira profile lives and the plugin's non-secret configuration, as
// one JSON object: what a skill needs before it builds a plan. Calls no network. It reads the
// env file inside its own process for one value, JIRA_GIT_AUTHOR, which is not secret; it
// prints no other value of the env file.
//
//   profile.mjs
//
// { ok, projectDir, config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate,
//   correctionTemplate, profileDir }, gitAuthor, profile: { dir, discovered, conventions, local,
//   exists, ignored, discoveredAt, stale }, plans: { dir, ignored } }
// `gitAuthor` is JIRA_GIT_AUTHOR, the developer's git author name, or null when unset.
// `ignored` says whether git ignores the personal files; setup refuses to write them when it
// does not.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './lib/context.mjs'
import { resolveLayers } from './lib/env.mjs'
import { PLANS_DIR } from './lib/plan.mjs'
import { MAX_AGE_DAYS, isIgnored, isStale, profilePaths } from './lib/profile.mjs'
import { isMain } from './lib/main.mjs'

export function describeProfile({ cwd = process.cwd(), now = new Date(), run, ignored = isIgnored, home = homedir(), processEnv = process.env } = {}) {
  const { projectDir, config } = loadConfig({ cwd, run })
  const { resolved } = resolveLayers({ projectDir, homeDir: home, processEnv, envFile: config.envFile })
  const paths = profilePaths(projectDir, config.profileDir)
  let discoveredAt = null
  try {
    discoveredAt = JSON.parse(readFileSync(paths.discovered, 'utf8')).discoveredAt ?? null
  } catch {
    // no profile yet
  }
  const { baseUrl = null, allowlist = null, debtEpic = null, fields, statuses, commentTemplate = null, correctionTemplate = null, profileDir } = config
  return {
    ok: true,
    projectDir,
    config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate, correctionTemplate, profileDir },
    gitAuthor: resolved.JIRA_GIT_AUTHOR ?? null,
    profile: {
      ...paths,
      exists: { discovered: existsSync(paths.discovered), conventions: existsSync(paths.conventions), local: existsSync(paths.local) },
      ignored: { discovered: ignored(projectDir, paths.discovered), local: ignored(projectDir, paths.local) },
      discoveredAt,
      stale: discoveredAt === null ? null : isStale({ discoveredAt }, now, MAX_AGE_DAYS)
    },
    plans: { dir: join(projectDir, PLANS_DIR), ignored: ignored(projectDir, join(projectDir, PLANS_DIR, 'probe.json')) }
  }
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(describeProfile(), null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
