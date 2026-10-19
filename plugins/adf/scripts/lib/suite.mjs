// The whole-suite run of apply and verify, done by a script so no agent reports a count it did
// not see.
//
// The command lives under `## Whole-suite command` in `<root>/openspec/planning.md`, as a fenced
// block, an inline code span or a plain line (HTML comments are ignored). `readCommand` reads
// it; `writeCommand` writes it there, creating the file or the section when absent. Committing
// it is the caller's job.
//
// `runSuite` runs that command with `<root>` as the working directory, through the platform
// shell (`spawn(command, { shell: true })`: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on
// Windows). A shell is right here because the command is the project's own whole-suite command
// line, written by the developer into the planning guide, not a string built from input.
// Running it uncached is the command's own job (`--no-cache`, `--force` and the like belong in
// the guide): this script cannot tell a replayed result from a fresh one.
//
// Stdout and stderr go together, interleaved, to `.superpowers/sdd/<change>/suite/<stamp>.txt`
// and never into the result. The counts are the runner's own summary lines, quoted verbatim:
// the lines of the output's last TAIL_LINES lines in which `countsIn` finds a number.
//
// A failure with `baseCheck` is checked on the change's base: a detached worktree made by
// addBaseCheck, the same command run there (its output to `<stamp>-base.txt`), then
// removeBaseCheck, never forced; a refused removal is reported and the worktree left.
// Failing test identifiers are parsed from the output (TAP `not ok`, Jest/Vitest `FAIL` and
// `✕`/`×` lines, the node:test spec reporter's `✖` lines but its `✖ failing tests:` header,
// pytest `FAILED`, Go `--- FAIL:`). When both runs name their failures, a failure
// is pre-existing when the base names it too, and the rest are new. When the runner names
// none, the comparison is of the whole run: a base run that also fails makes the failure
// pre-existing, and the result says `comparison: "whole-run"`, since a partial overlap cannot
// be told apart there; compare the two output files before relying on it. A command that cannot
// run on the base (exit 126 or 127, a spawn error, or no base-check worktree) blocks.
//
// The run is `blocking` unless it passed or every failure is pre-existing. A suite that cannot
// run at all (exit 126 or 127) is a failure, never a pass.
//
// Each run, the base check's included, is stopped after `timeoutMinutes` (DEFAULT_TIMEOUT_MINUTES
// unless given): a suite that hangs is `cannotRun` with `timedOut: true`, a failure, never a pass.
// The shell starts in a process group of its own (`detached` on POSIX), and the timeout kills the
// whole group, so a grandchild the suite started stops with it; on Windows `taskkill /T` stops
// the process tree.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { changeDir } from './changes.mjs'
import { addBaseCheck, removeBaseCheck } from './groups.mjs'
import { CHECKS, countsIn, RECORD_FILE, reconcileCounts, verifyDir } from './verify.mjs'
import { gitIn } from './workspace.mjs'

export const PLANNING_FILE = 'openspec/planning.md'
export const HEADING = '## Whole-suite command'
export const SECTION_ID = 'test-record'
// `--section review`: the run after the review stage's last fix, always with the base check,
// written to the review state as `review/suite.json` (lib/review-state.mjs reads it).
export const REVIEW_SECTION = 'review'
export const SECTIONS = [SECTION_ID, REVIEW_SECTION]
export const TAIL_LINES = 40
// Lines of the real output quoted in the committed record; the whole output stays in its file.
export const QUOTE_LINES = 60
export const CANNOT_RUN = [126, 127]
export const DEFAULT_TIMEOUT_MINUTES = 30
// The messages of the commits `suite.mjs set --commit` and `suite.mjs run --record --commit` make.
export const SET_MESSAGE = 'docs(openspec): record the whole-suite command'
export const recordMessage = (change) => `docs(openspec): record the whole-suite run of ${change}`

const toPosix = (p) => p.split('\\').join('/')
const rel = (root, file) => toPosix(relative(root, file))

// ---------------------------------------------------------------- the planning guide

// [start, end) line indexes of the section body, or null when the heading is absent.
export function sectionBounds(lines, heading = HEADING) {
  const at = lines.findIndex((l) => l.trim() === heading)
  if (at < 0) return null
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  if (end < 0) end = lines.length
  return { at, start: at + 1, end }
}

