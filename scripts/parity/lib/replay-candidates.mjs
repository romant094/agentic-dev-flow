// Dev tool: finds the origin's archived changes a replay takes (iteration 14), by rule and never
// from a committed list. Read-only git only (log, rev-list, rev-parse, show, ls-tree,
// for-each-ref, merge-base): nothing is written in the origin.
//
// A candidate is an `openspec/changes/archive/<date>-<name>/` on `ref` (origin/develop) that is
//   - added by `author`: the commit that adds the directory, on the merged side of its merge,
//     has that author name or email;
//   - on or after `since` (the final-flow cut, a commit or a date the caller passes): its merge
//     commit is `since` or a descendant of it, or is committed on or after the date;
//   - regular: plan.md, verify.md, review.md and ledger.jsonl are present;
// plus every change named in `names` (a change name or an archive directory), whatever the
// rules say: `named: true`, and `regular` tells whether it would have passed.
//
// For each: the merge commit m (the first first-parent commit of `ref` that touches the
// directory), the merge request number and the branch from m's message, and the base. The base
// is exact when a local branch of that name survives: the parent of the first first-parent
// commit of the branch that `ref` does not hold, when that parent is in m^1 (history `branch`). Otherwise it is m^1, which a
// squash applies to exactly, with `exact: false` (history `no-branch`).
//
//   node scripts/parity/lib/replay-candidates.mjs <origin> --since <commit|date> [--author <name>] [--name <change>]...
//
// The author defaults to `git config user.name` of the origin.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ARCHIVE = 'openspec/changes/archive'
export const REQUIRED = ['plan.md', 'verify.md', 'review.md', 'ledger.jsonl']

function gitOn(dir) {
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim()
  git.orNull = (...args) => {
    try {
      return git(...args)
    } catch {
      return null
    }
  }
  return git
}

const changeName = (dir) => dir.replace(/^\d{4}-\d{2}-\d{2}-/, '')

export function parseMergeMessage(message) {
  const branch = /^Merge branch '([^']+)' into /m.exec(message)?.[1] ?? null
  const mr = /^See merge request \S*!(\d+)\s*$/m.exec(message)?.[1]
  return { branch, mergeRequest: mr ? Number(mr) : null }
}

