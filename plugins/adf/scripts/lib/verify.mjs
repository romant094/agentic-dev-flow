// The mechanical checks of verify, and the verdict over every section of the record.
//
// `runChecks` runs each check against the change worktree, writes its raw output to
// `<root>/.superpowers/sdd/<change>/verify/<id>.txt` and returns one result per check:
// { id, title, verdict: pass | warn | fail | not-run, summary, output } with `output` relative
// to the root. The list is kept in `verify/run.json`. Judgement checks are agent dispatches
// that write a section of the same shape as `verify/<id>.json`; `computeVerdict` reads both,
// applies the developer's rulings from the ledger, and computes the verdict line.
//
// Every git call runs at the root: from a subdirectory a scan silently narrows.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changeDir, globToRegExp, META_FILE, parseTasks } from './changes.mjs'
import { baseCheckPath, listGroups } from './groups.mjs'
import { commitPaths } from './commit.mjs'
import { appendRecord, readRecords, SESSION_ENV, skillEditShas } from './ledger.mjs'
import { baseRef, EXTENSIONS } from './plan-symbols.mjs'
import { readRegistry } from './registry.mjs'
import { extractRequirementsSection, parseDeltaSpec, validateProject } from './specs.mjs'
import { gitIn } from './workspace.mjs'

export const CHECKS = {
  validation: 'Structural validation',
  tasks: 'Task completion',
  deltas: 'Delta spec sync state',
  tree: 'Implementation signal',
  'test-record': 'Apply test record',
  worktrees: 'No leftover worktrees',
  'out-of-plan': 'Out-of-plan commits'
}
// A ruling never turns these into warnings: uncommitted work is outside every range a later
// stage reads, and a leftover worktree is an apply that stopped.
export const UNACCEPTABLE = ['tree', 'worktrees']
// An agent's section may replace only the test record's result: the re-run of a stale record.
export const REPLACEABLE = ['test-record']
export const VERDICTS = ['pass', 'warn', 'fail', 'not-run']
export const RECORD_FILE = '.apply-test-record.md'
// The `**Commit:**` field of the apply test record, on a line of its own.
export const RECORD_COMMIT = /^\*\*Commit:\*\*[ \t]*`?([0-9a-f]{7,40})`?[ \t]*$/m
// Judgement sections every verify writes; a verdict without one of them is refused.
export const REQUIRED_SECTIONS = ['c4', 'c8']
export const DEVELOPER_ID = 'developer'
export const SKILLS_DIR = '.claude/skills/'

export const verifyDir = (root, change) => join(root, '.superpowers', 'sdd', change, 'verify')
const relOutput = (change, file) => `.superpowers/sdd/${change}/verify/${file}`
const changePrefix = (change) => `openspec/changes/${change}/`

function attempt(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

// `git log --name-only` over a range: [{ sha, files }]. Renames are split into a deletion and
// an addition, so both paths are accounted for.
function commitsIn(git, range) {
  const text = git('log', '--no-renames', '--name-only', '--format=%x1e%H', range)
  return text
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, ...files] = chunk.split('\n').map((l) => l.trim())
      return { sha, files: files.filter(Boolean) }
    })
}

function readMeta(root, change) {
  return attempt(() => JSON.parse(readFileSync(join(changeDir(root, change), META_FILE), 'utf8')))
}

function resolveBase(root, change, git) {
  const meta = readMeta(root, change)
  if (!meta) return { error: `cannot read ${changePrefix(change)}${META_FILE}` }
  try {
    return { ref: baseRef(meta, (name) => attempt(() => git('rev-parse', '--verify', '--quiet', name)) !== null) }
  } catch (error) {
    return { error: error.message }
  }
}

// ---------------------------------------------------------------- checks

function checkValidation(root, change) {
  let own
  try {
    own = validateProject(root, { change, strict: true })
  } catch (error) {
    return { verdict: 'fail', summary: error.message, text: error.message }
  }
  const item = own.items[0]
  const lines = [`change ${change}, strict: ${item.valid ? 'valid' : 'invalid'}`]
  for (const issue of item.issues) lines.push(`  ${issue.level} ${issue.path}: ${issue.message}`)
  // The corpus run is advisory: an inherited invalid item is not this change's failure.
  const corpus = attempt(() => validateProject(root, { strict: true }))
  const others = (corpus?.items ?? []).filter((i) => !(i.type === 'change' && i.id === change) && !i.valid)
  lines.push('', `advisory, the rest of the corpus (strict): ${others.length === 0 ? 'every item valid' : `${others.length} invalid`}`)
  for (const other of others) {
    lines.push(`  ${other.type} ${other.id}`)
    for (const issue of other.issues) lines.push(`    ${issue.level} ${issue.path}: ${issue.message}`)
  }
  const errors = item.issues.length
  return item.valid
    ? { verdict: 'pass', summary: `${change} validates strictly`, text: lines.join('\n') }
    : { verdict: 'fail', summary: `${change} has ${errors} validation issue${errors === 1 ? '' : 's'}`, text: lines.join('\n') }
}

function checkTasks(root, change, tracks) {
  const path = join(changeDir(root, change), tracks)
  if (!existsSync(path)) return { verdict: 'fail', summary: `${change} has no ${tracks}`, text: `${path} is missing` }
  const tasks = parseTasks(readFileSync(path, 'utf8'))
  const open = tasks.filter((t) => !t.done)
  const text = [`${tasks.length - open.length} of ${tasks.length} ticked`, ...open.map((t) => `open: ${t.description}`)].join('\n')
  if (tasks.length === 0) return { verdict: 'fail', summary: `${tracks} lists no tasks`, text }
  if (open.length > 0) return { verdict: 'fail', summary: `${open.length} of ${tasks.length} tasks open`, text, open: open.map((t) => t.description) }
  return { verdict: 'pass', summary: `all ${tasks.length} tasks ticked`, text }
}

const sameBlock = (a, b) => a.split('\n').map((l) => l.trimEnd()).join('\n').trim() === b.split('\n').map((l) => l.trimEnd()).join('\n').trim()

