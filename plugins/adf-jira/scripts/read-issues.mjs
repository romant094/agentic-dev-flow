#!/usr/bin/env node
// Reads issues by JQL; writes nothing to Jira.
//
//   read-issues.mjs "<JQL>" [output.json]
//
// With an output path it saves the result and prints a count to stderr, refused before the read
// while git does not ignore the path, as a plan is; without one it prints
// JSON on stdout and nothing else, so it can be piped. JIRA_READ_VERBOSE=1 prints the env
// diagnostics (name, layer, length) to stderr. A result outside the allowlist fails the read.
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { JiraClient } from './lib/client.mjs'
import { loadContext } from './lib/context.mjs'
import { assertPlanIgnored } from './lib/plan.mjs'
import { describeSources } from './lib/profile.mjs'
import { DEFAULT_FIELDS, issueRow } from './lib/readers.mjs'
import { isMain } from './lib/main.mjs'

export { issueRow as toRow }

// Returns the exit code. deps: { cwd, home, processEnv, fetch, now, run, out, err, ignored }.
export async function main(argv, deps = {}) {
  const { out = console.log, err = console.error, fetch = globalThis.fetch, now = () => new Date() } = deps
  const processEnv = deps.processEnv ?? process.env
  const [jql, file] = argv

  if (!jql) {
    err('usage: read-issues.mjs "<JQL>" [output.json]')
    err('reads only; writes nothing to Jira.')
    return 1
  }

  const { projectDir, env, sources } = loadContext({ cwd: deps.cwd, home: deps.home ?? homedir(), processEnv, run: deps.run })
  if (file) assertPlanIgnored(projectDir, resolve(deps.cwd ?? process.cwd(), file), deps.ignored, 'the issues')

  // Diagnostics are opt-in: without an output path stdout is JSON meant to be piped, and
  // anything else printed alongside it corrupts the consumer's parse.
  if (processEnv.JIRA_READ_VERBOSE === '1') err(describeSources(sources))

  const client = new JiraClient(env, fetch)
  const issues = await client.search(jql, DEFAULT_FIELDS)
  const rows = issues.map(issueRow)

  const foreign = rows.filter((r) => !env.allowedProjects.includes(r.key.split('-')[0]))
  if (foreign.length > 0) {
    throw new Error(`query returned ${foreign.length} issue(s) outside the allowlist: ${foreign.map((r) => r.key).join(', ')}`)
  }

  const payload = JSON.stringify({ jql, readAt: now().toISOString(), count: rows.length, issues: rows }, null, 2)

  if (file) {
    writeFileSync(file, `${payload}\n`)
    err(`${rows.length} issue(s) written to ${file}`)
  } else {
    out(payload)
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
