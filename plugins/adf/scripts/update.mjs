#!/usr/bin/env node
// CLI over lib/update.mjs: what /adf:update reads and writes. Prints one JSON object on stdout;
// exit 1 on a refusal, 2 on a usage error. Only apply and commit commit, on the update branch.
//
// A cross-release interface: /adf:update runs plan from the installed (old) release and apply
// and commit from the new release's clone, so the old release's update.md drives the new
// release's scripts. The options of apply and commit, and the output fields of plan, apply and
// commit, change only additively: never rename or remove one, never make a new one required.
//
//   update.mjs check [--root <dir>] [--home <dir>]
//       { scope: "project"|"user"|"none", ref, pinned, installed, latest, behind, pull,
//       inFlight: [{ change, worktree }] }. `pull` is true when the installed release is older
//       than the ref the project pins
//   update.mjs notice [--root <dir>] [--home <dir>]
//       the SessionStart hook: prints { "systemMessage": "..." } when the project or the user
//       install is behind, or when the pinned release is not installed; else nothing. Asks the
//       remote once a day (<home>/adf/update-check.json). Any error: nothing printed, exit 0
//   update.mjs pull [--scope project|user] [--root <dir>] [--home <dir>]
//       { ran: [[...claude args]], restored, installed[, ref] }: `claude plugin marketplace
//       update`, then for each enabled package plugin `claude plugin update <id> --scope <scope>`
//       when it has an install record for the scope, else `claude plugin install`, in the main
//       directory. Scope defaults to what `check` reports. Project scope refuses when
//       .claude/settings.json has uncommitted changes, restores it after the calls, and refuses
//       when the installed release is still older than the pinned ref
//   update.mjs plan [--to <tag>] [--root <dir>]
//       { from, to, base, baseCommit, upToDate, plugins, log: { [plugin]: subjects }, hostFiles:
//       [{ path, class }], contract: { from, to, compatible[, reason] }, inFlight, clones: { old,
//       new, repo } }. Reads the project at `baseCommit`, the tip of `base`, the integration
//       branch (fetched first when the host has a remote). `to` defaults to the latest tag; when
//       it is not newer, only { from, to, base, baseCommit, upToDate: true }. Refuses before
//       cloning when the main directory has uncommitted tracked changes, or the update's branch
//       or worktree exists. The clones are temporary and left in place: apply reads them, the
//       command removes them; plan removes them itself when it fails after cloning
//   update.mjs apply --to <tag> --clones <json> --base <commit> [--choices <json>] [--root <dir>]
//       run from the new clone. { worktree, branch, written, manual, conflicts, dropped, ran,
//       committed[, commitError] }: the branch chore/adf-update-<version> and its worktree with
//       the new ref, the migrated registry and the host files. `base` is plan's `baseCommit`:
//       apply refuses when the integration branch moved since. The host files are classified by
//       this release's code; `choices` maps each edited one to keep, replace or manual.
//       Committed when no merge conflicts and no manual file remain; a commit that fails leaves
//       committed false, with commitError, for `commit` to finish
//   update.mjs commit --worktree <dir> --to <tag>
//       { worktree, branch, committed }: stages the files apply wrote and the manual ones, and
//       commits; refuses while one holds a conflict marker, or when nothing is left to commit
//   update.mjs cleanup --clones <json>
//       { removed }: removes the temporary directory plan made for the clones (null when it is
//       gone already); refuses any other directory
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isMain } from './lib/main.mjs'
import { claudeHome } from './lib/superpowers.mjs'
import { applyUpdate, checkUpdate, commitUpdate, latestTag, noticeMessage, planUpdate, pull, quietGit, remoteTags, removeClones } from './lib/update.mjs'

export const USAGE =
  'usage: update.mjs check [--root <dir>] [--home <dir>] | update.mjs notice [--root <dir>] [--home <dir>] | update.mjs pull [--scope project|user] [--root <dir>] [--home <dir>] | update.mjs plan [--to <tag>] [--root <dir>] | update.mjs apply --to <tag> --clones <json> --base <commit> [--choices <json>] [--root <dir>] | update.mjs commit --worktree <dir> --to <tag> | update.mjs cleanup --clones <json>'

export class UsageError extends Error {}