// One capability's delta against its main spec: synced, needs sync, or conflict (a delta
// archive could not apply: it modifies, removes or renames a requirement the main spec lacks,
// or adds one the main spec already holds with other text).
export function deltaState(deltaText, mainText) {
  const delta = parseDeltaSpec(deltaText)
  const main = new Map(
    (mainText === null ? [] : extractRequirementsSection(mainText).bodyBlocks).map((b) => [b.name, b.raw])
  )
  const pending = []
  const conflicts = []
  const renamedTo = new Set()
  for (const { from, to } of delta.renamed) {
    if (main.has(to) && !main.has(from)) continue
    if (main.has(from) && !main.has(to)) {
      pending.push(`RENAMED ${from} -> ${to}`)
      renamedTo.add(to)
    } else conflicts.push(`RENAMED ${from} -> ${to}: the main spec holds ${main.has(from) ? 'both names' : 'neither name'}`)
  }
  for (const block of delta.added) {
    if (!main.has(block.name)) pending.push(`ADDED ${block.name}`)
    else if (!sameBlock(main.get(block.name), block.raw)) conflicts.push(`ADDED ${block.name}: the main spec already holds it with other text`)
  }
  for (const block of delta.modified) {
    if (main.has(block.name)) {
      if (!sameBlock(main.get(block.name), block.raw)) pending.push(`MODIFIED ${block.name}`)
    } else if (renamedTo.has(block.name)) pending.push(`MODIFIED ${block.name}`)
    else conflicts.push(`MODIFIED ${block.name}: not in the main spec`)
  }
  for (const name of delta.removed) if (main.has(name)) pending.push(`REMOVED ${name}`)
  const state = conflicts.length > 0 ? 'conflict' : pending.length > 0 ? 'needs sync' : 'synced'
  return { state, pending, conflicts }
}

function checkDeltas(root, change) {
  const specsDir = join(changeDir(root, change), 'specs')
  const capabilities = existsSync(specsDir)
    ? readdirSync(specsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(specsDir, e.name, 'spec.md')))
        .map((e) => e.name)
        .sort()
    : []
  if (capabilities.length === 0) return { verdict: 'pass', summary: 'N/A: the change has no delta specs', text: 'no delta specs' }
  const lines = []
  const byState = { synced: [], 'needs sync': [], conflict: [] }
  for (const name of capabilities) {
    const mainPath = join(root, 'openspec', 'specs', name, 'spec.md')
    const mainText = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : null
    const result = deltaState(readFileSync(join(specsDir, name, 'spec.md'), 'utf8'), mainText)
    byState[result.state].push(name)
    lines.push(`${name}: ${result.state}${mainText === null ? ' (no main spec yet)' : ''}`)
    for (const item of [...result.conflicts, ...result.pending]) lines.push(`  ${item}`)
  }
  const text = lines.join('\n')
  if (byState.conflict.length > 0) return { verdict: 'fail', summary: `cannot be merged at archive: ${byState.conflict.join(', ')}`, text }
  if (byState['needs sync'].length > 0) return { verdict: 'warn', summary: `needs sync, expected before archive: ${byState['needs sync'].join(', ')}`, text }
  return { verdict: 'pass', summary: `already synced: ${byState.synced.join(', ')}`, text }
}

function checkTree(git, base) {
  const status = git('status', '--porcelain', '--untracked-files=all')
  const lines = [`git status --porcelain:`, status || '(clean)']
  const problems = []
  if (status) problems.push(`${status.split('\n').length} uncommitted path(s)`)
  if (base.error) {
    lines.push('', `range: ${base.error}`)
    problems.push('no base ref for the range')
  } else {
    const log = git('log', '--oneline', `${base.ref}..HEAD`)
    lines.push('', `range ${base.ref}..HEAD:`, log || '(empty)')
    if (!log) problems.push(`the range ${base.ref}..HEAD is empty`)
  }
  const text = lines.join('\n')
  if (problems.length > 0) return { verdict: 'fail', summary: problems.join('; '), text }
  return { verdict: 'pass', summary: `clean; ${git('rev-list', '--count', `${base.ref}..HEAD`)} commit(s) in ${base.ref}..HEAD`, text }
}

// Numbers a test summary states as counts: "15 passed", "17 tests", "3/3 suites",
// "pass 15", "PASS (15)", "# tests 4".
const COUNT_WORDS = 'tests?|specs?|pass(?:ed|es|ing)?|fail(?:ed|s|ing|ures?)?|suites?|files?|cases?|ok'
export function countsIn(text) {
  const counts = []
  const after = new RegExp(`(\\d+)(?:\\s*/\\s*\\d+)?\\s+(?:${COUNT_WORDS})\\b`, 'gi')
  const before = new RegExp(`\\b(?:${COUNT_WORDS})\\s*[:=(]?\\s*(\\d+)`, 'gi')
  for (const m of String(text ?? '').matchAll(after)) counts.push(Number(m[1]))
  for (const m of String(text ?? '').matchAll(before)) counts.push(Number(m[1]))
  return counts
}

// impl and fix replies of the SDD workspace whose test summary carries no count, or a count
// larger than any the apply record shows: one task's tests are a part of the whole suite.
export function reconcileCounts(root, change, recordText) {
  const dir = join(root, '.superpowers', 'sdd', change, 'replies')
  if (!existsSync(dir)) return { replies: 0, warnings: [] }
  const recordMax = Math.max(0, ...countsIn(recordText))
  const warnings = []
  let replies = 0
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const reply = attempt(() => JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (!reply || (reply.role !== 'impl' && reply.role !== 'fix') || typeof reply.tests?.summary !== 'string') continue
    replies++
    const counts = countsIn(reply.tests.summary)
    if (counts.length === 0) warnings.push(`${file}: the test summary "${reply.tests.summary}" carries no count`)
    else if (recordText !== null && Math.max(...counts) > recordMax) {
      warnings.push(`${file}: the test summary "${reply.tests.summary}" counts more than the apply record (${recordMax})`)
    }
  }
  return { replies, warnings }
}

