// The `provision` hook: the Prisma part of a worktree.
//
// It runs after the dependency provider (which gave the worktree a real `node_modules` whose
// third-party entries are links into the main checkout's) and after the database provider
// (which may have written the worktree's own database URL). In order:
//
// 1. With no schema directory in the worktree, it does nothing.
// 2. The generated client. When a changed path matches `ownClientWhen`, the worktree's links
//    `node_modules/.prisma` and `node_modules/@prisma/client` are replaced by real copies of
//    what they point to, then `prisma generate` runs. Otherwise the links stay, and nothing is
//    generated: a generate through a link would rewrite the main checkout's client.
// 3. The database. Only a database that is the worktree's own (its URL names another database
//    than the main checkout's) gets `prisma migrate deploy`, then `prisma db seed`.
//
// Every command is `npx --yes prisma@<exact version> ...` in the worktree, through the injected
// `run(cmd, args, opts)`, which returns { status, stdout, stderr }. A bare `npx prisma` is never
// run: it resolves the newest major, not the host's. A database URL is never printed.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_PATHS = ['node_modules/.prisma', 'node_modules/@prisma/client']
const TAIL_LINES = 20

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
const exists = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- version

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// The CLI version: `config.cli`, else the host's `@prisma/client` with a leading ^ or ~
// stripped. Anything else that is not one exact version is refused: the CLI and the client
// must be the same version, and a range lets npx pick another one.
export function cliVersion(config, pkg) {
  if (config.cli !== undefined) {
    if (typeof config.cli === 'string' && EXACT.test(config.cli)) return { version: config.cli }
    return { error: `config.cli must be one exact version such as 6.19.2, got ${JSON.stringify(config.cli)}` }
  }
  const declared = pkg?.dependencies?.['@prisma/client'] ?? pkg?.devDependencies?.['@prisma/client']
  if (declared === undefined) {
    return { error: 'the host package.json declares no @prisma/client, so the Prisma CLI version is unknown: set config.cli to the exact version' }
  }
  const stripped = String(declared).trim().replace(/^[\^~]/, '')
  if (EXACT.test(stripped)) return { version: stripped }
  return { error: `@prisma/client is declared as "${declared}", which is not one exact version: set config.cli to the exact version to run` }
}

// ---------------------------------------------------------------- paths

const escape = (text) => text.replace(/[.+^${}()|\\]/g, '\\$&')

