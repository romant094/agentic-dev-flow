// The `provision` and `teardown` hooks of the ADF contract for PostgreSQL: a change or group
// worktree gets its own database, named from its branch, and its copy of the env file points
// at it; teardown drops that database.
//
// Every operation returns one result object with `state`: `done`, `degraded` (psql or Docker
// cannot be reached: nothing was created, and `hint` says what to do first) or `refused` (with
// `error`, which says what was and was not done).
//
// The administrative connection is the main checkout's own connection string with the
// database `postgres`: same server, same credentials, nothing new to configure. The password
// never travels in an argument vector (`docker exec` arguments are visible in the container's
// process list): it goes through PGPASSWORD, and it is cut out of every error this returns.
//
// Every psql call goes through the injected `run(cmd, args, { cwd, env })`, which returns
// { status, stdout, stderr } (status null when the program could not be started), so no test
// needs Docker, psql or a database.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Postgres truncates identifiers at 63 bytes. Truncating here keeps the name provision
// computes equal to the name teardown recomputes from the same branch.
const MAX_IDENTIFIER = 63
// Truncation alone collides: two branches sharing a long prefix would map to one database,
// and a drop from one would destroy the other's. The hash is of the FULL branch name, so
// distinct branches get distinct names, and it is deterministic, so teardown finds the same one.
const HASH_LENGTH = 8

const KINDS = ['change', 'group', 'base-check', 'proof']
const WITH_DATABASE = ['change', 'group']
const PREFIX = /^[a-z][a-z0-9_]*$/
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const TAIL_LINES = 20
const TAIL_CHARS = 2000

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const refused = (error) => ({ state: 'refused', error })
const done = (actions, notes) => ({ state: 'done', actions, notes })

// ---------------------------------------------------------------- the database name

// The origin's algorithm (worktree-db.mjs databaseNameFor), with the project's prefix in place
// of the hard-coded one.
export function databaseNameFor(prefix, branch) {
  if (!branch || branch.trim() === '') {
    // An empty branch (a detached HEAD) would give the bare prefix: a plausible name for a
    // real database, which teardown would destroy.
    throw new Error('Refusing to derive a database name from an empty branch name')
  }
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, HASH_LENGTH)
  const stem = `${prefix}_${slug}`.slice(0, MAX_IDENTIFIER - HASH_LENGTH - 1).replace(/_+$/, '')
  return `${stem}_${hash}`
}

// ---------------------------------------------------------------- connection strings

export function withDatabaseName(url, name) {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

export function splitPassword(url) {
  const parsed = new URL(url)
  const password = decodeURIComponent(parsed.password)
  parsed.password = ''
  return { url: parsed.toString(), password }
}

// Cuts every credential out of a tool's output: the password itself, in plain and encoded
// form, and the password part of any connection string.
export function redact(text, password) {
  let out = String(text)
  for (const secret of new Set([password, encodeURIComponent(password ?? '')])) {
    if (secret) out = out.split(secret).join('***')
  }
  return out.replace(/(\/\/[^:/@\s]+):[^@\s]*@/g, '$1:***@')
}

export function tail(text) {
  const lines = String(text).trim().split('\n')
  return lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
}

// ---------------------------------------------------------------- the env file

// One assignment line: indent, optional `export `, key, `=` with its spacing, the rest.
const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/

// Splits an assignment's right-hand side into its quote, value and what follows (spacing and a
// comment). Returns null for an unterminated quote.
export function parseValue(rest) {
  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    let value = ''
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]
      if (quote === '"' && ch === '\\' && i + 1 < rest.length) {
        value += rest[++i]
        continue
      }
      if (ch === quote) return { quote, value, suffix: rest.slice(i + 1) }
      value += ch
    }
    return null
  }
  const comment = /\s+#/.exec(rest)
  const body = comment ? rest.slice(0, comment.index) : rest
  const value = body.trimEnd()
  return { quote: '', value: value.trim(), suffix: rest.slice(value.length) }
}

const splitLine = (line) => (line.endsWith('\r') ? [line.slice(0, -1), '\r'] : [line, ''])

// The value of `key` the way an env loader reads it: comments skipped, `export ` and quotes
// allowed; the last assignment wins. Undefined when the key is not assigned.
export function readEnvValue(text, key) {
  let found
  for (const raw of text.split('\n')) {
    const [line] = splitLine(raw)
    const m = ASSIGNMENT.exec(line)
    if (!m || m[3] !== key) continue
    const parsed = parseValue(m[5])
    if (!parsed) throw new Error(`${key} has an unterminated quote`)
    found = parsed.value
  }
  return found
}

const quoted = (quote, value) => {
  if (quote === '"') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  if (quote === "'") return `'${value}'`
  return value
}