function checkTestRecord(root, change, git) {
  const path = join(changeDir(root, change), RECORD_FILE)
  const recordText = existsSync(path) ? readFileSync(path, 'utf8') : null
  const counts = reconcileCounts(root, change, recordText)
  const countLines = [`test counts: ${counts.replies} impl/fix repl${counts.replies === 1 ? 'y' : 'ies'} read`, ...counts.warnings.map((w) => `  warning: ${w}`)]
  const done = (verdict, summary, lines) => ({ verdict, summary, text: [...lines, '', ...countLines].join('\n'), countWarnings: counts.warnings })
  if (recordText === null) return done('fail', 'no apply test record: run the suite', [`${changePrefix(change)}${RECORD_FILE} is missing`])
  // Only the record's own field counts: a "commit <hex>" inside quoted runner output is not it.
  const m = RECORD_COMMIT.exec(recordText)
  if (!m) return done('fail', 'the apply test record names no commit: run the suite', ['no `**Commit:** <sha>` line in the record'])
  const sha = attempt(() => git('rev-parse', '--verify', '--quiet', `${m[1]}^{commit}`))
  if (!sha || attempt(() => git('merge-base', '--is-ancestor', sha, 'HEAD')) === null) {
    return done('fail', `the recorded commit ${m[1]} is not in this branch: run the suite`, [`record commit: ${m[1]}`])
  }
  const prefix = changePrefix(change)
  const after = commitsIn(git, `${sha}..HEAD`)
  const stale = after
    .map((c) => ({ ...c, outside: c.files.filter((f) => !f.startsWith(prefix)) }))
    .filter((c) => c.outside.length > 0)
  const lines = [`record commit: ${sha}`, `commits since: ${after.length}, outside ${prefix}: ${stale.length}`]
  for (const c of stale) lines.push(`  ${c.sha}`, ...c.outside.map((f) => `    ${f}`))
  if (stale.length > 0) return done('fail', 'stale: re-run the suite', lines)
  if (counts.warnings.length > 0) return done('warn', `the record is current; ${counts.warnings.length} test count warning(s)`, lines)
  return done('pass', `the record is current at ${sha.slice(0, 7)}`, lines)
}

function checkWorktrees(root, change, git) {
  const groups = listGroups(root, change)
  const baseCheck = baseCheckPath(root, change)
  const listing = attempt(() => git('worktree', 'list', '--porcelain')) ?? ''
  const leftovers = [...groups.map((g) => g.root), ...(listing.split('\n').includes(`worktree ${baseCheck}`) ? [baseCheck] : [])]
  const text = [`git worktree list --porcelain:`, listing, '', `leftover worktrees of ${change}: ${leftovers.length === 0 ? 'none' : ''}`, ...leftovers.map((p) => `  ${p}`)].join('\n')
  if (leftovers.length > 0) return { verdict: 'fail', summary: `${leftovers.length} leftover worktree(s): ${leftovers.join(', ')}`, text }
  return { verdict: 'pass', summary: 'no group or base-check worktree of this change', text }
}