export function commandIn(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const bounds = sectionBounds(lines)
  if (!bounds) return null
  const body = lines.slice(bounds.start, bounds.end).join('\n').replace(/<!--[\s\S]*?-->/g, '')
  const fence = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1\s*$/m.exec(body)
  const candidates = (fence ? fence[2] : body).split('\n').map((l) => l.trim()).filter(Boolean)
  if (candidates.length === 0) return null
  if (candidates.length > 1) throw new Error(`the ${HEADING} section holds ${candidates.length} lines; it must hold one command`)
  const line = candidates[0]
  const inline = /^`([^`]+)`\.?$/.exec(line)
  return (inline ? inline[1] : line).trim() || null
}

export function readCommand(root) {
  const file = join(resolve(root), PLANNING_FILE)
  if (!existsSync(file)) return { file, command: null, reason: `${PLANNING_FILE} does not exist` }
  const command = commandIn(readFileSync(file, 'utf8'))
  return { file, command, ...(command === null ? { reason: `${PLANNING_FILE} holds no command under ${HEADING}` } : {}) }
}

// Replaces whatever the section held, keeping its HTML comments.
export function writeCommand(root, command) {
  const cmd = String(command ?? '').trim()
  if (!cmd) throw new Error('no command to write')
  if (/[\r\n]/.test(cmd)) throw new Error('the whole-suite command must be one line')
  const file = join(resolve(root), PLANNING_FILE)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const block = ['```sh', cmd, '```']
  const bounds = sectionBounds(lines)
  if (bounds) {
    const comments = (lines.slice(bounds.start, bounds.end).join('\n').match(/<!--[\s\S]*?-->/g) ?? []).flatMap((c) => c.split('\n'))
    const body = ['', ...(comments.length ? [...comments, ''] : []), ...block, '']
    lines.splice(bounds.start, bounds.end - bounds.start, ...body)
  } else {
    while (lines.length && lines.at(-1) === '') lines.pop()
    lines.push(...(lines.length ? [''] : []), HEADING, '', ...block, '')
  }
  mkdirSync(dirname(file), { recursive: true })
  const out = lines.join(eol)
  writeFileSync(file, out.endsWith(eol) ? out : out + eol)
  if (commandIn(readFileSync(file, 'utf8')) !== cmd) throw new Error(`wrote ${PLANNING_FILE}, but the command does not read back`)
  return { file, command: cmd }
}

// ---------------------------------------------------------------- output parsing

// A TAP result line ("ok 3 - name") is one test's result, not a count.
const TAP_RESULT = /^\s*(?:not )?ok \d+\b/

export function countLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .slice(-TAIL_LINES)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !TAP_RESULT.test(l) && countsIn(l).length > 0)
}

const FAILURE_PATTERNS = [
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/, // TAP: node --test, tap, bats
  /^\s*FAIL\s+(\S.*)$/, // Jest, Vitest: a failing file
  /^\s*[✕×✗]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/, // Jest, Vitest, Mocha-like: a failing test
  /^\s*✖\s+(?!failing tests:\s*$)(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/, // node:test spec reporter, not its "failing tests:" header
  /^FAILED\s+(\S+)/, // pytest
  /^\s*--- FAIL:\s+(\S+)/ // Go
]

export function failingIn(text) {
  const found = new Set()
  for (const line of String(text ?? '').replace(ANSI, '').split(/\r?\n/)) {
    for (const re of FAILURE_PATTERNS) {
      const m = re.exec(line)
      if (m) {
        found.add(m[1].trim())
        break
      }
    }
  }
  return [...found]
}

// ---------------------------------------------------------------- running

const stampOf = (now) => now.replace(/[:.]/g, '-')

// A node child that runs the command through the shell in a process group of its own, stops the
// group (the process tree on Windows) past the timeout, and writes how it ended to fd 3.
// spawnSync waits on this child, so a run stays synchronous.
const GROUP_RUNNER = `
const { spawn, spawnSync } = require('node:child_process')
const { writeSync } = require('node:fs')
const [command, cwd, ms] = process.argv.slice(1)
const windows = process.platform === 'win32'
let ended = false
const end = (result) => {
  if (ended) return
  ended = true
  clearTimeout(timer)
  writeSync(3, JSON.stringify(result))
}
const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'inherit', 'inherit'], detached: !windows, windowsHide: true })
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}, Number(ms))
child.on('error', (error) => end({ error: error.message }))
child.on('exit', (code, signal) => end({ code, signal, timedOut }))
`

// Runs one command through the platform shell in <cwd>, its output to <file>, never to stdout:
// { exit, signal?, cannotRun, timedOut?, error?, text }. lib/tdd-proof.mjs runs its tests with it.
export function runOnce(command, cwd, file, timeoutMinutes) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  const ms = Math.round(timeoutMinutes * 60000)
  let result
  try {
    result = spawnSync(process.execPath, ['-e', GROUP_RUNNER, command, cwd, String(ms)], {
      cwd,
      stdio: ['ignore', fd, fd, 'pipe'],
      windowsHide: true,
      timeout: ms + 60000
    })
  } finally {
    closeSync(fd)
  }
  const text = readFileSync(file, 'utf8')
  let ended = null
  try {
    ended = JSON.parse(String(result.output?.[3] ?? ''))
  } catch {}
  if (ended?.timedOut || result.error?.code === 'ETIMEDOUT') {
    return { exit: null, cannotRun: true, timedOut: true, error: `the run did not finish within ${timeoutMinutes} minute(s) and was stopped`, text }
  }
  if (result.error) return { exit: null, cannotRun: true, error: result.error.message, text }
  if (!ended) return { exit: null, cannotRun: true, error: `the runner ended without a result (exit ${result.status}, signal ${result.signal})`, text }
  if (ended.error) return { exit: null, cannotRun: true, error: ended.error, text }
  const exit = ended.code ?? 1
  return { exit, ...(ended.signal ? { signal: ended.signal } : {}), cannotRun: CANNOT_RUN.includes(exit), text }
}

function attempt(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

function baseCheck(root, change, command, file, timeoutMinutes) {
  let made
  try {
    made = addBaseCheck(root, { change })
  } catch (error) {
    return { error: `no base-check worktree: ${error.message}`, cannotRun: true }
  }
  const ran = runOnce(command, made.root, file, timeoutMinutes)
  const base = {
    ref: made.ref,
    commit: made.commit,
    exit: ran.exit,
    outputFile: rel(root, file),
    failing: failingIn(ran.text),
    cannotRun: ran.cannotRun,
    ...(ran.timedOut ? { timedOut: true } : {}),
    ...(ran.error ? { error: ran.error } : {})
  }
  try {
    removeBaseCheck(root, { change })
    base.removed = true
  } catch (error) {
    base.removed = false
    base.removeError = error.message
  }
  return base
}

// Which failures block, given the head run and the base run.
function compare(head, base) {
  if (!base) return { preExisting: [], newFailures: head.failing, blocking: true, comparison: 'none' }
  if (base.cannotRun) return { preExisting: [], newFailures: head.failing, blocking: true, comparison: 'none' }
  if (base.exit === 0) return { preExisting: [], newFailures: head.failing, blocking: true, comparison: head.failing.length ? 'tests' : 'whole-run' }
  if (head.failing.length > 0 && base.failing.length > 0) {
    const onBase = new Set(base.failing)
    const preExisting = head.failing.filter((f) => onBase.has(f))
    const newFailures = head.failing.filter((f) => !onBase.has(f))
    return { preExisting, newFailures, blocking: newFailures.length > 0, comparison: 'tests' }
  }
  return { preExisting: ['the whole run: the base fails too, and the runner names no failing test to compare'], newFailures: [], blocking: false, comparison: 'whole-run' }
}

function dirtyPaths(git, change) {
  const record = `openspec/changes/${change}/${RECORD_FILE}`
  const status = attempt(() => git('status', '--porcelain', '--untracked-files=all')) ?? ''
  return status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => p !== record)
}

const fence = (lines) => ['```text', ...(lines.length ? lines : ['(none)']), '```']

// ---------------------------------------------------------------- the writers

// The apply test record. Its `**Commit:**` line is what verify reads, so only a run that may
// stand carries one: a not-run or blocking record has none, and verify reports it as no record
// rather than citing it.
export function recordText(result) {
  const { command, now } = result
  const lines = ['# Apply test record', '']
  const stands = result.status === 'pass' || result.status === 'pre-existing'
  if (stands) lines.push(`**Commit:** \`${result.commit}\``)
  lines.push(`**Command:** ${command ? `\`${command}\`` : '(none)'}`, `**Run at:** ${now}`)
  if (result.status === 'not-run') {
    lines.push('**Result:** not run', '', `The whole suite was not run: ${result.reason}`, '')
    return lines.join('\n')
  }
  lines.push(`**Ran on:** \`${result.commit}\``, `**Exit:** ${result.exit}`, `**Result:** ${result.status}`, `**Output file:** \`${result.outputFile}\``)
  if (result.timedOut) lines.push(`**Timed out:** ${result.error}`)
  if (result.dirty.length) lines.push(`**Uncommitted paths when the suite ran:** ${result.dirty.map((p) => `\`${p}\``).join(', ')}`)
  lines.push('', "## The runner's counts", '', ...fence(result.counts), '')
  lines.push(`## The output, last ${QUOTE_LINES} lines`, '', ...fence(result.quote), '')
  if (result.base) {
    const b = result.base
    lines.push('## Base check', '')
    if (b.error && b.exit === undefined) lines.push(`- ${b.error}`)
    else lines.push(`- base \`${b.ref}\` at \`${b.commit}\`: exit ${b.exit}${b.cannotRun ? ' (the command could not run there)' : ''}, output \`${b.outputFile}\``)
    if (b.removed === false) lines.push(`- the base-check worktree was not removed: ${b.removeError}`)
    lines.push(`- comparison: ${result.comparison}`, '')
  }
  if (result.preExisting.length) lines.push('## Pre-existing failures, separate work', '', ...result.preExisting.map((f) => `- ${f}`), '')
  if (result.blocking && result.newFailures.length) lines.push('## Failures that block', '', ...result.newFailures.map((f) => `- ${f}`), '')
  return lines.join('\n')
}

