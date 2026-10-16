// The English check: which Bash commands commit, which files such a commit takes, which of
// those files are in scope, and which of their lines hold non-English text. The hook entry
// (../hook.mjs) only reads stdin and exits; everything it decides is here.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'

export const PLUGIN_NAME = 'english-check'
export const REGISTRY_PATH = '.claude/adf-extensions.json'
const DECLARATION_FILE = 'adf-extension.json'

// Cyrillic, CJK punctuation, ideographs, and fullwidth forms: the origin's four ranges.
// Deliberately does not match em dashes, arrows or typographic quotes, which are fine in
// English prose. Written with escapes, not literals, so this file does not trip its own check.
export const FOREIGN = /[\u0400-\u04ff\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

export const DEFAULT_CONFIG = Object.freeze({
  include: ['openspec/changes/**', 'openspec/specs/**'],
  // A plan quotes code and fixtures verbatim; `**` also covers archive/<date>-<name>/plan.md,
  // so archiving, which moves the file without changing a byte, does not change the verdict.
  exclude: ['openspec/changes/**/plan.md'],
  extensions: ['md', 'mjs', 'yaml', 'yml', 'json']
})

// Every offending line, 1-based, echoed whole so the author fixes it without opening the file.
export function findForeign(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (FOREIGN.test(line)) out.push({ line: i + 1, text: line })
  })
  return out
}

// A glob over a repository-relative path: `**` spans directories (`a/**/b` also matches
// `a/b`), `*` and `?` stay inside one path segment. Every other character is literal.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function normalizePath(path) {
  const p = posix.normalize(String(path).replace(/\\/g, '/')).replace(/^\.\//, '')
  return p === '.' ? '' : p
}

// Exclusion is tested first, so an `exclude` glob always wins over an `include` glob.
export function inScope(path, config = DEFAULT_CONFIG) {
  const p = normalizePath(path)
  const name = p.slice(p.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1)
  if (!config.extensions.includes(extension)) return false
  if (config.exclude.some((g) => globToRegExp(g).test(p))) return false
  return config.include.some((g) => globToRegExp(g).test(p))
}

