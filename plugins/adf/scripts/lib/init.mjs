// What /adf:init infers from the host for the developer to confirm, and the one section it writes
// on that confirmation. Nothing here commits.
//
//   suiteCandidates  whole-suite commands: the CI configuration's test commands (`.gitlab-ci.yml`,
//                    `.github/workflows/*.yml`), then the package scripts named `test`, `test:*`
//   copyCandidates   the `.env*` files git ignores in the main checkout, which a fresh worktree
//                    lacks; those `## Worktree copies` already names left out
//   writeCopies      adds confirmed paths to the planning guide's `## Worktree copies`
//   oldFlowMentions  the lines of the host's agent instruction files (CLAUDE.md, AGENTS.md and the
//                    like) that name a previous flow's commands: read only, for the report
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { PLANNING_FILE, sectionBounds } from './guide.mjs'
import { packageManager } from './prepare.mjs'
import { COPIES_HEADING, readCopies } from './provision.mjs'
import { WORKTREES_DIR } from './workspace.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const inside = (path) => typeof path === 'string' && path !== '' && !isAbsolute(path) && !normalize(path).startsWith('..')
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
// A path under a dependency directory or a change worktree is never the host's own.
const foreign = (path) => path.split('/').includes('node_modules') || path.startsWith(`${WORKTREES_DIR}/`)

// ---------------------------------------------------------------- the whole-suite command