export function findCandidates(originDir, { author, since, names = [], ref = 'origin/develop' } = {}) {
  if (typeof author !== 'string' || author.trim() === '') throw new Error('findCandidates: author is required')
  if (typeof since !== 'string' || since.trim() === '') throw new Error('findCandidates: since (a commit or a date) is required')
  const git = gitOn(realpathSync(originDir))
  const tip = git('rev-parse', '--verify', `${ref}^{commit}`)
  const sinceCommit = git.orNull('rev-parse', '--verify', '--quiet', `${since}^{commit}`)
  const sinceDate = sinceCommit ? null : new Date(since)
  if (!sinceCommit && Number.isNaN(sinceDate.getTime())) throw new Error(`findCandidates: since "${since}" is neither a commit nor a date`)

  // Every archive directory on ref, with its top-level entries.
  const entries = new Map()
  for (const line of git('ls-tree', '-r', '--name-only', tip, '--', `${ARCHIVE}/`).split('\n').filter(Boolean)) {
    const [dir, top] = line.slice(ARCHIVE.length + 1).split('/')
    if (!top) continue
    if (!entries.has(dir)) entries.set(dir, new Set())
    entries.get(dir).add(top)
  }
  const wanted = new Set(names)
  const unknown = names.filter((n) => ![...entries.keys()].some((dir) => dir === n || changeName(dir) === n))
  if (unknown.length) throw new Error(`findCandidates: no archived change named ${unknown.join(', ')} on ${ref}`)

  const out = []
  for (const [dir, files] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const name = changeName(dir)
    const named = wanted.has(dir) || wanted.has(name)
    const regular = REQUIRED.every((f) => files.has(f))
    if (!regular && !named) continue
    const path = `${ARCHIVE}/${dir}`

    const touching = git('log', '--first-parent', '--format=%H', tip, '--', path).split('\n').filter(Boolean)
    const m = touching.at(-1)
    const [parents, date, message] = git('show', '-s', '--format=%P%x00%cI%x00%B', m).split('\0')
    const [first] = parents.split(' ').filter(Boolean)
    const merged = first ? `${first}..${m}` : m
    const [adder, authorName, authorEmail] = (git('log', '--no-merges', '--diff-filter=A', '--format=%H%x00%an%x00%ae', merged, '--', path).split('\n').filter(Boolean).at(-1) ?? '').split('\0')
    const byAuthor = authorName === author || (authorEmail ?? '').toLowerCase() === author.toLowerCase()
    const inRange = sinceCommit ? git.orNull('merge-base', '--is-ancestor', sinceCommit, m) !== null : new Date(date) >= sinceDate
    if (!named && !(byAuthor && inRange)) continue

    const { branch, mergeRequest } = parseMergeMessage(message)
    let base = { commit: first ?? null, exact: false }
    let history = 'no-branch'
    let note = null
    if (branch && first && git('for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) === `refs/heads/${branch}`) {
      const own = git('rev-list', '--first-parent', '--reverse', `refs/heads/${branch}`, '--not', tip).split('\n').filter(Boolean)
      const fork = own.length ? git.orNull('rev-parse', '--verify', '--quiet', `${own[0]}^`) : null
      if (fork && git.orNull('merge-base', '--is-ancestor', fork, first) !== null) {
        base = { commit: fork, exact: true }
        history = 'branch'
      } else {
        note = own.length
          ? `the local branch ${branch} does not fork from ${ref} before the merge; the base is m^1`
          : `the local branch ${branch} has no commit ${ref} lacks; the base is m^1`
      }
    }

    const tasks = files.has('tasks.md') ? (git('show', `${tip}:${path}/tasks.md`).match(/^\s*- \[[ xX]\]/gm) ?? []).length : 0
    out.push({
      name,
      dir,
      tasks,
      artifacts: [...files].sort(),
      regular,
      named,
      author: { name: authorName ?? null, email: authorEmail ?? null, commit: adder || null },
      merge: m,
      date,
      mergeRequest,
      branch,
      base,
      history,
      ...(note ? { note } : {})
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.dir.localeCompare(b.dir))
}

const short = (sha) => (sha ? sha.slice(0, 8) : '-')

export function table(candidates) {
  const rows = [['change', 'tasks', 'merge', 'MR', 'branch', 'base', 'history', 'flags']]
  for (const c of candidates) {
    const flags = [c.named ? 'named' : '', c.regular ? '' : 'irregular', c.note ? 'note' : ''].filter(Boolean).join(',')
    rows.push([c.dir, String(c.tasks), short(c.merge), c.mergeRequest ? `!${c.mergeRequest}` : '-', c.branch ?? '-', `${short(c.base.commit)}${c.base.exact ? ' exact' : ' m^1'}`, c.history, flags || '-'])
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const origin = args[0]
  const value = (flag) => {
    const i = args.indexOf(flag)
    return i === -1 ? undefined : args[i + 1]
  }
  const names = args.flatMap((a, i) => (args[i - 1] === '--name' ? [a] : []))
  if (!origin || origin.startsWith('--') || !value('--since')) {
    console.error('usage: node scripts/parity/lib/replay-candidates.mjs <origin> --since <commit|date> [--author <name>] [--name <change>]... [--json]')
    process.exit(2)
  }
  const author = value('--author') ?? gitOn(origin).orNull('config', 'user.name')
  const found = findCandidates(origin, { author, since: value('--since'), names })
  console.log(args.includes('--json') ? JSON.stringify(found, null, 2) : table(found))
}