const DAY = 24 * 60 * 60 * 1000
const ALLOWED = { check: [], notice: [], pull: ['scope'], plan: ['to'], apply: ['to', 'clones', 'base', 'choices'], commit: ['worktree', 'to'], cleanup: ['clones'] }
const REQUIRED = { apply: ['to', 'clones', 'base'], commit: ['worktree', 'to'], cleanup: ['clones'] }
const CHOICES = ['keep', 'replace', 'manual']

function json(name, text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError(`--${name} is not valid JSON`)
  }
}

function clonesOption(text) {
  const clones = json('clones', text)
  if (!['old', 'new'].every((k) => typeof clones?.[k] === 'string')) throw new UsageError('--clones is { "old": <dir>, "new": <dir>, "repo": <dir> } as plan prints it')
  return clones
}

function choicesOption(text) {
  const choices = json('choices', text ?? '{}')
  if (choices === null || typeof choices !== 'object' || Array.isArray(choices)) throw new UsageError('--choices is an object of path to keep, replace or manual')
  const bad = Object.entries(choices).find(([, choice]) => !CHOICES.includes(choice))
  if (bad) throw new UsageError(`--choices: ${bad[0]} is "${bad[1]}"; a choice is keep, replace or manual`)
  return choices
}

function parse(argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!['--root', '--home', '--scope', '--to', '--clones', '--choices', '--base', '--worktree'].includes(arg)) {
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

export function run(argv, { cwd = process.cwd(), git, now = Date.now(), claude } = {}) {
  const { values, rest } = parse(argv)
  const [sub, ...extra] = rest
  if (extra.length > 0 || !Object.hasOwn(ALLOWED, sub)) throw new UsageError(USAGE)
  if (values.scope !== undefined && !['project', 'user'].includes(values.scope)) throw new UsageError('--scope is project or user')
  const stray = Object.keys(values).filter((k) => k !== 'root' && k !== 'home' && !ALLOWED[sub].includes(k))
  if (stray.length) throw new UsageError(`--${stray[0]} does not belong to ${sub}`)
  const absent = (REQUIRED[sub] ?? []).filter((k) => values[k] === undefined)
  if (absent.length) throw new UsageError(`${sub} needs --${absent[0]}`)
  if (values.base !== undefined && !/^[0-9a-f]{40,64}$/.test(values.base)) throw new UsageError('--base is the full commit id plan prints as baseCommit')
  if (values.to !== undefined && !/^v\d+\.\d+\.\d+$/.test(values.to)) throw new UsageError('--to is a release tag v<x.y.z>')
  const root = resolve(cwd, values.root ?? '.')
  const home = values.home ? resolve(cwd, values.home) : claudeHome()
  switch (sub) {
    case 'check':
      return checkUpdate(root, { home, ...(git ? { git } : {}) })
    case 'pull': {
      const scope = values.scope ?? checkUpdate(root, { home, ...(git ? { git } : {}), fetchLatest: () => null }).scope
      if (scope === 'none') throw new Error('no ADF install found for this project or user; nothing to pull')
      return pull({ root, scope, home, ...(claude ? { claude } : {}) })
    }
    case 'plan':
      return planUpdate(root, { to: values.to ?? null, ...(git ? { git } : {}) })
    case 'apply':
      return applyUpdate(root, { to: values.to, clones: clonesOption(values.clones), base: values.base, choices: choicesOption(values.choices) })
    case 'commit':
      return commitUpdate(resolve(cwd, values.worktree), { to: values.to })
    case 'cleanup': {
      const clones = clonesOption(values.clones)
      if (typeof clones.repo !== 'string') throw new UsageError('--clones is { "old": <dir>, "new": <dir>, "repo": <dir> } as plan prints it')
      return removeClones(clones)
    }
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
    process.exitCode = 0
  } else {
    try {
      // apply migrates through each plugin's own steps, which may be async.
      const result = await run(process.argv.slice(2))
      if (result !== null) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exitCode = 0
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...(error.ran ? { ran: error.ran, restored: error.restored } : {}), ...(error instanceof UsageError ? { usage: USAGE } : {}) })}\n`)
      process.exitCode = error instanceof UsageError ? 2 : 1
    }
  }
}