// A command that runs tests: the word `test` or `tests` as a token (`npm test`, `turbo run test`,
// `npm run test:ci`, `go test`) or a test runner's name.
const TESTS = /(?:^|[\s:/])tests?(?:$|[\s:'"])|\b(?:jest|vitest|pytest|mocha|tox)\b/
// A one-word list item is a stage or a job name (`- test` under `stages:`), unless it is a runner.
const RUNNER = /^(?:jest|vitest|pytest|mocha|tox)$/
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
const indentOf = (line) => /^\s*/.exec(line)[0].length

// The shell lines of a CI file, with their 1-based line numbers: list items (`- cmd`,
// `- run: cmd`), `run:` and `script:` values, and the lines of a block scalar (`run: |`, `- |`).
// A list item that is a mapping (`- uses: ...`) is not a command.
export function ciCommands(text) {
  const out = []
  let block = null
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    if (block !== null) {
      if (raw.trim() === '') return
      if (indentOf(raw) > block) {
        if (!raw.trim().startsWith('#')) out.push({ line: i + 1, command: raw.trim() })
        return
      }
      block = null
    }
    if (/^\s*(?:-\s*)?(?:[\w-]+:\s*)?[|>][-+]?\s*$/.test(raw)) {
      block = indentOf(raw)
      return
    }
    const m = /^\s*(?:-\s+(?:run:\s+)?|(?:run|script):\s+)(.+)$/.exec(raw)
    if (!m || /^[\w-]+:(?:\s|$)/.test(m[1]) || /^[[{&*#]/.test(m[1])) return
    const command = unquote(m[1])
    if (command) out.push({ line: i + 1, command })
  })
  return out
}

function ciFiles(root) {
  const dir = join(root, '.github', 'workflows')
  const workflows = existsSync(dir) ? readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort().map((n) => `.github/workflows/${n}`) : []
  return ['.gitlab-ci.yml', ...workflows].filter((f) => existsSync(join(root, f)))
}

const PLACEHOLDER = /no test specified/

export function suiteCandidates(rootArg) {
  const root = resolve(rootArg)
  const out = []
  const add = (c) => {
    if (!out.some((o) => o.command === c.command)) out.push(c)
  }
  for (const file of ciFiles(root)) {
    for (const { line, command } of ciCommands(readFileSync(join(root, file), 'utf8'))) {
      if (!TESTS.test(command) || (!/\s/.test(command) && !RUNNER.test(command))) continue
      add({ command, source: `${file}:${line}`, why: `the CI runs it in ${file}` })
    }
  }
  const pkg = attempt(() => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
  const manager = packageManager(root)
  for (const [name, value] of Object.entries(pkg?.scripts ?? {})) {
    if (typeof value !== 'string' || PLACEHOLDER.test(value) || !(name === 'test' || /^test[:-]/.test(name))) continue
    add({ command: name === 'test' ? `${manager} test` : `${manager} run ${name}`, source: 'package.json', why: `package.json script "${name}": ${value}` })
  }
  return out
}

// ---------------------------------------------------------------- the worktree copies

export function copyCandidates(rootArg) {
  const root = resolve(rootArg)
  const listed = new Set(readCopies(root))
  // `--directory` collapses a wholly ignored directory into one `dir/` entry, so git never walks
  // a dependency tree; only file entries named `.env*` are kept.
  const out = git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
  return [...new Set(out.split('\0').filter((p) => p && !p.endsWith('/') && /^\.env/.test(p.split('/').at(-1))))].filter((p) => !foreign(p) && !listed.has(p)).sort()
}

// Adds the paths to `## Worktree copies`, one list item each after the ones it names, keeping the
// section's HTML comments; creates the guide or the section when absent.
export function writeCopies(rootArg, paths) {
  const root = resolve(rootArg)
  const given = (paths ?? []).map((p) => String(p).trim().replace(/\/+$/, '')).filter(Boolean)
  if (given.length === 0) throw new Error('no path to write')
  const outside = given.filter((p) => !inside(p) || p.includes('`'))
  if (outside.length) throw new Error(`${outside.join(', ')} is not a path inside the project`)
  const copies = [...new Set([...readCopies(root), ...given])]
  const file = join(root, PLANNING_FILE)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const items = copies.map((p) => `- \`${p}\``)
  const bounds = sectionBounds(lines, COPIES_HEADING)
  if (bounds) {
    const comments = (lines.slice(bounds.start, bounds.end).join('\n').match(/<!--[\s\S]*?-->/g) ?? []).flatMap((c) => c.split('\n'))
    lines.splice(bounds.start, bounds.end - bounds.start, '', ...(comments.length ? [...comments, ''] : []), ...items, '')
  } else {
    while (lines.length && lines.at(-1) === '') lines.pop()
    lines.push(...(lines.length ? [''] : []), COPIES_HEADING, '', ...items, '')
  }
  mkdirSync(dirname(file), { recursive: true })
  const out = lines.join(eol)
  writeFileSync(file, out.endsWith(eol) ? out : out + eol)
  return { file, copies: readCopies(root) }
}

// ---------------------------------------------------------------- a previous flow

// The agent instruction files a host keeps, tracked or not; a git-ignored personal file such as
// CLAUDE.local.md included.
const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']

// What names a previous flow: a namespaced slash command other than this flow's own (`/adf:`,
// `/adf-<plugin>:`), OpenSpec's schema directory and command files, and the OpenSpec CLI.
const MENTIONS = [
  ['slash-command', /(?<![\w.:/-])\/(?!adf(?:-[\w-]+)?:)[a-z][\w-]*:[\w-]+/i],
  ['openspec-schema', /openspec\/schemas\b/],
  ['opsx-commands', /\.claude\/commands\/opsx\b/],
  ['openspec-cli', /\bopenspec (?:update|instructions|archive|validate|status|new|list|show|init)\b/]
]
const TEXT_MAX = 160

function instructionFiles(root) {
  const specs = INSTRUCTION_FILES.map((name) => (name.includes('/') ? name : `:(glob)**/${name}`))
  const listed = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs).split('\0').filter(Boolean)
  const personal = ['CLAUDE.local.md', '.claude/CLAUDE.local.md'].filter((p) => existsSync(join(root, p)))
  return [...new Set([...listed, ...personal])].filter((p) => !foreign(p) && existsSync(join(root, p))).sort()
}

// Each line once, in file and line order: { file, line, text, kinds }.
export function oldFlowMentions(rootArg) {
  const root = resolve(rootArg)
  const out = []
  for (const file of instructionFiles(root)) {
    readFileSync(join(root, file), 'utf8').split(/\r?\n/).forEach((raw, i) => {
      const kinds = MENTIONS.filter(([, re]) => re.test(raw)).map(([kind]) => kind)
      if (kinds.length === 0) return
      const text = raw.trim()
      out.push({ file, line: i + 1, text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text, kinds })
    })
  }
  return out
}

export function oldFlowReport(mentions) {
  if (mentions.length === 0) return 'Previous flow: no agent instruction file names one'
  const files = new Set(mentions.map((m) => m.file))
  return [
    `Previous flow: ${mentions.length} line(s) in ${files.size} agent instruction file(s) name another flow's commands; reword them for /adf:*, nothing was changed:`,
    ...mentions.map((m) => `  ${m.file}:${m.line}  ${m.text}`)
  ].join('\n')
}