// A glob (`*` within a segment, `**` across segments, `?` one character), or a plain path:
// a path ending in `/` is a directory prefix, any other path matches itself and what is under it.
export function pathMatcher(pattern) {
  const p = pattern.replace(/^\.\//, '')
  if (/[*?[]/.test(p)) {
    const source = p
      .split('**')
      .map((part) => part.split('*').map((piece) => piece.split('?').map(escape).join('[^/]')).join('[^/]*'))
      .join('.*')
    return (path) => new RegExp(`^${source}$`).test(path)
  }
  if (p.endsWith('/')) return (path) => path.startsWith(p)
  return (path) => path === p || path.startsWith(`${p}/`)
}

export function matchingFiles(files, patterns) {
  const matchers = patterns.map(pathMatcher)
  return files.map((f) => f.replace(/^\.\//, '')).filter((f) => matchers.some((m) => m(f)))
}

// ---------------------------------------------------------------- env file

// The value of one key in a dotenv file: `KEY=value`, optionally `export KEY=value`, quotes
// stripped. Null when the file or the key is absent.
export function envValue(file, key) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || match[1] !== key) continue
    let value = match[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    return value
  }
  return null
}

// What names a database in a URL: scheme, host, port, path and the `schema` parameter. The user
// and password are left out, so a rotated password is still the same database.
export function databaseIdentity(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname}:${u.port}${u.pathname}?schema=${u.searchParams.get('schema') ?? ''}`
  } catch {
    return null
  }
}

// Every text a command's output could carry that identifies the database or its password.
function secretsOf(urls) {
  const secrets = []
  for (const url of urls) {
    if (!url) continue
    secrets.push(url)
    try {
      const u = new URL(url)
      if (u.password) secrets.push(u.password, decodeURIComponent(u.password))
    } catch {
      // not a URL: the whole value is already listed
    }
  }
  return [...new Set(secrets.filter((s) => s.length >= 3))].sort((a, b) => b.length - a.length)
}

export function redact(text, urls) {
  let out = text
  for (const secret of secretsOf(urls)) out = out.split(secret).join('<redacted>')
  // Any other credential-bearing URL the tool printed.
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@')
}

const tail = (text) => text.trim().split('\n').slice(-TAIL_LINES).join('\n')

// ---------------------------------------------------------------- client

// Replaces one link by a real copy of what it points to. The link is removed first, so nothing
// is ever written through it. A path that is already real is left alone.
function ownCopy(worktree, main, path) {
  const target = join(worktree, path)
  if (isLink(target)) {
    const source = realpathSync(target)
    unlinkSync(target)
    cpSync(source, target, { recursive: true, dereference: true })
    return true
  }
  if (exists(target)) return false
  const fromMain = join(main, path)
  if (!existsSync(fromMain)) return false
  cpSync(realpathSync(fromMain), target, { recursive: true, dereference: true })
  return true
}

// `node_modules/@prisma` itself may be one link into the main checkout. Then `@prisma/client`
// is reached through it, so the scope becomes a real directory whose entries link to the same
// targets the scope's entries had.
function realScope(worktree) {
  const scope = join(worktree, 'node_modules/@prisma')
  if (!isLink(scope)) return false
  const source = realpathSync(scope)
  unlinkSync(scope)
  mkdirSync(scope)
  for (const entry of readdirSync(source)) {
    // A relative link would resolve against the new directory, so the link is absolute.
    symlinkSync(join(source, entry), join(scope, entry))
  }
  return true
}

// ---------------------------------------------------------------- provision

export function provision(ctx) {
  const { run, root, config, input } = ctx
  const schema = config.schema ?? 'prisma'
  const ownClientWhen = config.ownClientWhen ?? [`${schema}/`, 'package.json', 'package-lock.json']
  const env = { file: '.env', key: 'DATABASE_URL', ...(config.env ?? {}) }
  const seed = config.seed ?? true
  const { worktree, main, files } = input
  const actions = []
  const notes = []
  const refuse = (error) => ({ state: 'refused', error, actions, notes })

  if (!existsSync(join(worktree, schema))) {
    notes.push(`no ${schema} directory in the worktree: nothing for Prisma to provision`)
    return { state: 'done', actions, notes }
  }

  const pkg = readPackage(worktree)
  const cli = cliVersion(config, pkg)
  if (cli.error) return refuse(`${cli.error}; nothing was changed.`)
  const prisma = (...args) => ['--yes', `prisma@${cli.version}`, ...args, ...(config.schema !== undefined && args[0] !== 'db' ? ['--schema', schema] : [])]

  // The database URL, read before any command so every failure can be redacted.
  const worktreeUrl = envValue(join(worktree, env.file), env.key)
  const mainUrl = envValue(join(main, env.file), env.key)
  const urls = [worktreeUrl, mainUrl]
  const commandEnv = { ...process.env, ...(worktreeUrl ? { [env.key]: worktreeUrl } : {}) }
  const npx = (args, what) => {
    const result = run('npx', args, { cwd: worktree, env: commandEnv })
    if (result.status === 0) return null
    const output = redact(tail(`${result.stderr ?? ''}\n${result.stdout ?? ''}`), urls)
    return refuse(`prisma ${what} failed (exit ${result.status ?? 'none'}) in the worktree:\n${output}`)
  }

  // The client.
  if (isLink(join(worktree, 'node_modules'))) {
    return refuse('the worktree node_modules is one link into another checkout: run the dependency provider (adf-npm-workspaces) before adf-prisma; nothing was changed.')
  }
  const matched = matchingFiles(files, ownClientWhen)
  const owned = CLIENT_PATHS.some((p) => exists(join(worktree, p)) && !isLink(join(worktree, p)))
  if (matched.length > 0 || owned) {
    if (!existsSync(join(worktree, 'node_modules/@prisma/client')) && !existsSync(join(main, 'node_modules/@prisma/client'))) {
      return refuse('no node_modules/@prisma/client in the worktree or the main checkout: install the dependencies in the main checkout first; nothing was changed.')
    }
    if (realScope(worktree)) actions.push({ op: 'unlink-scope', path: 'node_modules/@prisma' })
    for (const path of CLIENT_PATHS) if (ownCopy(worktree, main, path)) actions.push({ op: 'copy', path })
    const failed = npx(prisma('generate'), 'generate')
    if (failed) return failed
    actions.push({ op: 'generate', path: 'node_modules/.prisma' })
    notes.push(
      matched.length > 0
        ? `the worktree has its own Prisma client, generated by prisma@${cli.version}: the change touches ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? ', ...' : ''}`
        : `the worktree already had its own Prisma client; regenerated by prisma@${cli.version}`
    )
  } else {
    notes.push('the Prisma client is shared with the main checkout: the change touches no path in ownClientWhen, so nothing was generated')
  }

  // The database.
  if (!worktreeUrl) {
    notes.push(`no ${env.key} in the worktree's ${env.file}: no migration was applied`)
    return { state: 'done', actions, notes }
  }
  const own = databaseIdentity(worktreeUrl)
  const shared = databaseIdentity(mainUrl ?? '')
  if (own === null) {
    notes.push(`${env.key} in the worktree's ${env.file} is not a URL: no migration was applied`)
    return { state: 'done', actions, notes }
  }
  if (shared === null) {
    notes.push(`no ${env.key} in the main checkout's ${env.file} to compare with, so the worktree's database may be the developer's: no migration was applied`)
    return { state: 'done', actions, notes }
  }
  if (own === shared) {
    notes.push(`${env.key} names the main checkout's database, which is the developer's: no migration was applied`)
    return { state: 'done', actions, notes }
  }
  const migrateFailed = npx(prisma('migrate', 'deploy'), 'migrate deploy')
  if (migrateFailed) return migrateFailed
  actions.push({ op: 'migrate-deploy', path: `${schema}/migrations` })
  if (!seed) notes.push('the worktree database is migrated; config.seed is false, so it is not seeded')
  else if (!pkg?.prisma?.seed) notes.push('the worktree database is migrated; the host package.json has no prisma.seed, so it is not seeded')
  else {
    const seedFailed = npx(prisma('db', 'seed'), 'db seed')
    if (seedFailed) return seedFailed
    actions.push({ op: 'seed', path: 'package.json' })
    notes.push('the worktree database is migrated and seeded')
  }
  return { state: 'done', actions, notes }
}