function stringList(value, key) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${PLUGIN_NAME} config: ${key} must be a list of strings`)
  }
  return value
}

// A host's configuration replaces a default key by key; a key it does not set keeps the default.
export function resolveConfig(config) {
  if (config === undefined || config === null) return { ...DEFAULT_CONFIG }
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error(`${PLUGIN_NAME} config must be an object`)
  const out = { ...DEFAULT_CONFIG }
  for (const key of ['include', 'exclude']) if (config[key] !== undefined) out[key] = stringList(config[key], key)
  if (config.extensions !== undefined) out.extensions = stringList(config.extensions, 'extensions').map((e) => e.replace(/^\./, ''))
  return out
}

function isOurEntry(root, entry) {
  if (typeof entry?.plugin === 'string') return entry.plugin.split('@')[0] === PLUGIN_NAME
  if (typeof entry?.path !== 'string') return false
  const file = join(isAbsolute(entry.path) ? entry.path : join(root, entry.path), DECLARATION_FILE)
  try {
    return JSON.parse(readFileSync(file, 'utf8')).name === PLUGIN_NAME
  } catch {
    return false
  }
}

// The host registry's entry for this plugin, if any, gives the configuration; no registry or
// no entry means the defaults.
export function loadConfig(root) {
  const file = join(root, REGISTRY_PATH)
  if (!existsSync(file)) return resolveConfig()
  const registry = JSON.parse(readFileSync(file, 'utf8'))
  const entry = (Array.isArray(registry?.extensions) ? registry.extensions : []).find((e) => isOurEntry(root, e))
  return resolveConfig(entry?.config)
}

// Splits a shell command line into simple commands, each a list of words. Quotes and
// backslashes are honoured; `&&`, `||`, `;`, `|`, `&`, parentheses and newlines separate.
export function splitCommands(line) {
  const commands = []
  let words = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      const stop = end === -1 ? line.length : end
      word += line.slice(i + 1, stop)
      inWord = true
      i = stop
    } else if (c === '"') {
      inWord = true
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) i++
        word += line[i]
      }
    } else if (c === '\\' && i + 1 < line.length) {
      i++
      if (line[i] !== '\n') {
        word += line[i]
        inWord = true
      }
    } else if (';&|()\n'.includes(c)) endCommand()
    else if (c === ' ' || c === '\t') endWord()
    else if (c === '#' && !inWord) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const GIT_OPTIONS_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
// Short commit options that take a value: in a cluster such as `-am`, the rest is that value.
const COMMIT_VALUE_FLAGS = 'mFcCt'

function stagesAll(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (arg === '--all') return true
    if (/^-[A-Za-z]+$/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'a') return true
        if (COMMIT_VALUE_FLAGS.includes(arg[j])) {
          // `-m msg`: the next word is the value; `-mmsg`: the rest of the cluster is.
          if (j === arg.length - 1) i++
          break
        }
      }
    }
  }
  return false
}

// The git invocation a word list runs, if any: its directory (after `-C`) and subcommand.
function gitCall(words, dir) {
  let i = 0
  while (i < words.length && (ASSIGNMENT.test(words[i]) || words[i] === 'env' || words[i] === 'command')) i++
  const program = words[i]
  if (program === undefined || program.slice(program.lastIndexOf('/') + 1) !== 'git') return null
  let at = dir
  for (i++; i < words.length; i++) {
    const w = words[i]
    if (w === '-C') at = resolve(at, words[++i] ?? '.')
    else if (GIT_OPTIONS_WITH_VALUE.has(w)) i++
    else if (!w.startsWith('-')) return { dir: at, subcommand: w, args: words.slice(i + 1) }
  }
  return null
}

// The script a word list runs with node (`node [options] <script> ...`, or the script run
// directly): its base name and its arguments.
function scriptCall(words) {
  let i = 0
  while (i < words.length && (ASSIGNMENT.test(words[i]) || words[i] === 'env' || words[i] === 'command')) i++
  const base = (w) => (w ?? '').slice((w ?? '').replace(/\\/g, '/').lastIndexOf('/') + 1)
  if (/^node(\.exe)?$/.test(base(words[i]))) for (i++; i < words.length && words[i].startsWith('-'); i++);
  if (!/\.mjs$/.test(base(words[i]))) return null
  return { script: base(words[i]), args: words.slice(i + 1) }
}

// Every value an option takes in an argument list (`--name value` or `--name=value`).
function optionValues(args, name) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[++i])
    else if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1))
  }
  return out
}

// The ADF core's scripts that commit by path, and the paths each commits, relative to its
// --root. A new core script that commits must be added here, or its commits go unchecked.
export const CORE_COMMIT_SCRIPTS = {
  // commit.mjs --root <r> --only <path> [--only <path> ...] --message <m>
  'commit.mjs': (args) => optionValues(args, '--only'),
  // tasks.mjs tick ... --change <name> --commit: the tasks file and plan.md of the change.
  'tasks.mjs': (args) => {
    const change = optionValues(args, '--change')[0]
    if (args[0] !== 'tick' || !args.includes('--commit') || !change) return null
    return [`openspec/changes/${change}/tasks.md`, `openspec/changes/${change}/plan.md`]
  },
  // propose.mjs commit [--change <name>]: the change directory; without --change the one
  // active change, which the hook cannot name, so every change directory.
  'propose.mjs': (args) => {
    if (args[0] !== 'commit') return null
    const change = optionValues(args, '--change')[0]
    return [change ? `openspec/changes/${change}` : 'openspec/changes']
  },
  // verify.mjs assemble --change <name> --commit: the record; verify.mjs skill-edit: the
  // host's skills, the only paths it commits.
  'verify.mjs': (args) => {
    const change = optionValues(args, '--change')[0]
    if (args[0] === 'assemble' && args.includes('--commit') && change) return [`openspec/changes/${change}/verify.md`]
    if (args[0] === 'skill-edit') return ['.claude/skills']
    return null
  },
  // suite.mjs run --change <name> --record --commit: the test record; suite.mjs set --commit:
  // the planning guide.
  'suite.mjs': (args) => {
    if (!args.includes('--commit')) return null
    const change = optionValues(args, '--change')[0]
    if (args[0] === 'run' && args.includes('--record') && change) return [`openspec/changes/${change}/.apply-test-record.md`]
    if (args[0] === 'set') return ['openspec/planning.md']
    return null
  },
  // dup.mjs mark --file <path> --commit: the marked file.
  'dup.mjs': (args) => (args[0] === 'mark' && args.includes('--commit') ? optionValues(args, '--file') : null),
  // review.mjs assemble --change <name> --commit: the record; review.mjs mark --file <path>
  // --commit: the marked file.
  'review.mjs': (args) => {
    if (!args.includes('--commit')) return null
    const change = optionValues(args, '--change')[0]
    if (args[0] === 'assemble' && change) return [`openspec/changes/${change}/review.md`]
    if (args[0] === 'mark') return optionValues(args, '--file')
    return null
  },
  // plan.mjs added [--change <name>] --commit: plan.md; without --change the one active
  // change, which the hook cannot name, so every change directory.
  'plan.mjs': (args) => {
    if (args[0] !== 'added' || !args.includes('--commit')) return null
    const change = optionValues(args, '--change')[0]
    return [change ? `openspec/changes/${change}/plan.md` : 'openspec/changes']
  }
}

function coreCommit(words, dir) {
  const call = scriptCall(words)
  const pathsOf = call && Object.hasOwn(CORE_COMMIT_SCRIPTS, call.script) ? CORE_COMMIT_SCRIPTS[call.script] : null
  const paths = pathsOf?.(call.args)
  if (!paths?.length) return null
  const root = resolve(dir, optionValues(call.args, '--root')[0] ?? '.')
  // verify.mjs skill-edit --diff-file <f> applies the diff after this hook runs: the text it
  // adds is in the diff, not yet in the files.
  const diffFile = call.script === 'verify.mjs' && call.args[0] === 'skill-edit' ? optionValues(call.args, '--diff-file')[0] : undefined
  return { dir: root, paths: paths.map((p) => (isAbsolute(p) ? relative(root, p) : p)), ...(diffFile ? { diffFile: resolve(dir, diffFile) } : {}) }
}

// The commits a Bash command line makes: where each runs, and whether it takes more than the
// index. A hook runs before the command does, so a `git add` on the same line has not staged
// anything yet; then, as with `-a`, the working tree's changes count too. `cd <dir>` moves
// every later command of the line. A run of an ADF core commit script is a commit of the
// `paths` it names, relative to
// its root.
export function parseCommits(command, cwd) {
  let dir = cwd
  const calls = []
  const scripts = []
  for (const words of splitCommands(command)) {
    if (words[0] === 'cd' && words.length <= 2) {
      const target = words[1] ?? homedir()
      if (target !== '-') dir = resolve(dir, target.replace(/^~(?=\/|$)/, homedir()))
      continue
    }
    const call = gitCall(words, dir)
    if (call) calls.push(call)
    const core = call ? null : coreCommit(words, dir)
    if (core) scripts.push(core)
  }
  const adds = calls.some((c) => c.subcommand === 'add')
  return calls
    .filter((c) => c.subcommand === 'commit')
    .map((c) => ({ dir: c.dir, wide: adds || stagesAll(c.args) }))
    .concat(scripts)
}

const defaultGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const names = (output) => output.split('\0').filter(Boolean)

// The repository root of one commit and the repository-relative paths it takes. Only added,
// copied, modified or renamed paths: a deleted path has no text to check. Outside a repository
// (or in a directory that does not exist) the commit is git's to refuse, so root is null.
// With `paths` (relative to `dir`), only the files under them count.
export function commitFiles({ dir, wide, paths }, git = defaultGit) {
  let root
  try {
    if (!existsSync(dir)) return { root: null, files: [] }
    root = git(['rev-parse', '--show-toplevel'], dir).trim()
  } catch {
    return { root: null, files: [] }
  }
  // A commit by path takes the staged, modified and untracked files under those paths alone.
  let spec = []
  if (paths) {
    const prefix = relative(realpathSync(root), realpathSync(dir))
    spec = paths.map((p) => normalizePath(join(prefix, p))).filter((p) => p && p !== '..' && !p.startsWith('../') && !isAbsolute(p))
    if (!spec.length) return { root, files: [] }
    spec = ['--', ...spec.map((p) => `:(literal)${p}`)]
  }
  const files = new Set(names(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', ...spec], root)))
  if (wide || paths) {
    for (const f of names(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', ...spec], root))) files.add(f)
    for (const f of names(git(['ls-files', '--others', '--exclude-standard', '-z', ...spec], root))) files.add(f)
  }
  return { root, files: [...files].sort() }
}

// Findings for files of one repository: scope first, then the text. A path that cannot be
// read is never a finding.
export function scanFiles(root, files, config) {
  const findings = []
  for (const path of files) {
    if (!inScope(path, config)) continue
    let text
    try {
      text = readFileSync(join(root, path), 'utf8')
    } catch {
      continue
    }
    for (const { line, text: lineText } of findForeign(text)) findings.push({ path, line, text: lineText })
  }
  return findings
}

// Findings for the lines a unified diff adds, by the path and line number they will have. A
// diff that cannot be read is git apply's to refuse, so it is no finding.
export function scanDiff(diffFile, config) {
  let text
  try {
    text = readFileSync(diffFile, 'utf8')
  } catch {
    return []
  }
  const findings = []
  let path = null
  let line = 0
  for (const row of text.split(/\r?\n/)) {
    const target = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(row)
    if (target) {
      path = target[1] === '/dev/null' ? null : normalizePath(target[1])
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!path || row.startsWith('---')) continue
    if (row.startsWith('+')) {
      if (inScope(path, config) && FOREIGN.test(row.slice(1))) findings.push({ path, line, text: row.slice(1) })
      line++
    } else if (row.startsWith(' ')) line++
  }
  return findings
}

export function formatFindings(findings) {
  return [
    `${PLUGIN_NAME}: the commit was stopped; these lines are not in English:`,
    ...findings.map((f) => `${f.path}:${f.line}: ${f.text}`),
    'Rewrite those lines in English, then run the command again.'
  ].join('\n')
}

// The whole hook decision for one PreToolUse input: { code, stderr }. Code 0 lets the call
// run, 2 blocks it and gives stderr to the agent.
export function checkHookInput(input, git = defaultGit) {
  const command = input?.tool_input?.command
  if (input?.tool_name !== 'Bash' || typeof command !== 'string') return { code: 0, stderr: '' }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const findings = []
  for (const commit of parseCommits(command, cwd)) {
    const { root, files } = commitFiles(commit, git)
    if (!root) continue
    const config = loadConfig(root)
    const scanned = scanFiles(root, files, config).concat(commit.diffFile ? scanDiff(commit.diffFile, config) : [])
    // A line may run two commits in one repository; each finding is reported once.
    for (const f of scanned) {
      if (!findings.some((g) => g.root === root && g.path === f.path && g.line === f.line)) findings.push({ root, ...f })
    }
  }
  return findings.length ? { code: 2, stderr: `${formatFindings(findings)}\n` } : { code: 0, stderr: '' }
}
