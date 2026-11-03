#!/usr/bin/env node
// CLI over lib/update.mjs: what /adf:update reads. Prints one JSON object on stdout; exit 1 on a
// refusal, 2 on a usage error. Nothing is committed.
//
//   update.mjs check [--root <dir>] [--home <dir>]
//       { scope: "project"|"user"|"none", ref, pinned, installed, latest, behind, pull,
//       inFlight: [{ change, worktree }] }. `pull` is true when the installed release is older
//       than the ref the project pins
//   update.mjs notice [--root <dir>] [--home <dir>]
//       the SessionStart hook: prints { "systemMessage": "..." } when the project or the user
//       install is behind, or when the pinned release is not installed; else nothing. Asks the
//       remote once a day (<home>/adf/update-check.json). Any error: nothing printed, exit 0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { claudeHome } from './lib/superpowers.mjs'
import { checkUpdate, latestTag, noticeMessage, quietGit, remoteTags } from './lib/update.mjs'

export const USAGE = 'usage: update.mjs check [--root <dir>] [--home <dir>] | update.mjs notice [--root <dir>] [--home <dir>]'

export class UsageError extends Error {}

const DAY = 24 * 60 * 60 * 1000
const ALLOWED = { check: [], notice: [] }

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--root', '--home'].includes(arg)) {
      if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
      rest.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
    if (values[arg.slice(2)] !== undefined) throw new UsageError(`${arg} is given twice`)
    values[arg.slice(2)] = value
    i++
  }
  return { values, rest }
}

// The newest tag of a remote, asked at most once a day per URL.
function cachedLatest(home, git, now) {
  const path = join(home, 'adf', 'update-check.json')
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) ?? {}
  } catch {}
  return (url) => {
    const hit = cache[url]
    if (hit && now - hit.checkedAt < DAY && now >= hit.checkedAt) return hit.latest ?? null
    // A failed ask is cached too, as no answer, so an offline machine asks once a day.
    let latest = null
    try {
      latest = latestTag(remoteTags(url, { git: git ?? quietGit }))
    } catch {}
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify({ ...cache, [url]: { checkedAt: now, latest } })}\n`)
    } catch {}
    return latest
  }
}

export function run(argv, { cwd = process.cwd(), git, now = Date.now() } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(ALLOWED, sub)) throw new UsageError(USAGE)
  const stray = Object.keys(values).filter((k) => k !== 'root' && k !== 'home' && !ALLOWED[sub].includes(k))
  if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  const root = resolve(cwd, values.root ?? '.')
  const home = values.home ? resolve(cwd, values.home) : claudeHome()
  switch (sub) {
    case 'check':
      return checkUpdate(root, { home, ...(git ? { git } : {}) })
    case 'notice': {
      try {
        const message = noticeMessage(checkUpdate(root, { home, fetchLatest: cachedLatest(home, git, now) }))
        return message ? { systemMessage: message } : null
      } catch {
        return null
      }
    }
  }
}

if (isMain(import.meta.url)) {
  // The notice runs at session start: whatever goes wrong, it prints nothing and exits 0.
  if (process.argv[2] === 'notice') {
    try {
      const result = run(process.argv.slice(2))
      if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch {}
    process.exit(0)
  }
  try {
    const result = run(process.argv.slice(2))
    if (result !== null) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
}
