// The whole-suite run of apply and verify, done by a script so no agent reports a count it did
// not see.
//
// The command lives under `## Whole-suite command` in `<root>/openspec/planning.md`, as a fenced
// block, an inline code span or a plain line (HTML comments are ignored). `readCommand` reads
// it; `writeCommand` writes it there, creating the file or the section when absent. Committing
// it is the caller's job.
//
// `runSuite` runs that command with `<root>` as the working directory, through the platform
// shell (`spawnSync(command, { shell: true })`: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on
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
// `✕`/`×` lines, pytest `FAILED`, Go `--- FAIL:`). When both runs name their failures, a failure
// is pre-existing when the base names it too, and the rest are new. When the runner names
// none, the comparison is of the whole run: a base run that also fails makes the failure
// pre-existing, and the result says `comparison: "whole-run"`, since a partial overlap cannot
// be told apart there; compare the two output files before relying on it. A command that cannot
// run on the base (exit 126 or 127, a spawn error, or no base-check worktree) blocks.
//
// The run is `blocking` unless it passed or every failure is pre-existing. A suite that cannot
// run at all (exit 126 or 127) is a failure, never a pass.
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
export const TAIL_LINES = 40
// Lines of the real output quoted in the committed record; the whole output stays in its file.
export const QUOTE_LINES = 60
const CANNOT_RUN = [126, 127]

const toPosix = (p) => p.split('\\').join('/')
const rel = (root, file) => toPosix(relative(root, file))

// ---------------------------------------------------------------- the planning guide

// [start, end) line indexes of the section body, or null when the heading is absent.
function sectionBounds(lines) {
  const at = lines.findIndex((l) => l.trim() === HEADING)
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
  /^FAILED\s+(\S+)/, // pytest
  /^\s*--- FAIL:\s+(\S+)/ // Go
]

export function failingIn(text) {
  const found = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
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

function runOnce(command, cwd, file) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  let result
  try {
    result = spawnSync(command, { cwd, shell: true, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally {
    closeSync(fd)
  }
  const text = readFileSync(file, 'utf8')
  if (result.error) return { exit: null, cannotRun: true, error: result.error.message, text }
  const exit = result.status ?? 1
  return { exit, ...(result.signal ? { signal: result.signal } : {}), cannotRun: CANNOT_RUN.includes(exit), text }
}

function attempt(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

function baseCheck(root, change, command, file) {
  let made
  try {
    made = addBaseCheck(root, { change })
  } catch (error) {
    return { error: `no base-check worktree: ${error.message}`, cannotRun: true }
  }
  const ran = runOnce(command, made.root, file)
  const base = {
    ref: made.ref,
    commit: made.commit,
    exit: ran.exit,
    outputFile: rel(root, file),
    failing: failingIn(ran.text),
    cannotRun: ran.cannotRun,
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
  const section = { id: SECTION_ID, title: CHECKS[SECTION_ID], verdict, summary, output: rel(root, outFile) }
  const file = join(dir, `${SECTION_ID}.json`)
  writeFileSync(file, `${JSON.stringify(section, null, 2)}\n`)
  return { file: rel(root, file), ...section }
}

// ---------------------------------------------------------------- run

export function runSuite(rootArg, { change, baseCheck: withBase = false, record = false, section = null, now = new Date().toISOString() }) {
  const root = resolve(rootArg)
  if (!change) throw new Error('no change name')
  if (!existsSync(changeDir(root, change))) throw new Error(`no change "${change}" in ${root}/openspec/changes`)
  if (section !== null && section !== SECTION_ID) throw new Error(`--section must be ${SECTION_ID}`)
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
    const ran = runOnce(command, root, file)
    const head = { failing: failingIn(ran.text) }
    let base
    let verdict
    if (ran.exit === 0) verdict = { preExisting: [], newFailures: [], blocking: false, comparison: 'none' }
    else if (ran.cannotRun) verdict = { preExisting: [], newFailures: head.failing, blocking: true, comparison: 'none' }
    else {
      if (withBase) base = baseCheck(root, change, command, join(dir, `${stamp}-base.txt`))
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
  if (section) out.section = writeSection(root, change, result)
  return out
}
