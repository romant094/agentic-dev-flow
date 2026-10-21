#!/usr/bin/env node
// Prints where this project's Jira profile lives and the plugin's non-secret configuration, as
// one JSON object: what a skill needs before it builds a plan. Reads no env file and calls no
// network.
//
//   profile.mjs
//
// { ok, projectDir, config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate,
//   profileDir }, profile: { dir, discovered, conventions, local, exists, ignored,
//   discoveredAt, stale }, plans: { dir, ignored } }
// `ignored` says whether git ignores the personal files; setup refuses to write them when it
// does not.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './lib/context.mjs'
import { PLANS_DIR } from './lib/plan.mjs'
import { MAX_AGE_DAYS, isIgnored, isStale, profilePaths } from './lib/profile.mjs'
import { isMain } from './lib/main.mjs'

export function describeProfile({ cwd = process.cwd(), now = new Date(), run, ignored = isIgnored } = {}) {
  const { projectDir, config } = loadConfig({ cwd, run })
  const paths = profilePaths(projectDir, config.profileDir)
  let discoveredAt = null
  try {
    discoveredAt = JSON.parse(readFileSync(paths.discovered, 'utf8')).discoveredAt ?? null
  } catch {
    // no profile yet
  }
  const { baseUrl = null, allowlist = null, debtEpic = null, fields, statuses, commentTemplate = null, profileDir } = config
  return {
    ok: true,
    projectDir,
    config: { baseUrl, allowlist, debtEpic, fields, statuses, commentTemplate, profileDir },
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
