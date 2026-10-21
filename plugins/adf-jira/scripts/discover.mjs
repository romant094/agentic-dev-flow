#!/usr/bin/env node
// Discovers the API facts of one project and writes them to the profile's discovered.json.
//
//   discover.mjs [<PROJECT-KEY>]    default: JIRA_DEFAULT_PROJECT, else the first allowlisted
//
// Refuses a project outside the allowlist, and refuses to write while git does not ignore
// discovered.json or local.md: both are personal and are never committed. Prints which
// variables resolved, from which layer, and their length — never a value.
import { homedir } from 'node:os'
import { JiraClient } from './lib/client.mjs'
import { loadContext } from './lib/context.mjs'
import { discover } from './lib/discovered.mjs'
import { describeSources, isIgnored, profilePaths, writeDiscovered } from './lib/profile.mjs'
import { isMain } from './lib/main.mjs'

// Returns the exit code. deps: { cwd, home, processEnv, fetch, now, run, ignored, out, warn }.
export async function main(argv, deps = {}) {
  const { out = console.log, warn = console.warn, fetch = globalThis.fetch, now = () => new Date(), ignored = isIgnored } = deps
  const { projectDir, config, env, sources } = loadContext({ cwd: deps.cwd, home: deps.home ?? homedir(), processEnv: deps.processEnv ?? process.env, run: deps.run })

  out('Environment resolved:')
  out(describeSources(sources))

  const projectKey = argv[0] ?? env.defaultProject ?? env.allowedProjects[0]
  if (!env.allowedProjects.includes(projectKey)) {
    throw new Error(`Project ${projectKey} is not in the allowlist (${env.allowedProjects.join(', ')}).`)
  }

  const paths = profilePaths(projectDir, config.profileDir)
  const unignored = [paths.discovered, paths.local].filter((p) => !ignored(projectDir, p))
  if (unignored.length > 0) {
    throw new Error(
      `Refusing to write the profile: git does not ignore ${unignored.join(' and ')}. Both files are personal; add them to .gitignore, check with git check-ignore -v, and re-run.`
    )
  }

  const client = new JiraClient(env, fetch)
  const facts = await discover(client, projectKey, now())
  writeDiscovered(projectDir, facts, config.profileDir)

  out(`\n${facts.instance.deploymentType} ${facts.instance.version} at ${facts.instance.baseUrl}`)
  out(`Project ${facts.project.key} — ${facts.project.name}`)
  out(`Issue types: ${facts.issueTypes.map((t) => t.name).join(', ')}`)
  out(`Statuses discovered: ${Object.keys(facts.workflow).length}`)
  out(`Written to ${paths.discovered}`)

  if (facts.unsampledStatuses.length > 0) {
    warn('\nWarning: the following statuses could not be sampled — their transitions are unknown, not absent:')
    for (const { status, reason } of facts.unsampledStatuses) {
      warn(`  ${status}: ${reason}`)
    }
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