const stripDot = (p) => p.replace(/^\.\//, '')

// Every path a plan's `**Files:**` blocks name, for the out-of-plan check. plan-symbols reads a
// bullet's path list only up to the first prose, which suits its existence check; here every
// backticked path-like token of the bullet counts: "`a.ts` (note), `b.ts`" names both, and so do
// a Move's two ends or any other verb's. A `:12-30` suffix is dropped. A bare file name is a
// sibling of the bullet's first path, and may also be the file at the repository root. A
// bullet or line naming no backticked path is unparsed, unless it is a no-op (`<Verb>: none`,
// `Revert: commits …`).
const PATH_TOKEN = new RegExp(`^[^\\s()\`]+$`)
const PATH_EXT = new RegExp(`\\.(?:${EXTENSIONS})$`)
const isPlanPath = (t) => PATH_TOKEN.test(t) && (t.includes('/') || PATH_EXT.test(t))

function filesBlock(lines, from) {
  const out = []
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*<!--.*-->\s*$/.test(line) || !line.trim()) continue
    if (/^(?:\*\*|#|---|- \[[ xX]\])/.test(line)) break
    if (/^\s+\S/.test(line) && out.length && out.at(-1).bullet) out.at(-1).text += `\n${line.trim()}`
    else out.push({ text: line.trim(), bullet: /^-\s/.test(line) })
  }
  return out
}

export function plannedPaths(planText) {
  const lines = planText.split('\n')
  const starts = []
  lines.forEach((line, i) => {
    const m = /^###\s+Task\s+(\d+)\b/.exec(line)
    if (m) starts.push({ number: Number(m[1]), i })
  })
  const paths = []
  const unparsed = []
  starts.forEach(({ number, i }, k) => {
    const body = lines.slice(i + 1, k + 1 < starts.length ? starts[k + 1].i : lines.length)
    const at = body.findIndex((l) => /^\*\*Files:\*\*/.test(l))
    if (at < 0) return
    for (const { text } of filesBlock(body, at + 1)) {
      const tokens = [...text.matchAll(/`([^`]+)`/g)].map((m) => stripDot(m[1].replace(/:\d+(?:-\d+)?$/, ''))).filter(isPlanPath)
      if (tokens.length === 0) {
        if (!/^-\s+\w+:\s*none\.?\s*$/i.test(text) && !/^-\s+Revert:\s*commits?\b/i.test(text)) unparsed.push({ task: number, line: text.split('\n')[0] })
        continue
      }
      const first = tokens.find((t) => t.includes('/'))
      const dir = first ? first.slice(0, first.lastIndexOf('/') + 1) : ''
      for (const t of tokens) {
        if (t.includes('/') || !dir) paths.push(t)
        else paths.push(dir + t, t)
      }
    }
  })
  return { tasks: starts.length, paths: [...new Set(paths)], unparsed }
}

// A planned path segment holding a placeholder (`<timestamp>`, `YYYYMMDDHHMMSS`) matches any
// run of characters within that segment; a glob is a glob; a directory covers what is under it.
const PLACEHOLDER = /<[^<>/]+>|(?<![A-Za-z0-9])(?:YYYY|YY|MM|DD|HH|mm|SS|ss){2,}(?![A-Za-z])/g
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function pathMatcher(entry) {
  if (/[*?]/.test(entry)) return (file) => globToRegExp(entry).test(file)
  if (PLACEHOLDER.test(entry)) {
    PLACEHOLDER.lastIndex = 0
    const dir = entry.endsWith('/')
    const source = entry.split(PLACEHOLDER).map(escapeRe).join('[^/]+')
    const re = new RegExp(`^${source}${dir ? '' : '(?:/|$)'}`)
    return (file) => re.test(file)
  }
  const dir = entry.endsWith('/') ? entry : `${entry}/`
  return (file) => file === entry || file.startsWith(dir)
}

function checkOutOfPlan(root, change, git, base, skillEdits) {
  if (base.error) return { verdict: 'not-run', summary: `no commit range: ${base.error}`, text: base.error }
  const planPath = join(changeDir(root, change), 'plan.md')
  if (!existsSync(planPath)) return { verdict: 'fail', summary: `${change} has no plan.md`, text: `${planPath} is missing` }
  const planned = plannedPaths(readFileSync(planPath, 'utf8'))
  const entries = planned.paths
  const matchers = entries.map(pathMatcher)
  const allowed = (readRegistry(root)?.outsidePlan ?? []).map((g) => globToRegExp(g))
  const prefix = changePrefix(change)
  const exempt = skillEdits.map(({ sha, from }) => {
    const full = attempt(() => git('rev-parse', '--verify', '--quiet', `${sha}^{commit}`))
    if (!full) throw Object.assign(new Error(from === 'ledger' ? `the ledger's skill-edit ${sha} is not a commit` : `--skill-edit ${sha} is not a commit`), { skillEdit: true })
    return full
  })
  const findings = []
  for (const { sha, files } of commitsIn(git, `${base.ref}..HEAD`)) {
    const skillEdit = exempt.includes(sha)
    for (const file of files) {
      if (file.startsWith(prefix)) continue
      if (skillEdit && file.startsWith('.claude/skills/')) continue
      if (allowed.some((re) => re.test(file))) continue
      if (matchers.some((covers) => covers(file))) continue
      findings.push({ sha, file, why: skillEdit ? 'an approved skill edit touched a file outside .claude/skills/' : 'no task names it' })
    }
  }
  const { unparsed } = planned
  const lines = [
    `range ${base.ref}..HEAD; plan tasks: ${planned.tasks}; plan paths: ${entries.length}; outsidePlan globs: ${allowed.length}; skill-edit commits: ${exempt.length}`,
    `out of plan: ${findings.length === 0 ? 'none' : ''}`,
    ...findings.map((f) => `  ${f.sha} ${f.file} (${f.why})`),
    `unparsed Files bullets: ${unparsed.length === 0 ? 'none' : ''}`,
    ...unparsed.map((u) => `  Task ${u.task}: ${u.line}`)
  ]
  const text = lines.join('\n')
  if (findings.length > 0) {
    const files = [...new Set(findings.map((f) => f.file))]
    return { verdict: 'fail', summary: `${files.length} file(s) outside every task: ${files.join(', ')}`, text, findings }
  }
  if (unparsed.length > 0) return { verdict: 'warn', summary: `every file is in the plan; unparsed Files bullets: ${unparsed.map((u) => `Task ${u.task}: ${u.line}`).join('; ')}`, text }
  return { verdict: 'pass', summary: 'every file the range touched is named by a task, the change directory or outsidePlan', text }
}

// ---------------------------------------------------------------- run

// A verify session starts fresh: sections left by an earlier session describe a HEAD that may
// have moved, so they are deleted before its first run. The session is the harness's
// (CLAUDE_CODE_SESSION_ID), kept in run.json: a run whose session differs from the one that
// wrote run.json clears the directory itself. `fresh` forces the clearing. With no session id in
// the environment nothing is cleared unless `fresh` asks.
//
// The approved skill edits are the ledger's `skill-edit` records, read on every run, plus any
// `skillEdits` the caller names.
export function runChecks(rootArg, { change, skillEdits = [], tracks = 'tasks.md', fresh = false, env = process.env, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const git = gitIn(root)
  const base = resolveBase(root, change, git)
  const outDir = verifyDir(root, change)
  const session = env[SESSION_ENV] || null
  const previous = attempt(() => JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8')))
  const cleared = fresh ? 'fresh' : previous && session && previous.session !== session ? 'new session' : null
  if (cleared) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const ledgerShas = skillEditShas(readRecords(root, change))
  const edits = [...ledgerShas.map((sha) => ({ sha, from: 'ledger' })), ...skillEdits.filter((sha) => !ledgerShas.includes(sha)).map((sha) => ({ sha, from: 'argument' }))]
  const guard = (fn) => {
    try {
      return fn()
    } catch (error) {
      if (error.skillEdit) throw error
      return { verdict: 'not-run', summary: `the check could not run: ${error.message}`, text: String(error.stack ?? error.message) }
    }
  }
  const results = {
    validation: guard(() => checkValidation(root, change)),
    tasks: guard(() => checkTasks(root, change, tracks)),
    deltas: guard(() => checkDeltas(root, change)),
    tree: guard(() => checkTree(git, base)),
    'test-record': guard(() => checkTestRecord(root, change, git)),
    worktrees: guard(() => checkWorktrees(root, change, git)),
    'out-of-plan': guard(() => checkOutOfPlan(root, change, git, base, edits))
  }
  const checks = Object.entries(results).map(([id, { verdict, summary, text, countWarnings }]) => {
    writeFileSync(join(outDir, `${id}.txt`), `${text}\n`)
    return { id, title: CHECKS[id], verdict, summary, output: relOutput(change, `${id}.txt`), ...(countWarnings ? { countWarnings } : {}) }
  })
  const run = {
    change,
    at: now,
    session,
    cleared,
    base: base.ref ?? null,
    head: attempt(() => git('rev-parse', 'HEAD')),
    skillEdits: edits.map((e) => e.sha),
    checks
  }
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  return { ...run, ok: !checks.some((c) => c.verdict === 'fail') }
}

// ---------------------------------------------------------------- verdict

const DISPLAY = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', 'not-run': 'NOT RUN' }

function validSection(section, id, root) {
  const errors = []
  if (section?.id !== id) errors.push(`id must be "${id}"`)
  if (typeof section?.title !== 'string' || !section.title.trim()) errors.push('title must be a non-empty string')
  if (!VERDICTS.includes(section?.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(', ')}`)
  if (typeof section?.summary !== 'string') errors.push('summary must be a string')
  if (typeof section?.output !== 'string' || !section.output) errors.push('output must be a path')
  else if (!existsSync(resolve(root, section.output))) errors.push(`its output file ${section.output} does not exist`)
  return errors
}

// The latest ruling per check id, from the ledger's `ruling --check --reason` records.
export function checkRulings(records) {
  const rulings = new Map()
  for (const r of records) if (r.kind === 'ruling' && typeof r.check === 'string') rulings.set(r.check, r)
  return rulings
}

// A refusal names what resolves it: `redispatch` lists the section ids whose dispatch (or
// writer) must run again, `needsRuling` the checks that were not run and wait for the
// developer's ruling, and `rerun` is true when a script check's output is gone and
// `verify.mjs run` must run again.
const PLUGIN_SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = (name) => `node "${join(PLUGIN_SCRIPTS, name)}"`

// The exact command that resolves each id of a refusal: the call that writes a section again
// (the prompt of a dispatch, the suite run, the developer's record), the ledger ruling with the
// developer's reason left to fill, and the run. `null` for a section id no writer owns: a stray
// file to remove.
export function resolutionCommands(root, change, { redispatch = [], needsRuling = [], rerun = false }) {
  const at = `--change ${change} --root "${root}"`
  const writer = (id) => {
    if (REQUIRED_SECTIONS.includes(id)) return `${script('dispatch.mjs')} prompt --role verify --check ${id} ${at}`
    if (id === 'test-record') return `${script('verify.mjs')} run --suite ${at}`
    if (id === DEVELOPER_ID) return `${script('verify.mjs')} developer --text-file <file> --verdict <pass|warn|fail|not-run> --summary "<text>" ${at}`
    return null
  }
  return {
    redispatchCommands: redispatch.map((id) => ({ id, command: writer(id) })),
    rulingCommands: needsRuling.map((id) => ({ id, command: `${script('ledger.mjs')} ruling --check ${id} --reason "<the developer's reason, in their words>" ${at}` })),
    rerunCommand: rerun ? `${script('verify.mjs')} run ${at}` : null
  }
}

export function computeVerdict(rootArg, { change }) {
  const root = resolve(rootArg)
  const dir = verifyDir(root, change)
  const runFile = join(dir, 'run.json')
  if (!existsSync(runFile)) throw new Error(`no ${relOutput(change, 'run.json')}; run verify.mjs run first`)
  const run = JSON.parse(readFileSync(runFile, 'utf8'))
  const sections = new Map(run.checks.map((c) => [c.id, c]))
  const refusals = []
  const redispatch = new Set()
  const needsRuling = []
  let rerun = false
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'run.json').sort()) {
    const id = file.slice(0, -'.json'.length)
    const section = attempt(() => JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (section === null) {
      refusals.push(`${file} is not valid JSON`)
      redispatch.add(id)
      continue
    }
    if (sections.has(id) && !REPLACEABLE.includes(id)) {
      refusals.push(`${file}: ${id} is a script check; only ${REPLACEABLE.join(', ')} may be replaced by a section`)
      redispatch.add(id)
      continue
    }
    const errors = validSection(section, id, root)
    if (errors.length > 0) {
      refusals.push(`${file}: ${errors.join('; ')}`)
      redispatch.add(id)
    } else sections.set(id, { id, title: section.title, verdict: section.verdict, summary: section.summary, output: section.output })
  }
  for (const c of run.checks) {
    if (sections.get(c.id) === c && !existsSync(resolve(root, c.output))) {
      refusals.push(`${c.id}: its output file ${c.output} does not exist`)
      rerun = true
    }
  }
  for (const id of REQUIRED_SECTIONS) {
    if (!sections.has(id) && !redispatch.has(id)) {
      refusals.push(`${id}.json is missing: the verify ${id} dispatch has not written its section`)
      redispatch.add(id)
    }
  }
  const rulings = checkRulings(readRecords(root, change))
  const ignoredRulings = []
  const checks = [...sections.values()].map((c) => {
    const ruling = rulings.get(c.id)
    const display = DISPLAY[c.verdict]
    if (!ruling || (c.verdict !== 'fail' && c.verdict !== 'not-run')) return { ...c, display }
    if (UNACCEPTABLE.includes(c.id)) {
      ignoredRulings.push({ id: ruling.id, check: c.id, reason: `${c.id} cannot be accepted by a ruling` })
      return { ...c, display }
    }
    return { ...c, accepted: ruling.reason, ruling: ruling.id, display: `${display}, accepted by the developer: ${ruling.reason}` }
  })
  for (const c of checks) {
    if (c.verdict === 'not-run' && !c.accepted) {
      refusals.push(`${c.id} was not run and has no ruling: ${c.summary}`)
      needsRuling.push(c.id)
    }
  }
  if (refusals.length > 0) {
    const ids = { redispatch: [...redispatch], needsRuling, rerun }
    return { ok: false, error: 'the record cannot be given a verdict', refusals, ...ids, ...resolutionCommands(root, change, ids), checks, ignoredRulings }
  }
  const failing = checks.filter((c) => c.verdict === 'fail' && !c.accepted)
  const warned = checks.some((c) => c.verdict === 'warn' || c.accepted)
  const verdict = failing.length > 0 ? 'FAIL' : warned ? 'PASS WITH WARNINGS' : 'PASS'
  return { ok: verdict !== 'FAIL', verdict, line: `Verdict: ${verdict}`, failing: failing.map((c) => c.id), checks, ignoredRulings }
}

// ---------------------------------------------------------------- report

const listOrNone = (items) => (items.length === 0 ? ' none' : `\n${items.map((i) => `- ${i}`).join('\n')}`)

// The report the command prints, from a computeVerdict result: failing, warnings, accepted and
// the next step; on a refusal, the refusals and what resolves them.
export function renderReport(result, { change, commit = null } = {}) {
  const record = `openspec/changes/${change}/verify.md`
  if (result.ok === false && result.refusals) {
    return [
      '## Verification: no verdict yet',
      '',
      `**Change:** ${change}`,
      '',
      `Refusals:${listOrNone(result.refusals)}`,
      `Re-dispatch:${listOrNone((result.redispatchCommands ?? []).map((c) => `${c.id}: ${c.command ?? `no writer owns it; remove its section file from .superpowers/sdd/${change}/verify/`}`))}`,
      `Needs a ruling:${listOrNone((result.rulingCommands ?? []).map((c) => `${c.id}: ${c.command}`))}`,
      ...(result.rerunCommand ? [`Re-run (a check output file is gone): ${result.rerunCommand}`] : []),
      '',
      'Next step: run each re-dispatch command and dispatch the prompt it writes, ask the developer for each ruling, then compute the verdict again.'
    ].join('\n')
  }
  const failing = result.checks.filter((c) => c.verdict === 'fail' && !c.accepted)
  const warned = result.checks.filter((c) => c.verdict === 'warn')
  const accepted = result.checks.filter((c) => c.accepted)
  return [
    `## Verification ${result.verdict}`,
    '',
    `**Change:** ${change}`,
    `**Record:** ${record}, ${commit ? `commit ${commit}` : 'not committed yet'}`,
    '',
    `Failing:${listOrNone(failing.map((c) => `${c.id}: ${c.summary}`))}`,
    `Warnings:${listOrNone(warned.map((c) => `${c.id}: ${c.summary}`))}`,
    `Accepted by the developer:${listOrNone(accepted.map((c) => `${c.id}: ${c.accepted}`))}`,
    '',
    `Next step: ${nextStep(result)}`
  ].join('\n')
}

function nextStep(result) {
  if (result.verdict !== 'FAIL') return "the review, which reads the record's Verdict line."
  return `fix what each failing check names (${result.failing.join(', ')}): the artifact, the code through a new apply round, or the plan with the developer's approval; then run /adf:verify again.`
}

// ---------------------------------------------------------------- the developer section

// What was run with the developer and what it showed: `<verify>/developer.txt`, verbatim, and
// its section `<verify>/developer.json`. The verdict is the one agreed with the developer.
export function writeDeveloper(rootArg, { change, text, verdict, summary }) {
  const root = resolve(rootArg)
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  if (typeof text !== 'string' || !text.trim()) throw new Error('the developer text is empty; write what was run and what it showed')
  if (!VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${VERDICTS.join(', ')}`)
  const dir = verifyDir(root, change)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${DEVELOPER_ID}.txt`), text.endsWith('\n') ? text : `${text}\n`)
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean)
  const section = {
    id: DEVELOPER_ID,
    title: 'Checks run with the developer',
    verdict,
    summary: summary?.trim() || firstLine,
    output: relOutput(change, `${DEVELOPER_ID}.txt`)
  }
  writeFileSync(join(dir, `${DEVELOPER_ID}.json`), `${JSON.stringify(section, null, 2)}\n`)
  return { ok: true, file: relOutput(change, `${DEVELOPER_ID}.json`), ...section }
}

// ---------------------------------------------------------------- stale-skill candidates

const rawGit = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })

const GENERIC_NAMES = /^(?:index\.[a-z]+|readme\.md|skill\.md|changelog\.md|mod\.rs|__init__\.py)$/i
const DECLARATION = /\b(?:function\*?|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|module)\s+([A-Za-z_$][\w$]*)/g
const FLAG = /(?<![\w-])(--[a-z][a-z0-9-]{2,})(?![\w-])/g
const ROUTE = /['"`](\/[A-Za-z0-9_:{}.-]*[A-Za-z][A-Za-z0-9_:{}.\-/]*)['"`]/g
const ROUTE_DECORATOR = /@(?:Get|Post|Put|Patch|Delete|All|Controller)\(\s*['"]([^'"]+)['"]/g
const PACKAGE_KEY = /^\s*"([^"]+)"\s*:\s*"/
const LINE_PATH = /(?:\.{0,2}\/)?[\w.@~-]+(?:\/[\w.@*~-]+)*\/?/g
const escapeWord = (t) => new RegExp(`(?<![\\w$])${escapeRe(t)}(?![\\w$])`)

// The terms the range's diff changed: the files it touched (the change's own directory left
// out), and, from the changed lines of every file that is not Markdown, the names it declares,
// the command-line flags only one side carries, package.json keys, and route strings.
export function changedTerms(diffText, files, change) {
  const prefix = changePrefix(change)
  const paths = files.filter((f) => !f.startsWith(prefix))
  const symbols = new Set()
  const flags = { '+': new Set(), '-': new Set() }
  const commands = new Set()
  const routes = new Set()
  let file = null
  for (const line of diffText.split('\n')) {
    const head = /^(?:\+\+\+|---) (?:[ab]\/(.*)|\/dev\/null)$/.exec(line)
    if (head) {
      if (head[1]) file = head[1]
      continue
    }
    if (!/^[+-]/.test(line) || !file || file.startsWith(prefix) || /\.md$/i.test(file)) continue
    const side = line[0]
    const body = line.slice(1)
    for (const m of body.matchAll(DECLARATION)) if (m[1].length >= 4) symbols.add(m[1])
    for (const m of body.matchAll(FLAG)) flags[side].add(m[1])
    for (const m of body.matchAll(ROUTE)) if (m[1].length >= 3) routes.add(m[1])
    for (const m of body.matchAll(ROUTE_DECORATOR)) routes.add(m[1])
    if (/(?:^|\/)package\.json$/.test(file)) {
      const key = PACKAGE_KEY.exec(body)
      if (key) commands.add(key[1])
    }
  }
  for (const flag of flags['+']) if (!flags['-'].has(flag)) commands.add(flag)
  for (const flag of flags['-']) if (!flags['+'].has(flag)) commands.add(flag)
  return { paths, symbols: [...symbols].sort(), commands: [...commands].sort(), routes: [...routes].sort() }
}