// Rewrites every assignment of `key` to `value`, keeping its indent, `export `, spacing, quote
// style, comment and line ending; every other line stays byte-identical. A key that is not
// assigned is appended.
export function setEnvValue(text, key, value) {
  let hit = false
  const lines = text.split('\n').map((raw) => {
    const [line, cr] = splitLine(raw)
    const m = ASSIGNMENT.exec(line)
    if (!m || m[3] !== key) return raw
    const parsed = parseValue(m[5])
    if (!parsed) throw new Error(`${key} has an unterminated quote`)
    hit = true
    return `${m[1]}${m[2] ?? ''}${m[3]}${m[4]}${quoted(parsed.quote, value)}${parsed.suffix}${cr}`
  })
  if (hit) return lines.join('\n')
  const line = `${key}=${value}`
  if (text === '' || text.endsWith('\n')) return `${text}${line}\n`
  return `${text}\n${line}\n`
}

// ---------------------------------------------------------------- config and input

export function readConfig(config) {
  const problems = []
  if (!isObject(config)) return { problems: ['config must be an object'] }
  const { prefix, url, exec = 'local' } = config
  if (prefix === undefined) problems.push('config.prefix is missing')
  else if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
    problems.push('config.prefix must be lower-case letters, digits and underscores, starting with a letter')
  }
  if (url === undefined) problems.push('config.url is missing: { file, key }')
  else if (!isObject(url)) problems.push('config.url must be an object: { file, key }')
  else {
    if (!isText(url.file)) problems.push('config.url.file is missing')
    else if (isAbsolute(url.file) || url.file.split(/[\\/]/).includes('..')) {
      problems.push('config.url.file must be a path inside the checkout, relative to its root')
    }
    if (!isText(url.key)) problems.push('config.url.key is missing')
    else if (!ENV_KEY.test(url.key)) problems.push('config.url.key must be an environment variable name')
  }
  const execOk = exec === 'local' || (isObject(exec) && Object.keys(exec).length === 1 && typeof exec.docker === 'string' && CONTAINER.test(exec.docker))
  if (!execOk) problems.push('config.exec must be "local" or { "docker": "<container>" }')
  return { problems, prefix, file: url?.file, key: url?.key, exec }
}

function readInput(input, fields) {
  const problems = []
  if (!isObject(input)) return ['input must be an object']
  for (const field of ['worktree', 'main']) {
    if (!isText(input[field]) || !isAbsolute(input[field])) problems.push(`input.${field} must be an absolute path`)
  }
  if (!KINDS.includes(input.kind)) problems.push(`input.kind must be one of ${KINDS.join(', ')}`)
  if (fields.includes('needs') && !Array.isArray(input.needs)) problems.push('input.needs must be a list')
  if (input.branch !== null && input.branch !== undefined && typeof input.branch !== 'string') {
    problems.push('input.branch must be a string or null')
  }
  return problems
}

// The main checkout's connection string with the database `postgres`. Throws a message that
// never holds the password.
function adminUrl(main, { file, key }) {
  const path = join(main, file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${file} in the main checkout (${main})`)
  }
  const value = readEnvValue(text, key)
  if (!value) throw new Error(`${file} in the main checkout assigns no ${key}`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${key} in the main checkout's ${file} is not a URL`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${key} in the main checkout's ${file} is not a postgres:// or postgresql:// URL`)
  }
  return withDatabaseName(value, 'postgres')
}

// ---------------------------------------------------------------- psql

export function psqlCommand(exec, url, sql) {
  const tailArgs = [url, '-v', 'ON_ERROR_STOP=1', '-c', sql]
  if (exec === 'local') return { cmd: 'psql', args: tailArgs }
  // `-e PGPASSWORD` with no value passes the variable through from this process's
  // environment, so the value is in neither argument vector.
  return { cmd: 'docker', args: ['exec', '-e', 'PGPASSWORD', exec.docker, 'psql', ...tailArgs] }
}

export function classifyFailure(result) {
  if (result.status === null || result.status === undefined) return 'unavailable'
  const message = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  if (/already exists/i.test(message)) return 'exists'
  if (/no such container|is not running|cannot connect to the docker daemon|spawn\w* \S+ enoent|connection refused|could not connect to server|is the server running/i.test(message)) {
    return 'unavailable'
  }
  return 'other'
}

function psql({ run, root, exec }, url, sql) {
  const { url: bare, password } = splitPassword(url)
  const { cmd, args } = psqlCommand(exec, bare, sql)
  const result = run(cmd, args, { cwd: root, env: { PGPASSWORD: password } })
  if (result?.status === 0) return { kind: 'ok', message: '' }
  return { kind: classifyFailure(result ?? {}), message: tail(redact(`${result?.stderr ?? ''}\n${result?.stdout ?? ''}`, password)) }
}

const where = (exec) => (exec === 'local' ? 'psql' : `the "${exec.docker}" container`)
const startHint = (exec) =>
  exec === 'local'
    ? 'install the PostgreSQL client (psql) and start the server, then rerun the core provision step with --need database'
    : `start the "${exec.docker}" container (docker start ${exec.docker}), then rerun the core provision step with --need database`

// ---------------------------------------------------------------- operations

