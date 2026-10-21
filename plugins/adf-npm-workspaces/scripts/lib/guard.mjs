// The install guard: a Claude Code PreToolUse hook (matcher Bash) that blocks an npm command
// which changes the dependency tree when it runs in a linked git worktree. A provisioned
// worktree's node_modules links into the main checkout's, so the command would rewrite the
// main checkout's dependencies.
//
// The command line is read simply: it is split into simple commands at `&&`, `||`, `;`, `|`,
// `&`, parentheses and newlines; `cd <dir>` moves the effective directory for the commands
// after it; `npm --prefix <dir>` (or `-C <dir>`) moves it for that command. A line that
// cannot be read (an open quote) is allowed: the guard fails open.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { PLUGIN_NAME } from './provision.mjs'

// The commands the ban names and the aliases npm accepts for them.
export const INSTALL_COMMANDS = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add',
  'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean',
  'install-test', 'it', 'install-ci-test', 'cit',
  'update', 'up', 'upgrade', 'udpate',
  'uninstall', 'unlink', 'remove', 'rm', 'r', 'un'
])
// Options before the npm command that take a value as the next word.
const VALUE_OPTIONS = new Set(['--prefix', '-C', '--workspace', '-w', '--userconfig', '--cache', '--registry', '--loglevel'])
const GLOBAL_OPTIONS = new Set(['-g', '--global', '--location=global'])

class ParseError extends Error {}

// Simple commands as lists of words; quotes are removed, `\` escapes outside single quotes.
export function splitCommands(line) {
  const commands = []
  let words = []
  let word = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) throw new ParseError('open single quote')
      word = (word ?? '') + line.slice(i + 1, close)
      i = close
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) j++
        text += line[j]
      }
      if (j >= line.length) throw new ParseError('open double quote')
      word = (word ?? '') + text
      i = j
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i]
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (';&|()\n'.includes(c)) {
      endCommand()
    } else {
      word = (word ?? '') + c
    }
  }
  endCommand()
  return commands
}

// The directories an install-like npm command in `line` would run in; null for one whose
// directory cannot be told (a `cd` to a variable before it).
export function installDirectories(line, cwd) {
  const found = []
  let dir = cwd
  for (const command of splitCommands(line)) {
    const words = [...command]
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
    if (words.length === 0) continue
    if (words[0] === 'cd') {
      const target = words[1] ?? '~'
      if (/[$`]/.test(target) || target === '-') dir = null
      else if (target === '~' || target.startsWith('~/')) dir = resolve(homedir(), target.slice(2))
      else dir = dir === null && !target.startsWith('/') ? null : resolve(dir ?? '/', target)
      continue
    }
    if (basename(words[0]) !== 'npm') continue
    let prefix = null
    let sub = null
    let global = false
    for (let i = 1; i < words.length; i++) {
      const w = words[i]
      if (GLOBAL_OPTIONS.has(w)) global = true
      else if (w.startsWith('--prefix=')) prefix = w.slice('--prefix='.length)
      else if (w === '--prefix' || w === '-C') prefix = words[++i] ?? null
      else if (VALUE_OPTIONS.has(w)) i++
      else if (w.startsWith('-')) continue
      else if (sub === null) sub = w
    }
    if (sub === null || !INSTALL_COMMANDS.has(sub) || global) continue
    if (prefix !== null && /[$`]/.test(prefix)) found.push({ sub, dir: null })
    else if (prefix !== null && prefix.startsWith('/')) found.push({ sub, dir: prefix })
    else found.push({ sub, dir: dir === null ? null : resolve(dir, prefix ?? '.') })
  }
  return found
}

// A linked worktree's git dir differs from the repository's common dir; the main checkout's
// are the same. Outside a repository, or in a directory that does not exist, it is not one.
export function isLinkedWorktree(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (r.error || r.status !== 0) return false
  const [gitDir, commonDir] = r.stdout.trim().split('\n')
  if (!gitDir || !commonDir) return false
  const real = (path) => {
    try {
      return realpathSync.native(path)
    } catch {
      return path
    }
  }
  return real(gitDir) !== real(commonDir)
}

// { code, stderr }: 0 the call runs, 2 the call is blocked and stderr says why.
export function guardHookInput(input) {
  if (input?.tool_name !== undefined && input.tool_name !== 'Bash') return { code: 0, stderr: '' }
  const line = input?.tool_input?.command
  if (typeof line !== 'string') return { code: 0, stderr: '' }
  let targets
  try {
    targets = installDirectories(line, typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd())
  } catch (error) {
    if (error instanceof ParseError) return { code: 0, stderr: '' }
    throw error
  }
  for (const { sub, dir } of targets) {
    if (dir === null || !isLinkedWorktree(dir)) continue
    return {
      code: 2,
      stderr:
        `${PLUGIN_NAME}: \`npm ${sub}\` is blocked in ${dir}, a linked git worktree. ` +
        "Its node_modules links into the main checkout's, so the command would rewrite the main checkout's dependencies. " +
        'A dependency update is its own change: make it in the main checkout.\n'
    }
  }
  return { code: 0, stderr: '' }
}
