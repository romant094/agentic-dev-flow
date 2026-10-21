#!/usr/bin/env node
// Dev tool: replays the verify checks of plugins/adf/scripts/lib/verify.mjs on the origin's
// archived changes and compares each result with the section the origin's verify.md recorded.
// The origin has no script for these checks (an agent ran them as prose), so the comparison is
// against the record, not against a second implementation. Nothing is written in the origin:
// one `git clone --shared --no-checkout` of it is made under the system temp directory, and
// every replay is a detached checkout inside that clone.
//
//   node scripts/parity/origin-verify-history.mjs <origin project root> [--all]
//
// --all also prints every difference, explained ones included.
//
// For each `openspec/changes/archive/<date>-<name>/`: the commit that last wrote
// `openspec/changes/<name>/verify.md` on any ref (before the archive move) is the replay point.
// Its base is the `origin/develop` of `origin/develop..HEAD`: the merge-base with develop for a
// branch develop does not contain (squash-merged, still kept as a ref), else the first parent
// of the develop merge that brought it in. The clone is checked out at the replay point, an
// `.adf.json` naming that base is written into the change directory, the full shas the
// record's check 8 names as approved skill edits are passed as skill edits, and `runChecks`
// runs. Three checks are compared (origin template numbering):
//   2  Task completion       tasks        verdict pass/fail, and the ticked/unticked counts
//                                         when the record states them
//   3  Delta spec sync state deltas       each capability's state when the record has a
//                                         table, else the verdict
//   10 Out-of-plan commits   out-of-plan  every file the port reports must be one the record
//                                         names, or carry a label below
// Check 7 (leftover group worktrees) is not replayed: worktree state is not in history.
//
// Skipped, and counted, per change: `no-record` (the archive holds no verify.md),
// `free-form-record` (no numbered `## 2.` section: written outside the template),
// `no-history` (no ref holds the record before the archive move: the branch was squash-merged
// and deleted), `no-merge` (the replay commit is on develop's first-parent line). Per check:
// `no-section` (the record predates the check), `unparsed-section` (no verdict to read).
//
// Explained differences, deliberate in the port (the verify lessons of iteration 08):
//   allowlist           the origin allowed `openspec/changes/**` and `.claude-reports/**`; the
//                       port allows only the change's own directory (host globs come from
//                       outsidePlan, absent in the origin)
//   memory-workflow     a `.claude/memory/` file the origin's memory workflow writes; the port's
//                       memory log arrives with the wiki memory
//   superpowers         a committed `.superpowers/` file; the port's init ignores the directory
//   recorded            the record names the file: the origin found it and accepted it with a
//                       reason, which the port expresses as a developer ruling
//   narrowed-range      the record checked a narrower range than base..HEAD and says so
//   backtick-added-line the file is named only on a Files bullet the port reports as unparsed
//                       and that reads "added" (an unbackticked "Added during apply" line)
//   unparsed-bullet     as above, on any other unparsed Files bullet (the port warns on it)
//   prose-expansion     a Files bullet names the file only by prose ("the same two files for
//                       `X`"); the plan instruction requires a backticked path per file
//   no-plan             the change has no plan.md: the port fails, the origin passed vacuously
//   needs-sync-warn     the record counted a pending delta as a pass; the port warns
// Explained differences that are origin defects (the origin's verify was wrong):
//   stale-section       out-of-plan: the section is worded as when the record was first
//                       written, and the file arrived in a later commit, so the check was not
//                       re-run; deltas: the record names a delta the replay commit itself moved
//                       out of the change
//   skill-edit-outside-skills  a check 8 approved skill-edit commit touched a file outside
//                       `.claude/skills/`, which the origin's own template does not exempt
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecks } from '../../plugins/adf/scripts/lib/verify.mjs'

const origin = process.argv[2]
const listAll = process.argv.includes('--all')
if (!origin || !existsSync(join(origin, 'openspec', 'changes', 'archive'))) {
  console.error('usage: origin-verify-history.mjs <origin project root with openspec/changes/archive>')
  process.exit(2)
}

const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim()
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- record parsing

// Sections keyed by number: `## 10. Out-Of-Plan Commits` or `## Check 10 — Out-of-plan commits`.
export function recordSections(text) {
  const sections = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const h = /^##\s+(?:Check\s+)?(\d+)\b/.exec(line)
    if (h) {
      current = Number(h[1])
      sections.set(current, '')
    } else if (/^##\s/.test(line)) current = null
    else if (current !== null) sections.set(current, `${sections.get(current)}${line}\n`)
  }
  return sections
}