function pathMatches(token, file) {
  const t = token.replace(/^\.\//, '')
  if (!t || t === '/' || t.startsWith('../')) return false
  if (t.endsWith('/')) return file.startsWith(t) || file.includes(`/${t}`)
  if (file === t || file.endsWith(`/${t}`)) return true
  if (t.includes('/') && (file.startsWith(`${t}/`) || file.includes(`/${t}/`))) return true
  const name = file.slice(file.lastIndexOf('/') + 1)
  return !t.includes('/') && t === name && !GENERIC_NAMES.test(name)
}

// The lines of one skill file that name a changed term, each with what it matched.
export function candidateLines(text, terms) {
  const out = []
  const symbolRes = terms.symbols.map((s) => [s, escapeWord(s)])
  const commandRes = terms.commands.map((c) => [c, c.startsWith('--') ? new RegExp(`(?<![\\w-])${escapeRe(c)}(?![\\w-])`) : escapeWord(c)])
  text.split('\n').forEach((line, i) => {
    const matches = []
    const tokens = [...line.matchAll(LINE_PATH)].map((m) => m[0]).filter((t) => t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t))
    for (const file of terms.paths) if (tokens.some((t) => pathMatches(t, file))) matches.push({ kind: 'path', term: file })
    for (const [s, re] of symbolRes) if (re.test(line)) matches.push({ kind: 'symbol', term: s })
    for (const [c, re] of commandRes) if (re.test(line)) matches.push({ kind: 'command', term: c })
    for (const r of terms.routes) if (line.includes(r)) matches.push({ kind: 'route', term: r })
    if (matches.length > 0) out.push({ line: i + 1, text: line, matches })
  })
  return out
}