function provision({ run, root, config, input }) {
  const cfg = readConfig(config)
  if (cfg.problems.length) return refused(`${cfg.problems.join('; ')}; nothing was created.`)
  const problems = readInput(input, ['needs'])
  if (problems.length) return refused(`${problems.join('; ')}; nothing was created.`)
  if (!WITH_DATABASE.includes(input.kind)) return done([], [`a ${input.kind} worktree gets no database.`])
  if (!input.needs.includes('database')) return done([], ['needs does not name database, so no database was made.'])
  if (!isText(input.branch)) {
    return refused('branch is null (a detached HEAD?): there is no branch to name a database after; nothing was created.')
  }
  if (input.worktree === input.main) {
    return refused(`the worktree is the main checkout, whose ${cfg.file} must not be rewritten; nothing was created.`)
  }

  // The worktree's copy is checked before anything is created: a link would rewrite the
  // file it points at (the main checkout's own), so it is refused, never followed.
  const target = join(input.worktree, cfg.file)
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return refused(`${cfg.file} is missing in the worktree: the core's ## Worktree copies must name ${cfg.file}; nothing was created.`)
  }
  if (stat.isSymbolicLink()) return refused(`${cfg.file} in the worktree is a symbolic link, which is never written through; nothing was created.`)
  if (!stat.isFile()) return refused(`${cfg.file} in the worktree is not a file; nothing was created.`)

  let admin
  try {
    admin = adminUrl(input.main, cfg)
  } catch (error) {
    return refused(`${error.message}; nothing was created.`)
  }
  const name = databaseNameFor(cfg.prefix, input.branch)

  const created = psql({ run, root, exec: cfg.exec }, admin, `CREATE DATABASE "${name}"`)
  if (created.kind === 'unavailable') {
    return {
      state: 'degraded',
      hint: startHint(cfg.exec),
      actions: [],
      notes: [`cannot reach ${where(cfg.exec)}, so ${name} was not created and ${cfg.file} was not changed.`]
    }
  }
  if (created.kind === 'other') return refused(`could not create ${name}; ${cfg.file} was not changed:\n${created.message}`)

  // An existing database is not a failure: the env file must still point at it, or the
  // worktree is left with a database it cannot reach and a rerun never fixes it.
  const actions = created.kind === 'ok' ? [{ op: 'create-database', path: name }] : []
  const notes = created.kind === 'ok' ? [`created ${name}.`] : [`${name} already exists; it is kept.`]
  try {
    writeFileSync(target, setEnvValue(readFileSync(target, 'utf8'), cfg.key, withDatabaseName(admin, name)))
  } catch (error) {
    return refused(`${created.kind === 'ok' ? `created ${name}, but` : `${name} exists, but`} could not rewrite ${cfg.key} in ${cfg.file}: ${error.message}`)
  }
  actions.push({ op: 'write', path: cfg.file })
  notes.push(`${cfg.key} in ${cfg.file} points at ${name}. A database made for a worktree is disposable.`)
  return done(actions, notes)
}

function teardown({ run, root, config, input }) {
  const cfg = readConfig(config)
  if (cfg.problems.length) return refused(`${cfg.problems.join('; ')}; nothing was dropped.`)
  const problems = readInput(input, [])
  if (problems.length) return refused(`${problems.join('; ')}; nothing was dropped.`)
  if (!WITH_DATABASE.includes(input.kind)) return done([], [])
  if (!isText(input.branch)) return done([], ['no branch was given, so no database was dropped.'])

  let admin
  try {
    admin = adminUrl(input.main, cfg)
  } catch (error) {
    return refused(`${error.message}; nothing was dropped.`)
  }
  const name = databaseNameFor(cfg.prefix, input.branch)
  const dropped = psql({ run, root, exec: cfg.exec }, admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  if (dropped.kind === 'ok') return done([{ op: 'drop-database', path: name }], [`dropped ${name} (a no-op when it was never created).`])
  // Teardown runs for every change, also for one that never asked for a database: a stopped
  // server must not stop it.
  if (dropped.kind === 'unavailable') return done([], [`cannot reach ${where(cfg.exec)}, so ${name} was not dropped.`])
  return refused(`could not drop ${name}:\n${dropped.message}`)
}

const OPERATIONS = { provision, teardown }

export function runOperation(operation, payload, ctx) {
  try {
    if (!Object.hasOwn(OPERATIONS, operation)) {
      return { code: 1, result: refused(`unknown operation "${operation}", expected ${Object.keys(OPERATIONS).join(', ')}; nothing was done.`) }
    }
    if (!isObject(payload)) return { code: 1, result: refused('the input must be a JSON object; nothing was done.') }
    const { root, config = {}, input = {} } = payload
    if (!isText(root)) return { code: 1, result: refused('root is required; nothing was done.') }
    const result = OPERATIONS[operation]({ ...ctx, root, config, input })
    return { code: result.state === 'refused' ? 1 : 0, result }
  } catch (error) {
    return { code: 1, result: refused(`${error.message}; nothing was done.`) }
  }
}