// The verify section that replaces a stale record's result: `verify/test-record.json` and its
// output file, in the shape computeVerdict accepts.
function sectionVerdict(result) {
  if (result.status === 'not-run') return { verdict: 'not-run', summary: `the whole suite was not run: ${result.reason}` }
  if (result.status === 'pass') return { verdict: 'pass', summary: `the whole suite passed (exit 0) at ${result.commit.slice(0, 7)}` }
  if (result.status === 'pre-existing') {
    return { verdict: 'warn', summary: `the suite fails (exit ${result.exit}) only on what also fails on the base: ${result.preExisting.join('; ')}` }
  }
  if (result.timedOut) return { verdict: 'fail', summary: `${result.error}: the developer raises --timeout, fixes the hang or rules` }
  if (result.cannotRun) return { verdict: 'fail', summary: `the suite cannot run in this workspace (exit ${result.exit ?? result.error}): the developer provisions it or rules` }
  const what = result.newFailures.length ? `: ${result.newFailures.join('; ')}` : ''
  const why = !result.base ? 'no base check was made' : result.base.cannotRun ? 'the base check could not run' : 'it does not reproduce on the base'
  return { verdict: 'fail', summary: `the suite fails (exit ${result.exit}) and ${why}${what}` }
}

function writeSection(root, change, result) {
  const dir = verifyDir(root, change)
  mkdirSync(dir, { recursive: true })
  const outFile = join(dir, `${SECTION_ID}-suite.txt`)
  const text = recordText(result)
  const { warnings } = reconcileCounts(root, change, result.status === 'not-run' ? null : text)
  let { verdict, summary } = sectionVerdict(result)
  if (verdict === 'pass' && warnings.length) {
    verdict = 'warn'
    summary = `${summary}; ${warnings.length} test count warning(s)`
  }
  writeFileSync(outFile, `${text}\n${warnings.length ? `\n## Test count warnings\n\n${warnings.map((w) => `- warning: ${w}`).join('\n')}\n` : ''}`)
  // preExisting and countWarnings are read by verify.mjs assemble; computeVerdict ignores them.
  const section = { id: SECTION_ID, title: CHECKS[SECTION_ID], verdict, summary, output: rel(root, outFile), preExisting: result.preExisting, countWarnings: warnings }
  const file = join(dir, `${SECTION_ID}.json`)
  writeFileSync(file, `${JSON.stringify(section, null, 2)}\n`)
  return { file: rel(root, file), ...section }
}

// The review stage's record of the run: what review.mjs assemble renders and gates on.
function writeReviewSection(root, change, result) {
  const dir = join(root, '.superpowers', 'sdd', change, 'review')
  mkdirSync(dir, { recursive: true })
  const b = result.base
  const record = {
    at: result.now,
    status: result.status,
    commit: result.commit ?? null,
    command: result.command,
    exit: result.exit,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    counts: result.counts,
    outputFile: result.outputFile,
    base: b ? { ref: b.ref ?? null, commit: b.commit ?? null, exit: b.exit ?? null, outputFile: b.outputFile ?? null, cannotRun: Boolean(b.cannotRun), ...(b.error ? { error: b.error } : {}) } : null,
    comparison: result.comparison ?? 'none',
    preExisting: result.preExisting,
    newFailures: result.newFailures,
    blocking: result.blocking
  }
  const file = join(dir, 'suite.json')
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return { file: rel(root, file), ...record }
}

// ---------------------------------------------------------------- run

export function runSuite(rootArg, { change, baseCheck: withBaseArg = false, record = false, section = null, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  if (!change) throw new Error('no change name')
  if (!(typeof timeoutMinutes === 'number' && timeoutMinutes > 0 && Number.isFinite(timeoutMinutes))) throw new Error('the timeout must be a positive number of minutes')
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  if (section !== null && !SECTIONS.includes(section)) throw new Error(`--section must be one of ${SECTIONS.join(', ')}`)
  // The review's run tells a new failure from a pre-existing one, so it always checks the base.
  const withBase = withBaseArg || section === REVIEW_SECTION
  const git = gitIn(root)
  const { command, reason } = readCommand(root)
  let result
  if (command === null) {
    result = { status: 'not-run', reason, command: null, now, exit: null, counts: [], outputFile: null, preExisting: [], newFailures: [], blocking: true }
  } else {
    const commit = git('rev-parse', 'HEAD')
    const dirty = dirtyPaths(git, change)
    const stamp = stampOf(now)
    const dir = join(root, '.superpowers', 'sdd', change, 'suite')
    const file = join(dir, `${stamp}.txt`)
    const ran = runOnce(command, root, file, timeoutMinutes)
    const head = { failing: failingIn(ran.text) }
    let base
    let verdict
    if (ran.exit === 0) verdict = { preExisting: [], newFailures: [], blocking: false, comparison: 'none' }
    else if (ran.cannotRun) verdict = { preExisting: [], newFailures: head.failing, blocking: true, comparison: 'none' }
    else {
      if (withBase) base = baseCheck(root, change, command, join(dir, `${stamp}-base.txt`), timeoutMinutes)
      verdict = compare(head, base)
    }
    const status = ran.exit === 0 ? 'pass' : verdict.blocking ? 'fail' : 'pre-existing'
    result = {
      status,
      command,
      now,
      commit,
      dirty,
      exit: ran.exit,
      ...(ran.signal ? { signal: ran.signal } : {}),
      ...(ran.error ? { error: ran.error } : {}),
      cannotRun: ran.cannotRun,
      ...(ran.timedOut ? { timedOut: true, timeoutMinutes } : {}),
      counts: countLines(ran.text),
      quote: ran.text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, all) => i < all.length - 1 || l).slice(-QUOTE_LINES),
      outputFile: rel(root, file),
      failing: head.failing,
      ...(base ? { base } : {}),
      ...verdict
    }
  }
  const out = { ...result }
  delete out.quote
  delete out.now
  out.ok = !result.blocking
  if (record) {
    const file = join(changeDir(root, change), RECORD_FILE)
    writeFileSync(file, recordText(result))
    out.record = rel(root, file)
  }
  if (section === SECTION_ID) out.section = writeSection(root, change, result)
  else if (section === REVIEW_SECTION) out.section = writeReviewSection(root, change, result)
  return out
}