// For each host skill (`.claude/skills/*/SKILL.md` and the README.md beside it), the lines that
// name a path, symbol, command or route the range's diff changed: the input of `verify c8`,
// which judges each candidate. The listing is written to `<verify>/c8-candidates.txt`.
export function skillCandidates(rootArg, { change }) {
  const root = resolve(rootArg)
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const git = gitIn(root)
  const base = resolveBase(root, change, git)
  if (base.error) throw new Error(`no commit range: ${base.error}`)
  const range = `${base.ref}..HEAD`
  const files = rawGit(root, 'diff', '--no-renames', '--name-only', range).split('\n').filter(Boolean)
  const terms = changedTerms(rawGit(root, 'diff', '--no-renames', '--no-color', '-U0', range), files, change)
  const skillsRoot = join(root, SKILLS_DIR)
  const skillFiles = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .flatMap((name) => ['SKILL.md', 'README.md'].map((f) => `${SKILLS_DIR}${name}/${f}`))
        .filter((f) => existsSync(join(root, f)))
    : []
  const skills = skillFiles.map((file) => ({ file, candidates: candidateLines(readFileSync(join(root, file), 'utf8'), terms) }))
  const counts = Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, v.length]))
  const lines = [
    `range ${range}; changed files: ${files.length}; terms: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `skill files read: ${skillFiles.length === 0 ? 'none' : skillFiles.length}`
  ]
  for (const s of skills) {
    lines.push('', `${s.file}: ${s.candidates.length === 0 ? 'no candidate line' : `${s.candidates.length} candidate line(s)`}`)
    for (const c of s.candidates) lines.push(`  ${c.line}: ${c.text.trim()}`, `      [${c.matches.map((m) => `${m.kind} ${m.term}`).join('; ')}]`)
  }
  const outDir = verifyDir(root, change)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'c8-candidates.txt'), `${lines.join('\n')}\n`)
  return {
    ok: true,
    range,
    terms: counts,
    skillFiles: skillFiles.length,
    candidates: skills.reduce((n, s) => n + s.candidates.length, 0),
    skills: skills.filter((s) => s.candidates.length > 0),
    output: relOutput(change, 'c8-candidates.txt')
  }
}

// ---------------------------------------------------------------- an approved skill edit

const CONVENTIONAL = /^[a-z]+(?:\([^()\s][^()]*\))?!?: \S/

// `git status --porcelain=v1 -z`: every staged, changed or untracked path, both ends of a rename.
function changedPaths(root) {
  const parts = rawGit(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
  const paths = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    paths.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(parts[++i])
  }
  return paths
}

// The patch of a c8 output file: from its first `diff --git` line to the end, the place the c8
// rule puts it, so the output file itself can be passed.
export function patchOf(text) {
  const at = String(text ?? '').search(/^diff --git /m)
  if (at < 0) throw new Error('the diff file holds no `diff --git` patch; pass the c8 output file or a file holding the approved part of its diff')
  const patch = text.slice(at)
  return patch.endsWith('\n') ? patch : `${patch}\n`
}

const gitApply = (root, args, patch) => execFileSync('git', ['apply', ...args, '-'], { cwd: root, input: patch, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

// The paths a patch touches, both ends of a rename, from `git apply --numstat -z`.
function patchPaths(root, patch) {
  const parts = gitApply(root, ['--numstat', '-z'], patch).split('\0')
  const paths = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    const [, , path] = parts[i].split('\t')
    if (path) paths.push(path)
    else paths.push(parts[++i], parts[++i])
  }
  return paths.filter(Boolean)
}

// Applies the approved diff with `git apply`: refused when a path of it lies outside
// `.claude/skills/`, when the tree already holds a change (the commit would take it too), and
// when the patch does not apply cleanly; nothing is written then.
function applySkillDiff(root, diffText) {
  const patch = patchOf(diffText)
  let paths
  try {
    paths = patchPaths(root, patch)
  } catch (error) {
    throw new Error(`git apply cannot read the diff: ${String(error.stderr || error.message).trim()}`)
  }
  const outside = paths.filter((p) => !p.startsWith(SKILLS_DIR))
  if (outside.length > 0) throw new Error(`the diff touches paths outside ${SKILLS_DIR}: ${outside.join(', ')}; a skill edit changes only skill files`)
  if (paths.length === 0) throw new Error('the diff changes no file')
  const dirty = changedPaths(root)
  if (dirty.length > 0) throw new Error(`the tree already holds changes (${dirty.join(', ')}); commit or remove them before applying the skill edit`)
  try {
    gitApply(root, ['--check'], patch)
  } catch (error) {
    throw new Error(`the diff does not apply cleanly, and nothing was changed: ${String(error.stderr || error.message).trim()}`)
  }
  gitApply(root, [], patch)
}

// Commits an approved skill edit on its own, records its sha in the ledger and runs the checks
// again. With `diff`, the text of the c8 agent's proposed diff, it is applied first
// (applySkillDiff). Refused when any staged, changed or untracked path lies outside
// `.claude/skills/`.
export function skillEdit(rootArg, { change, message, diff = null, tracks = 'tasks.md', env = process.env, now }) {
  const root = resolve(rootArg)
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  if (typeof message !== 'string' || !CONVENTIONAL.test(message)) throw new Error('the message must be a Conventional Commit: type(scope): description')
  if (diff !== null) applySkillDiff(root, diff)
  const paths = changedPaths(root)
  const outside = paths.filter((p) => !p.startsWith(SKILLS_DIR))
  if (outside.length > 0) throw new Error(`paths outside ${SKILLS_DIR} are changed: ${outside.join(', ')}; a skill edit commits only skill files`)
  if (paths.length === 0) throw new Error(`nothing is changed under ${SKILLS_DIR}; apply the approved edit first`)
  const committed = commitPaths(root, { only: paths, message })
  const { record } = appendRecord(root, change, 'skill-edit', { sha: committed.commit, message }, { env })
  const run = runChecks(root, { change, tracks, env, ...(now ? { now } : {}) })
  return { ok: true, commit: committed.commit, files: committed.files, record: record.id, run }
}

// ---------------------------------------------------------------- the record

export const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'templates', 'verify.md')
export const recordPath = (change) => `openspec/changes/${change}/verify.md`

// Each heading of the template and the check id whose section fills it.
const HEADING_IDS = {
  'Structural validation': 'validation',
  'Task completion': 'tasks',
  'Delta spec sync state': 'deltas',
  'Design and specs coherence': 'c4',
  'Implementation signal': 'tree',
  'Apply test record': 'test-record',
  'No leftover worktrees': 'worktrees',
  'Stale skills': 'c8',
  'Out-of-plan commits': 'out-of-plan'
}
const OTHER_HEADINGS = ['Checks run with the developer', 'Exercised and not exercised', 'Rulings', 'Next step']
const DISPATCHED_BY = { c4: 'verify c4', c8: 'verify c8', 'test-record': 'verify.mjs run --suite', developer: 'verify.mjs developer' }

function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}text`, text.replace(/\n+$/, ''), fence].join('\n')
}

// `**<name>:** <value>`: a list goes below the label, an empty list is `none`, and an absent
// value is the fallback.
const labelled = (name, value, fallback) => {
  if (Array.isArray(value)) return value.length === 0 ? `**${name}:** none` : `**${name}:**\n\n${value.map((v) => `- ${v}`).join('\n')}`
  return `**${name}:** ${typeof value === 'string' && value.trim() ? value.trim() : fallback}`
}

