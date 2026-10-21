#!/usr/bin/env node
// Reads every comment of one issue, with the ids an edit needs; writes nothing to Jira.
//
//   read-comments.mjs "<ISSUE-KEY>" [output.json]
//
// The allowlist is checked before the request goes out. Same output contract as
// read-issues.mjs.
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { JiraClient } from './lib/client.mjs'
import { loadContext } from './lib/context.mjs'
import { projectOf } from './lib/plan.mjs'
import { describeSources } from './lib/profile.mjs'
import { commentRow, readAllComments } from './lib/readers.mjs'
import { isMain } from './lib/main.mjs'

export { commentRow as toRow }

// Returns the exit code. deps: { cwd, home, processEnv, fetch, now, run, out, err }.
export async function main(argv, deps = {}) {
  const { out = console.log, err = console.error, fetch = globalThis.fetch, now = () => new Date() } = deps
  const processEnv = deps.processEnv ?? process.env
  const [key, file] = argv

  if (!key) {
    err('usage: read-comments.mjs "<ISSUE-KEY>" [output.json]')
    err('reads only; writes nothing to Jira.')
    return 1
  }

  const { env, sources } = loadContext({ cwd: deps.cwd, home: deps.home ?? homedir(), processEnv, run: deps.run })

  // The gate runs before the request, not after it: a key outside the allowlist is a mistake
  // to refuse, not an issue to fetch and then discard.
  if (!env.allowedProjects.includes(projectOf(key))) {
    throw new Error(`${key} is outside the allowlist (${env.allowedProjects.join(', ')})`)
  }

  if (processEnv.JIRA_READ_VERBOSE === '1') err(describeSources(sources))

  const client = new JiraClient(env, fetch)
  const rows = (await readAllComments(client, key)).map(commentRow)

  const payload = JSON.stringify({ key, readAt: now().toISOString(), count: rows.length, comments: rows }, null, 2)

  if (file) {
    writeFileSync(file, `${payload}\n`)
    err(`${rows.length} comment(s) written to ${file}`)
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