// ---------------------------------------------------------------- covering tests

// `runCovering` runs the tests that cover one dispatch's work, the command the implementer names,
// in that dispatch's worktree, through runOnce. It writes two files under
// `<root>/.superpowers/sdd/<change>/tests/`: `<name>-<stamp>.txt`, the raw output, and
// `<name>-<stamp>.json`, the test-run record a reply names:
//   { command, exit, counts: { pass, fail, skipped, total } | null, failing, outputFile, worktree,
//     sha, timedOut?, error? }
// `exit` is null when the run did not finish (a timeout, a spawn error). `counts` is what
// countsOf parses from the runner's own summary, or null when the output holds none: never a
// guess. A timed-out run has no counts, since a partial summary would read as a whole one.
// `outputFile` is relative to <root>; `sha` is the worktree's HEAD before the run.
// A run that happened is a record whatever its result; the reader decides what a failure means.
export const TESTS_DIR = 'tests'

// A dispatch name as a file name: spaces as hyphens, as dispatch.mjs names its reply files.
export function recordName(name) {
  const out = String(name ?? '').trim().replace(/ /g, '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out) || out.includes('..')) throw new Error(`the name "${name}" is not usable in a file name (letters, digits, ".", "_", "-" and spaces only)`)
  return out
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const num = (s) => Number(s)

// The last test summary of the output, as { pass, fail, skipped, total }, or null:
// - node:test, TAP or spec reporter: `# tests 5`, `# pass 4`, `# fail 1`, `# skipped 0`,
//   `# todo 0`, `# cancelled 0` (or `ℹ` for `#`); cancelled counts as fail, todo as skipped
// - Jest: `Tests:       1 failed, 1 skipped, 4 passed, 6 total`
// - Vitest: `Tests  1 failed | 4 passed | 1 skipped (6)`
// The file lines (`Test Suites:`, `Test Files`) are not test counts and are ignored.
export function countsOf(text) {
  const lines = String(text ?? '').replace(ANSI, '').split(/\r?\n/)
  let found = null
  let node = null
  const flushNode = () => {
    if (node && node.tests !== undefined && node.pass !== undefined) {
      found = { pass: node.pass, fail: (node.fail ?? 0) + (node.cancelled ?? 0), skipped: (node.skipped ?? 0) + (node.todo ?? 0), total: node.tests }
    }
    node = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    const n = /^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/.exec(line)
    if (n) {
      if (n[1] === 'tests' && node?.tests !== undefined) flushNode()
      node ??= {}
      node[n[1]] = num(n[2])
      continue
    }
    flushNode()
    const jest = /^Tests:\s+(.*\d+ total)\s*$/.exec(line)
    if (jest) {
      const part = (word) => num(new RegExp(`(\\d+) ${word}\\b`).exec(jest[1])?.[1] ?? 0)
      found = { pass: part('passed'), fail: part('failed'), skipped: part('skipped') + part('todo'), total: part('total') }
      continue
    }
    const vitest = /^Tests\s+(.*)\((\d+)\)\s*$/.exec(line)
    if (vitest && /\d+ (?:passed|failed|skipped|todo)\b/.test(vitest[1])) {
      const part = (word) => num(new RegExp(`(\\d+) ${word}\\b`).exec(vitest[1])?.[1] ?? 0)
      found = { pass: part('passed'), fail: part('failed'), skipped: part('skipped') + part('todo'), total: num(vitest[2]) }
    }
  }
  flushNode()
  return found
}

export function runCovering(rootArg, { change, name, command, worktree, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  if (!change) throw new Error('no change name')
  const base = recordName(name)
  const cmd = String(command ?? '').trim()
  if (!cmd) throw new Error('no command to run')
  if (!worktree) throw new Error('no worktree')
  if (!(typeof timeoutMinutes === 'number' && timeoutMinutes > 0 && Number.isFinite(timeoutMinutes))) throw new Error('the timeout must be a positive number of minutes')
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  const dir = resolve(worktree)
  if (!existsSync(dir)) throw new Error(`the worktree ${dir} does not exist`)
  const sha = attempt(() => gitIn(dir)('rev-parse', 'HEAD'))
  if (!sha) throw new Error(`${dir} is not a git worktree with a commit`)
  const stem = join(root, '.superpowers', 'sdd', change, TESTS_DIR, `${base}-${stampOf(now)}`)
  const outFile = `${stem}.txt`
  const ran = runOnce(cmd, dir, outFile, timeoutMinutes)
  const record = {
    command: cmd,
    exit: ran.exit,
    counts: ran.timedOut ? null : countsOf(ran.text),
    failing: failingIn(ran.text),
    outputFile: rel(root, outFile),
    worktree: dir,
    sha,
    ...(ran.timedOut ? { timedOut: true } : {}),
    ...(ran.error ? { error: ran.error } : {})
  }
  const file = `${stem}.json`
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return { file: rel(root, file), ...record }
}

// A test-run record runCovering wrote, checked for its shape; throws naming the file and the
// first field that is wrong. The output file is not opened: it is relative to the root.
export function readTestRecord(file) {
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: not a test-run record (${error.message})`)
  }
  const bad = (field) => {
    throw new Error(`${file}: not a test-run record (${field})`)
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) bad('not an object')
  if (typeof record.command !== 'string' || !record.command) bad('command')
  if (!(record.exit === null || Number.isInteger(record.exit))) bad('exit')
  if (record.counts !== null) {
    const c = record.counts
    if (!c || typeof c !== 'object' || !['pass', 'fail', 'skipped', 'total'].every((k) => Number.isInteger(c[k]) && c[k] >= 0)) bad('counts')
  }
  if (!Array.isArray(record.failing) || !record.failing.every((f) => typeof f === 'string')) bad('failing')
  if (typeof record.outputFile !== 'string' || !record.outputFile) bad('outputFile')
  if (typeof record.worktree !== 'string' || !record.worktree) bad('worktree')
  if (typeof record.sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(record.sha)) bad('sha')
  return record
}