function stamp(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// The bullets under one `## ` heading of a Markdown text.
function bulletsUnder(text, heading) {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (at < 0) return []
  const out = []
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(line)) break
    const m = /^-\s+(.*)$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

// Renders `openspec/changes/<change>/verify.md` from the template, run.json, the sections and
// their verbatim output files, the verdict, the rulings and the approved skill edits, deciding
// nothing; refuses when the verdict refuses or HEAD moved since the run. The record's last line
// is the verdict's `line`, checked after writing. With `commit`, the record is committed alone.
export function assemble(rootArg, { change, commit = false, template = TEMPLATE, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  const dir = verifyDir(root, change)
  const result = computeVerdict(root, { change })
  if (result.ok === false && result.refusals) {
    return { ...result, error: `the record cannot be assembled: ${result.error}`, report: renderReport(result, { change }) }
  }
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  const git = gitIn(root)
  const head = git('rev-parse', 'HEAD')
  if (run.head !== head) throw new Error(`HEAD is ${head.slice(0, 7)}, but the checks ran at ${String(run.head).slice(0, 7)}; run verify.mjs run again`)
  const templateText = readFileSync(template, 'utf8')
  const title = templateText.split('\n').find((l) => /^# /.test(l)) ?? '# Verification Report'
  const headings = [...templateText.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  const unknown = headings.filter((h) => !(h in HEADING_IDS) && !OTHER_HEADINGS.includes(h))
  if (unknown.length > 0) throw new Error(`the template has section(s) assemble does not know: ${unknown.join(', ')}`)
  const templated = new Set(headings.map((h) => HEADING_IDS[h]).filter(Boolean))
  const byId = new Map(result.checks.map((c) => [c.id, c]))
  const extra = (id) => attempt(() => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))) ?? {}
  const output = (c) => readFileSync(resolve(root, c.output), 'utf8')
  const records = readRecords(root, change)
  const rulings = records.filter((r) => r.kind === 'ruling' && typeof r.check === 'string')
  const skillEdits = records.filter((r) => r.kind === 'skill-edit')
  const placed = new Set()
  const sectionOf = (c, fields = []) => {
    placed.add(c.id)
    return [`**Result:** ${c.display}: ${c.summary}`, ...fields.flatMap((f) => ['', f]), '', fenced(output(c))]
  }
  const c4 = extra('c4')
  const notStated = 'not stated in the c4 section'
  const renderers = {
    c4: (c) => sectionOf(c, [
      labelled('Hand-edited capability prose', c4.proseEdits, notStated),
      labelled('Removal accounting', c4.removalAccounting, notStated)
    ]),
    'test-record': (c) => {
      const rerun = existsSync(join(dir, 'test-record.json'))
      const section = rerun ? extra('test-record') : {}
      const recordFile = join(changeDir(root, change), RECORD_FILE)
      const preExisting = rerun ? section.preExisting ?? [] : bulletsUnder(existsSync(recordFile) ? readFileSync(recordFile, 'utf8') : '', 'Pre-existing failures, separate work')
      const warnings = rerun ? section.countWarnings ?? [] : run.checks.find((x) => x.id === 'test-record')?.countWarnings ?? []
      return sectionOf(c, [
        `**Scope that ran:** ${rerun ? 'the whole suite, re-run by suite.mjs: the record was stale' : `the record cited, not re-run: ${changePrefix(change)}${RECORD_FILE}`}`,
        labelled('Pre-existing failures, separate work', preExisting, 'none'),
        labelled('Test count warnings', warnings, 'none')
      ])
    },
    c8: (c) => sectionOf(c, [
      labelled('Approved skill edits', skillEdits.map((r) => `\`${r.sha}\`${r.message ? ` ${r.message}` : ''}`), 'none'),
      labelled('Declined edits', rulings.filter((r) => r.check === 'c8').map((r) => `${r.reason} (${r.id})`), 'none')
    ])
  }
  const verifier = [
    attempt(() => git('config', 'user.name')) || 'unknown',
    'checks by verify.mjs run',
    ...result.checks.filter((c) => DISPATCHED_BY[c.id] && existsSync(join(dir, `${c.id}.json`))).map((c) => `${c.id} by ${DISPATCHED_BY[c.id]}`)
  ].join('; ')
  const out = [
    title,
    '',
    `**Change:** \`${change}\``,
    `**Verified at:** \`${stamp(now)}\``,
    `**Verifier:** ${verifier}`,
    `**Range:** \`${run.base}..${head}\``
  ]
  for (const heading of headings) {
    let body
    const id = HEADING_IDS[heading]
    if (id) {
      const c = byId.get(id)
      if (!c) throw new Error(`no ${id} section to fill "${heading}"`)
      body = (renderers[id] ?? sectionOf)(c)
    } else if (heading === 'Checks run with the developer') {
      // A section the template does not name is placed before the developer's, under its title.
      for (const c of result.checks) {
        if (placed.has(c.id) || c.id === DEVELOPER_ID || templated.has(c.id)) continue
        out.push('', `## ${c.title}`, '', ...sectionOf(c))
      }
      const dev = byId.get(DEVELOPER_ID)
      body = dev ? sectionOf(dev) : ['none']
    } else if (heading === 'Exercised and not exercised') {
      body = Array.isArray(c4.exercised) ? (c4.exercised.length ? c4.exercised.map((v) => `- ${v}`) : ['none']) : [typeof c4.exercised === 'string' && c4.exercised.trim() ? c4.exercised.trim() : notStated]
    } else if (heading === 'Rulings') {
      const lines = rulings.map((r) => `- \`${r.check}\`: ${r.reason} (${r.id})`)
      for (const i of result.ignoredRulings) lines.push(`- \`${i.check}\`: ignored (${i.id}): ${i.reason}`)
      body = lines.length ? lines : ['none']
    } else {
      body = [result.verdict === 'FAIL' ? `Fix what each failing check names, then run verify again:\n\n${result.checks.filter((c) => c.verdict === 'fail' && !c.accepted).map((c) => `- \`${c.id}\`: ${c.summary}`).join('\n')}` : "The review, which reads this record's Verdict line."]
    }
    out.push('', `## ${heading}`, '', ...body)
  }
  out.push('', result.line, '')
  const file = recordPath(change)
  writeFileSync(join(root, file), out.join('\n'))
  const last = readFileSync(join(root, file), 'utf8').trimEnd().split('\n').at(-1)
  if (last !== result.line) throw new Error(`the record's last line is "${last}", not "${result.line}"`)
  const committed = commit ? commitPaths(root, { only: [file], message: `docs(openspec): verify ${change}` }) : null
  const sha = committed?.commit ?? null
  return { ok: true, file, verdict: result.verdict, line: result.line, commit: sha, report: renderReport(result, { change, commit: sha }) }
}