const firstNumber = (text, patterns) => {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return Number(m[1])
  }
  return null
}

export function recordedTasks(section) {
  const box = /^\s*-\s+\[([ xX])\]\s+Every/m.exec(section)
  const ticked = firstNumber(section, [/(?<!un)checked:\s*(\d+)/i, /\bx=(\d+)/, /ticked:\s*(\d+)/i, /`- \[x\]`:\s*(\d+)/i, /(\d+)\s+of\s+\d+\s+(?:ticked|checked|checkboxes)/i, /(\d+)\s+(?:tasks?\s+|checkboxes,?\s+|items,?\s+|`- \[x\]`,?\s+)?(?:ticked|checked)\b/i])
  const open = firstNumber(section, [/unchecked:\s*(\d+)/i, /\bopen=(\d+)/, /unticked:\s*(\d+)/i, /`- \[ \]`:\s*(\d+)/i, /(\d+)\s+(?:unticked|unchecked|open|remaining)\b/i, /(\d+)\s+`- \[ \]`/])
  let verdict = null
  if (box) verdict = box[1] === ' ' ? 'fail' : 'pass'
  else if (open !== null) verdict = open === 0 ? 'pass' : 'fail'
  else if (/\bFAIL\b/.test(section)) verdict = 'fail'
  else if (/\bPASS\b/.test(section)) verdict = 'pass'
  return { verdict, ticked, open }
}

const deltaWord = (cell) => {
  if (/N\/A/i.test(cell)) return 'n/a'
  if (/conflict/i.test(cell)) return 'conflict'
  if (/pending|needs sync|not yet|unmerged/i.test(cell)) return 'needs sync'
  if (/synced|already|merged/i.test(cell)) return 'synced'
  return null
}

export function recordedDeltas(section) {
  const rows = new Map()
  for (const line of section.split('\n')) {
    const m = /^\|\s*`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*\|\s*([^|]+)\|/.exec(line)
    if (m && deltaWord(m[2])) rows.set(m[1], deltaWord(m[2]))
  }
  let verdict = null
  if (rows.size > 0) {
    const states = [...rows.values()]
    verdict = states.includes('conflict') ? 'fail' : states.includes('needs sync') ? 'warn' : 'pass'
  } else if (/needs sync|pending|WARN/i.test(section)) verdict = 'warn'
  else if (/\bN\/A\b|no delta spec/i.test(section)) verdict = 'pass'
  else if (/already synced|\bsynced\b/i.test(section)) verdict = 'pass'
  return { verdict, rows }
}

// Backticked path-like tokens of a text, without a leading `.../` and a trailing `:lines`.
const pathTokens = (text) =>
  [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/^\.\.\.\//, '').replace(/:[\d,-]+$/, '')).filter((t) => /[./]/.test(t))

// The record names a file when its full path appears, or a backticked token that is the
// file's path or a tail of it (`__tests__/a.spec.ts`, `.../x/a.ts`, `a.ts`).
export function recordNames(section, file) {
  if (section.includes(file)) return true
  return pathTokens(section).some((t) => file === t || file.endsWith(`/${t}`))
}

// An unparsed Files bullet names a file when a token is the file's path or a directory above it.
const bulletNames = (line, file) =>
  pathTokens(line).some((t) => file === t || (t.endsWith('/') && file.startsWith(t)) || file.endsWith(`/${t}`))

// A plan line that names the file only by prose: "`a/X/f.json`, `g.json`; the same two files
// for `Y`, `Z`" names Y's and Z's files by no path of their own.
export function proseExpands(planText, file) {
  const segments = file.split('/')
  const name = segments.at(-1)
  return planText
    .split('\n')
    .some((l) => /\bthe same\b/i.test(l) && l.includes(name) && [...l.matchAll(/`([^`]+)`/g)].some((m) => segments.slice(0, -1).includes(m[1])))
}

// ---------------------------------------------------------------- history

