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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { changeDir, globToRegExp, META_FILE, parseTasks } from './changes.mjs'
import { baseCheckPath, listGroups } from './groups.mjs'
import { readRecords } from './ledger.mjs'
import { baseRef, parsePlanTasks } from './plan-symbols.mjs'
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
  const m = /\bcommit:?\**:?\s*`?([0-9a-f]{7,40})\b/i.exec(recordText)
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

function planCovers(entries, file) {
  return entries.some((entry) => {
    if (/[*?]/.test(entry)) return globToRegExp(entry).test(file)
    const dir = entry.endsWith('/') ? entry : `${entry}/`
    return file === entry || file.startsWith(dir)
  })
}

function checkOutOfPlan(root, change, git, base, skillEdits) {
  if (base.error) return { verdict: 'not-run', summary: `no commit range: ${base.error}`, text: base.error }
  const planPath = join(changeDir(root, change), 'plan.md')
  if (!existsSync(planPath)) return { verdict: 'fail', summary: `${change} has no plan.md`, text: `${planPath} is missing` }
  const tasks = parsePlanTasks(readFileSync(planPath, 'utf8'))
  const entries = []
  for (const t of tasks) {
    for (const f of t.files) {
      entries.push(stripDot(f.path))
      if (f.bare) entries.push(f.bare)
      if (f.to) entries.push(stripDot(f.to))
    }
  }
  const allowed = (readRegistry(root)?.outsidePlan ?? []).map((g) => globToRegExp(g))
  const prefix = changePrefix(change)
  const exempt = skillEdits.map((sha) => {
    const full = attempt(() => git('rev-parse', '--verify', '--quiet', `${sha}^{commit}`))
    if (!full) throw new Error(`--skill-edit ${sha} is not a commit`)
    return full
  })
  const findings = []
  for (const { sha, files } of commitsIn(git, `${base.ref}..HEAD`)) {
    const skillEdit = exempt.includes(sha)
    for (const file of files) {
      if (file.startsWith(prefix)) continue
      if (skillEdit && file.startsWith('.claude/skills/')) continue
      if (allowed.some((re) => re.test(file))) continue
      if (planCovers(entries, file)) continue
      findings.push({ sha, file, why: skillEdit ? 'an approved skill edit touched a file outside .claude/skills/' : 'no task names it' })
    }
  }
  const unparsed = tasks.flatMap((t) => t.unparsed.map((line) => ({ task: t.number, line })))
  const lines = [
    `range ${base.ref}..HEAD; plan tasks: ${tasks.length}; plan paths: ${entries.length}; outsidePlan globs: ${allowed.length}; skill-edit commits: ${exempt.length}`,
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

export function runChecks(rootArg, { change, skillEdits = [], tracks = 'tasks.md', now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const git = gitIn(root)
  const base = resolveBase(root, change, git)
  const outDir = verifyDir(root, change)
  mkdirSync(outDir, { recursive: true })
  const guard = (fn) => {
    try {
      return fn()
    } catch (error) {
      if (/^--skill-edit /.test(error.message)) throw error
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
    'out-of-plan': guard(() => checkOutOfPlan(root, change, git, base, skillEdits))
  }
  const checks = Object.entries(results).map(([id, { verdict, summary, text }]) => {
    writeFileSync(join(outDir, `${id}.txt`), `${text}\n`)
    return { id, title: CHECKS[id], verdict, summary, output: relOutput(change, `${id}.txt`) }
  })
  const run = { change, at: now, base: base.ref ?? null, head: attempt(() => git('rev-parse', 'HEAD')), checks }
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

export function computeVerdict(rootArg, { change }) {
  const root = resolve(rootArg)
  const dir = verifyDir(root, change)
  const runFile = join(dir, 'run.json')
  if (!existsSync(runFile)) throw new Error(`no ${relOutput(change, 'run.json')}; run verify.mjs run first`)
  const run = JSON.parse(readFileSync(runFile, 'utf8'))
  const sections = new Map(run.checks.map((c) => [c.id, c]))
  const refusals = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'run.json').sort()) {
    const id = file.slice(0, -'.json'.length)
    const section = attempt(() => JSON.parse(readFileSync(join(dir, file), 'utf8')))
    if (section === null) {
      refusals.push(`${file} is not valid JSON`)
      continue
    }
    if (sections.has(id) && !REPLACEABLE.includes(id)) {
      refusals.push(`${file}: ${id} is a script check; only ${REPLACEABLE.join(', ')} may be replaced by a section`)
      continue
    }
    const errors = validSection(section, id, root)
    if (errors.length > 0) refusals.push(`${file}: ${errors.join('; ')}`)
    else sections.set(id, { id, title: section.title, verdict: section.verdict, summary: section.summary, output: section.output })
  }
  for (const c of run.checks) {
    if (sections.get(c.id) === c && !existsSync(resolve(root, c.output))) refusals.push(`${c.id}: its output file ${c.output} does not exist`)
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
  for (const c of checks) if (c.verdict === 'not-run' && !c.accepted) refusals.push(`${c.id} was not run and has no ruling: ${c.summary}`)
  if (refusals.length > 0) return { ok: false, error: 'the record cannot be given a verdict', refusals, checks, ignoredRulings }
  const failing = checks.filter((c) => c.verdict === 'fail' && !c.accepted)
  const warned = checks.some((c) => c.verdict === 'warn' || c.accepted)
  const verdict = failing.length > 0 ? 'FAIL' : warned ? 'PASS WITH WARNINGS' : 'PASS'
  return { ok: verdict !== 'FAIL', verdict, line: `Verdict: ${verdict}`, failing: failing.map((c) => c.id), checks, ignoredRulings }
}