const MAIN = attempt(() => git(origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/develop')) ? 'develop' : 'HEAD'
const firstParent = git(origin, 'rev-list', '--first-parent', MAIN).split('\n')
const firstParentIndex = new Map(firstParent.map((sha, i) => [sha, i]))

// The branch's base. A commit develop does not contain (a squash-merged branch still kept as a
// ref) forked from its merge-base with develop. A commit develop contains came in through a
// develop merge, whose first parent is the base; one on develop's first-parent line has none.
function baseOf(sha) {
  if (firstParentIndex.has(sha)) return null
  if (attempt(() => git(origin, 'merge-base', '--is-ancestor', sha, MAIN)) === null) {
    return attempt(() => git(origin, 'merge-base', sha, MAIN))
  }
  const descendants = git(origin, 'rev-list', '--ancestry-path', `${sha}..${MAIN}`).split('\n')
  let merge = null
  for (const d of descendants) {
    const i = firstParentIndex.get(d)
    if (i !== undefined && (merge === null || i > firstParentIndex.get(merge))) merge = d
  }
  return merge ? git(origin, 'rev-parse', `${merge}^1`) : null
}

// ---------------------------------------------------------------- replay

const clone = mkdtempSync(join(tmpdir(), 'adf-parity-verify-'))
const differences = []
const skipped = {}
const compared = { tasks: 0, deltas: 0, 'out-of-plan': 0 }
const skip = (label, check = 'change') => {
  const key = `${check}:${label}`
  skipped[key] = (skipped[key] ?? 0) + 1
}
const differ = (change, check, explained, detail) => differences.push({ change, check, explained, ...detail })

const archiveDirs = readdirSync(join(origin, 'openspec', 'changes', 'archive'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
  .map((e) => e.name)
  .sort()

try {
  git(tmpdir(), 'clone', '--quiet', '--shared', '--no-checkout', origin, clone)
  for (const dir of archiveDirs) {
    const change = dir.slice('YYYY-MM-DD-'.length)
    const recordPath = `openspec/changes/${change}/verify.md`
    const sha = attempt(() => git(origin, 'log', '--all', '--full-history', '-1', '--format=%H', '--diff-filter=AM', '--', recordPath))
    const archived = join(origin, 'openspec', 'changes', 'archive', dir, 'verify.md')
    if (!existsSync(archived)) {
      skip('no-record')
      continue
    }
    if (!recordSections(readFileSync(archived, 'utf8')).has(2)) {
      skip('free-form-record')
      continue
    }
    if (!sha) {
      skip('no-history')
      continue
    }
    const sections = recordSections(git(origin, 'show', `${sha}:${recordPath}`))
    // The commit that first wrote the record: a section still worded as it was then was not
    // re-run for the commits that came after it.
    const firstSha = git(origin, 'log', '--all', '--full-history', '--format=%H', '--diff-filter=A', '--', recordPath).split('\n').at(-1)
    const firstSections = recordSections(git(origin, 'show', `${firstSha}:${recordPath}`))
    const unchangedSince = (n) => firstSha !== sha && (firstSections.get(n) ?? '').trim() === (sections.get(n) ?? '').trim()
    const deletedHere = git(origin, 'show', '--format=', '--name-only', '--no-renames', '--diff-filter=D', sha).split('\n')
    const base = baseOf(sha)
    if (!base) {
      skip('no-merge')
      continue
    }

    git(clone, 'checkout', '--quiet', '--force', '--detach', sha)
    git(clone, 'clean', '-fdxq')
    const changeRoot = join(clone, 'openspec', 'changes', change)
    writeFileSync(join(changeRoot, '.adf.json'), `${JSON.stringify({ base }, null, 2)}\n`)
    const approved = [...(/\*\*Approved skill-edit commit\(s\)\*\*:?(.*)/.exec(sections.get(8) ?? '')?.[1] ?? '').matchAll(/\b[0-9a-f]{40}\b/g)]
      .map((m) => m[0])
      .filter((s) => attempt(() => git(clone, 'rev-parse', '--verify', '--quiet', `${s}^{commit}`)))
    const run = runChecks(clone, { change, skillEdits: approved })
    const result = Object.fromEntries(run.checks.map((c) => [c.id, c]))
    const output = (id) => readFileSync(join(clone, result[id].output), 'utf8')

    // 2. Task completion
    const tasksRec = recordedTasks(sections.get(2))
    if (tasksRec.verdict === null) skip('unparsed-section', 'tasks')
    else {
      compared.tasks++
      const [, done, total] = /^(\d+) of (\d+) ticked/.exec(output('tasks')) ?? []
      const ours = { verdict: result.tasks.verdict, ticked: Number(done), open: Number(total) - Number(done) }
      if (ours.verdict !== tasksRec.verdict) differ(change, 'tasks', null, { recorded: tasksRec, port: ours })
      else if ((tasksRec.ticked !== null && tasksRec.ticked !== ours.ticked) || (tasksRec.open !== null && tasksRec.open !== ours.open)) {
        differ(change, 'tasks', null, { recorded: tasksRec, port: ours, note: 'counts differ' })
      }
    }

    // 3. Delta spec sync state
    const deltasRec = recordedDeltas(sections.get(3) ?? '')
    if (!sections.has(3) || deltasRec.verdict === null) skip(sections.has(3) ? 'unparsed-section' : 'no-section', 'deltas')
    else {
      compared.deltas++
      const ours = new Map(
        [...output('deltas').matchAll(/^([a-z0-9-]+): (synced|needs sync|conflict)/gm)].map((m) => [m[1], m[2]])
      )
      if (deltasRec.rows.size > 0) {
        for (const name of new Set([...deltasRec.rows.keys(), ...ours.keys()])) {
          const theirs = deltasRec.rows.get(name) ?? null
          const port = ours.get(name) ?? (ours.size === 0 ? 'n/a' : null)
          if (theirs === port) continue
          // The record names a delta the replay commit itself moved out of the change.
          const stale = port === null && deletedHere.includes(`openspec/changes/${change}/specs/${name}/spec.md`)
          differ(change, 'deltas', stale ? 'stale-section' : null, { capability: name, recorded: theirs, port })
        }
      } else if (deltasRec.verdict !== result.deltas.verdict) {
        const explained = deltasRec.verdict === 'pass' && result.deltas.verdict === 'warn' ? 'needs-sync-warn' : null
        differ(change, 'deltas', explained, { recorded: deltasRec.verdict, port: result.deltas.verdict })
      }
    }

    // 10. Out-of-plan commits
    const s10 = sections.get(10)
    if (s10 === undefined) skip('no-section', 'out-of-plan')
    else {
      compared['out-of-plan']++
      const text = output('out-of-plan')
      if (result['out-of-plan'].verdict === 'fail' && /has no plan\.md/.test(result['out-of-plan'].summary)) {
        differ(change, 'out-of-plan', 'no-plan', { port: result['out-of-plan'].summary })
      } else {
        const planText = readFileSync(join(changeRoot, 'plan.md'), 'utf8')
        const unparsed = [...text.matchAll(/^ {2}Task \d+: (.*)$/gm)].map((m) => m[1])
        const checked = /Commits checked:[^\n`]*`([0-9a-f]{7,40})(~1)?\.\.\.?/.exec(s10)
        const narrowed =
          checked && /own range|this change's own|Scoped to/i.test(s10)
            ? new Set(git(clone, 'rev-list', `${checked[1]}${checked[2] ?? ''}..HEAD`).split('\n'))
            : null
        for (const m of text.matchAll(/^ {2}([0-9a-f]{40}) (.+) \((.+)\)$/gm)) {
          const [, commit, file] = m
          const line = unparsed.find((l) => bulletNames(l, file))
          let explained = null
          if (file.startsWith('openspec/changes/') || file.startsWith('.claude-reports/')) explained = 'allowlist'
          else if (approved.includes(commit)) explained = 'skill-edit-outside-skills'
          else if (recordNames(s10, file)) explained = 'recorded'
          else if (file.startsWith('.claude/memory/')) explained = 'memory-workflow'
          else if (file.startsWith('.superpowers/')) explained = 'superpowers'
          else if (narrowed && !narrowed.has(commit)) explained = 'narrowed-range'
          else if (line) explained = /added/i.test(line) ? 'backtick-added-line' : 'unparsed-bullet'
          else if (proseExpands(planText, file)) explained = 'prose-expansion'
          else if (unchangedSince(10) && attempt(() => git(clone, 'merge-base', '--is-ancestor', commit, firstSha)) === null) {
            explained = 'stale-section'
          }
          differ(change, 'out-of-plan', explained, { commit: commit.slice(0, 8), file })
        }
      }
    }
  }
} finally {
  rmSync(clone, { recursive: true, force: true })
}

const unexplained = differences.filter((d) => d.explained === null)
const explained = {}
for (const d of differences) if (d.explained) explained[d.explained] = (explained[d.explained] ?? 0) + 1
console.log(
  JSON.stringify(
    { changes: archiveDirs.length, compared, skipped, differences: differences.length, explained, unexplained, ...(listAll ? { all: differences } : {}) },
    null,
    2
  )
)
process.exitCode = unexplained.length === 0 ? 0 : 1
