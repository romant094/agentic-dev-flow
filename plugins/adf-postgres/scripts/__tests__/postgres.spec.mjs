import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { databaseNameFor, readEnvValue, redact, runOperation, setEnvValue } from '../lib/postgres.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'postgres.mjs')

const PASSWORD = 's3cr#t p@ss'
const ENCODED = encodeURIComponent(PASSWORD)
const MAIN_URL = `postgresql://nms:${ENCODED}@localhost:5432/nms?schema=public`
const BRANCH = 'feat/DESTELENG-797/add-eee-form-descriptors'
const NAME = 'xnms_feat_desteleng_797_add_eee_form_descriptors_d075b744'
const CONFIG = { prefix: 'xnms', url: { file: '.env', key: 'DATABASE_URL' }, exec: { docker: 'db' } }

// Records every call with its options, and answers with the first handler whose prefix
// matches "cmd arg1 arg2 ...".
const record = (handlers) => {
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const key = `${cmd} ${args.join(' ')}`
    const hit = handlers.find(([prefix]) => key.startsWith(prefix))
    return hit ? hit[1] : { status: 1, stdout: '', stderr: 'no handler' }
  }
  return { run, calls }
}
const yes = { status: 0, stdout: '', stderr: '' }
const fail = (stderr) => ({ status: 1, stdout: '', stderr })

// A main checkout and a worktree in a temporary directory, each with its own env file.
const fixture = ({ mainEnv = `# local settings\nPORT=8080\nDATABASE_URL="${MAIN_URL}"\n`, worktreeEnv } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'adf-postgres-'))
  const main = join(dir, 'main')
  const worktree = join(dir, 'worktree')
  mkdirSync(main)
  mkdirSync(worktree)
  if (mainEnv !== null) writeFileSync(join(main, '.env'), mainEnv)
  const copy = worktreeEnv === undefined ? mainEnv : worktreeEnv
  if (copy !== null) writeFileSync(join(worktree, '.env'), copy)
  return { main, worktree }
}

const provisionInput = (paths, extra = {}) => ({
  ...paths,
  kind: 'change',
  change: 'add-eee',
  branch: BRANCH,
  base: { ref: 'develop', commit: 'abc123' },
  files: ['apps/server/prisma/schema.prisma'],
  needs: ['database'],
  ...extra
})

const op = (operation, input, handlers, config = CONFIG) => {
  const { run, calls } = record(handlers)
  const { code, result } = runOperation(operation, { root: input.worktree ?? '/work', config, input }, { run })
  return { code, result, calls }
}

const noPasswordIn = (calls) => {
  for (const { args } of calls) {
    const argv = args.join(' ')
    assert.ok(!argv.includes(PASSWORD) && !argv.includes(ENCODED), `password in argv: ${argv}`)
  }
}

// ---------------------------------------------------------------- the database name

// Computed on 2026-10-21 by importing databaseNameFor from the origin's
// .claude/scripts/worktree-db.mjs (whose prefix is the hard-coded `xnms`).
const ORIGIN_NAMES = [
  ['fix/DESTELENG-657/ip-address-forms', 'xnms_fix_desteleng_657_ip_address_forms_098f287d'],
  ['chore/worktree-provisioning-isolation', 'xnms_chore_worktree_provisioning_isolation_c92a4ddb'],
  [`feat/${'x'.repeat(200)}`, 'xnms_feat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_255d915c'],
  ['fix/DESTELENG-657/ip-address-advanced-form-controls-and-mask-clamping', 'xnms_fix_desteleng_657_ip_address_advanced_form_contro_5b229a7c'],
  ['fix/DESTELENG-657/ip-address-advanced-form-controls-and-reset-handling', 'xnms_fix_desteleng_657_ip_address_advanced_form_contro_5a4bae25'],
  ['Feat/Ünïcode--Name__', 'xnms_feat_n_code_name_b0d8dace'],
  ['---', 'xnms_cb3f91d5'],
  [BRANCH, NAME],
  ['a', 'xnms_a_ca978112']
]

test('the name matches the origin for every recorded branch', () => {
  for (const [branch, name] of ORIGIN_NAMES) assert.equal(databaseNameFor('xnms', branch), name, branch)
})

// With ADF_ORIGIN set to the origin project's root, the names are also compared with the
// origin's function itself (imported read-only; its CLI does not run on import).
const originScript = process.env.ADF_ORIGIN && join(process.env.ADF_ORIGIN, '.claude', 'scripts', 'worktree-db.mjs')
test('the name matches the live origin function', { skip: !(originScript && existsSync(originScript)) && 'ADF_ORIGIN is not set' }, async () => {
  const origin = await import(pathToFileURL(originScript).href)
  for (const [branch] of ORIGIN_NAMES) assert.equal(databaseNameFor('xnms', branch), origin.databaseNameFor(branch), branch)
})

test('the name stays within 63 bytes, has no doubled separator, and takes the prefix', () => {
  const name = databaseNameFor('shop', `feat/${'y'.repeat(300)}`)
  assert.ok(name.length <= 63, `got ${name.length}`)
  assert.ok(name.startsWith('shop_feat_'))
  assert.ok(!name.includes('__'))
  assert.match(databaseNameFor('shop', 'fix/a.b c'), /^shop_fix_a_b_c_[0-9a-f]{8}$/)
})

test('an empty branch gives no name', () => {
  assert.throws(() => databaseNameFor('xnms', ''), /empty branch/)
  assert.throws(() => databaseNameFor('xnms', '  '), /empty branch/)
})

// ---------------------------------------------------------------- the env file

test('readEnvValue handles quotes, export, comments, and the last assignment wins', () => {
  const text = [
    '# DATABASE_URL=commented',
    'export A="x # not a comment"',
    "B='single'",
    'C=plain # a comment',
    'C=later',
    'D = "esc\\"aped"'
  ].join('\n')
  assert.equal(readEnvValue(text, 'A'), 'x # not a comment')
  assert.equal(readEnvValue(text, 'B'), 'single')
  assert.equal(readEnvValue(text, 'C'), 'later')
  assert.equal(readEnvValue(text, 'D'), 'esc"aped')
  assert.equal(readEnvValue(text, 'DATABASE_URL'), undefined)
})

test('setEnvValue keeps every other line, the quoting, export, comment and line endings', () => {
  const text = '# top\r\nPORT=8080\r\nexport DATABASE_URL="old" # keep me\r\nOTHER=1\r\n'
  assert.equal(setEnvValue(text, 'DATABASE_URL', 'new'), '# top\r\nPORT=8080\r\nexport DATABASE_URL="new" # keep me\r\nOTHER=1\r\n')
  assert.equal(setEnvValue("K='a'\n", 'K', 'b'), "K='b'\n")
  assert.equal(setEnvValue('K=a # c\n', 'K', 'b'), 'K=b # c\n')
  assert.equal(setEnvValue('X=1', 'K', 'b'), 'X=1\nK=b\n')
})

test('redact removes the password and any URL credentials', () => {
  const out = redact(`FATAL for ${PASSWORD} at postgresql://u:${ENCODED}@h/db and postgres://a:other@h`, PASSWORD)
  assert.ok(!out.includes(PASSWORD) && !out.includes(ENCODED) && !out.includes('other@'))
})

// ---------------------------------------------------------------- config

test('a missing or malformed config is refused with what is missing', () => {
  const paths = fixture()
  let r = op('provision', provisionInput(paths), [], {})
  assert.equal(r.code, 1)
  assert.match(r.result.error, /config\.prefix is missing/)
  assert.match(r.result.error, /config\.url is missing/)
  r = op('provision', provisionInput(paths), [], { prefix: 'Bad-Prefix', url: { file: '/etc/env', key: 'A B' }, exec: { docker: '' } })
  assert.equal(r.code, 1)
  assert.match(r.result.error, /config\.prefix must be/)
  assert.match(r.result.error, /config\.url\.file must be a path inside/)
  assert.match(r.result.error, /config\.url\.key must be/)
  assert.match(r.result.error, /config\.exec must be/)
  assert.equal(r.calls.length, 0)
})

// ---------------------------------------------------------------- provision

test('provision does nothing without database in needs, or for a base-check', () => {
  const paths = fixture()
  for (const extra of [{ needs: [] }, { kind: 'base-check' }, { kind: 'proof' }]) {
    const r = op('provision', provisionInput(paths, extra), [])
    assert.equal(r.code, 0)
    assert.equal(r.result.state, 'done')
    assert.deepEqual(r.result.actions, [])
    assert.equal(r.result.notes.length, 1)
    assert.equal(r.calls.length, 0)
  }
})

test('provision refuses a null branch', () => {
  const r = op('provision', provisionInput(fixture(), { branch: null }), [])
  assert.equal(r.code, 1)
  assert.match(r.result.error, /no branch to name a database after/)
  assert.equal(r.calls.length, 0)
})

test('provision creates the database through docker and rewrites only the worktree copy', () => {
  const paths = fixture()
  const mainBefore = readFileSync(join(paths.main, '.env'), 'utf8')
  const r = op('provision', provisionInput(paths), [['docker exec', yes]])
  assert.equal(r.code, 0)
  assert.equal(r.result.state, 'done')
  assert.deepEqual(r.result.actions, [
    { op: 'create-database', path: NAME },
    { op: 'write', path: '.env' }
  ])
  assert.equal(r.calls.length, 1)
  const [call] = r.calls
  assert.equal(call.cmd, 'docker')
  assert.deepEqual(call.args.slice(0, 5), ['exec', '-e', 'PGPASSWORD', 'db', 'psql'])
  assert.equal(call.args.at(-1), `CREATE DATABASE "${NAME}"`)
  assert.match(call.args[5], /\/postgres\?schema=public$/)
  assert.equal(call.opts.env.PGPASSWORD, PASSWORD)
  noPasswordIn(r.calls)
  assert.equal(readFileSync(join(paths.main, '.env'), 'utf8'), mainBefore)
  assert.equal(
    readFileSync(join(paths.worktree, '.env'), 'utf8'),
    `# local settings\nPORT=8080\nDATABASE_URL="postgresql://nms:${ENCODED}@localhost:5432/${NAME}?schema=public"\n`
  )
})

test('provision with exec local runs psql with the password in the environment only', () => {
  const paths = fixture()
  const r = op('provision', provisionInput(paths), [['psql', yes]], { ...CONFIG, exec: 'local' })
  assert.equal(r.result.state, 'done')
  assert.equal(r.calls[0].cmd, 'psql')
  assert.equal(r.calls[0].opts.env.PGPASSWORD, PASSWORD)
  noPasswordIn(r.calls)
})

test('an existing database still gets its URL rewritten', () => {
  const paths = fixture({ worktreeEnv: `PORT=8080\nexport DATABASE_URL='${MAIN_URL}' # db\n` })
  const r = op('provision', provisionInput(paths), [['docker exec', fail(`ERROR:  database "${NAME}" already exists`)]])
  assert.equal(r.code, 0)
  assert.equal(r.result.state, 'done')
  assert.deepEqual(r.result.actions, [{ op: 'write', path: '.env' }])
  assert.match(r.result.notes[0], /already exists/)
  assert.equal(
    readFileSync(join(paths.worktree, '.env'), 'utf8'),
    `PORT=8080\nexport DATABASE_URL='postgresql://nms:${ENCODED}@localhost:5432/${NAME}?schema=public' # db\n`
  )
})

test('docker missing or the container stopped is degraded, and the env file is untouched', () => {
  for (const answer of [
    { status: null, stdout: '', stderr: 'spawnSync docker ENOENT' },
    fail('Error response from daemon: Container abc is not running'),
    fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
  ]) {
    const paths = fixture()
    const before = readFileSync(join(paths.worktree, '.env'), 'utf8')
    const r = op('provision', provisionInput(paths), [['docker exec', answer]])
    assert.equal(r.code, 0)
    assert.equal(r.result.state, 'degraded')
    assert.match(r.result.hint, /docker start db/)
    assert.equal(readFileSync(join(paths.worktree, '.env'), 'utf8'), before)
  }
})

test('another failure is refused with the tool output and no password', () => {
  const paths = fixture()
  const r = op('provision', provisionInput(paths), [
    ['docker exec', fail(`psql: error: connection to server at "localhost" failed: FATAL:  password authentication failed for postgresql://nms:${ENCODED}@localhost/postgres (${PASSWORD})`)]
  ])
  assert.equal(r.code, 1)
  assert.equal(r.result.state, 'refused')
  assert.match(r.result.error, /password authentication failed/)
  assert.ok(!r.result.error.includes(PASSWORD) && !r.result.error.includes(ENCODED))
})

test('a symlinked env file in the worktree is refused, not followed', () => {
  const paths = fixture({ worktreeEnv: null })
  symlinkSync(join(paths.main, '.env'), join(paths.worktree, '.env'))
  const before = readFileSync(join(paths.main, '.env'), 'utf8')
  const r = op('provision', provisionInput(paths), [['docker exec', yes]])
  assert.equal(r.code, 1)
  assert.match(r.result.error, /symbolic link/)
  assert.equal(r.calls.length, 0)
  assert.ok(lstatSync(join(paths.worktree, '.env')).isSymbolicLink())
  assert.equal(readFileSync(join(paths.main, '.env'), 'utf8'), before)
})

test('a missing env file in the worktree is refused and names the guide section', () => {
  const r = op('provision', provisionInput(fixture({ worktreeEnv: null })), [['docker exec', yes]])
  assert.equal(r.code, 1)
  assert.match(r.result.error, /the core's ## Worktree copies must name \.env/)
  assert.equal(r.calls.length, 0)
})

test('a main checkout without the key is refused without the password', () => {
  const r = op('provision', provisionInput(fixture({ mainEnv: 'PORT=8080\n' })), [['docker exec', yes]])
  assert.equal(r.code, 1)
  assert.match(r.result.error, /assigns no DATABASE_URL/)
  assert.equal(r.calls.length, 0)
})

// ---------------------------------------------------------------- teardown

const teardownInput = (paths, extra = {}) => ({ ...paths, kind: 'change', change: 'add-eee', branch: BRANCH, ...extra })

test('teardown drops the database named from the branch', () => {
  const paths = fixture()
  const r = op('teardown', teardownInput(paths), [['docker exec', yes]])
  assert.equal(r.code, 0)
  assert.equal(r.result.state, 'done')
  assert.deepEqual(r.result.actions, [{ op: 'drop-database', path: NAME }])
  assert.equal(r.calls[0].args.at(-1), `DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`)
  assert.equal(r.calls[0].opts.env.PGPASSWORD, PASSWORD)
  noPasswordIn(r.calls)
})

test('teardown with a stopped container is done with a note', () => {
  const r = op('teardown', teardownInput(fixture()), [['docker exec', fail('Error: No such container: db')]])
  assert.equal(r.code, 0)
  assert.equal(r.result.state, 'done')
  assert.deepEqual(r.result.actions, [])
  assert.match(r.result.notes[0], /was not dropped/)
})

test('teardown of a base-check or proof worktree does nothing', () => {
  for (const kind of ['base-check', 'proof']) {
    const r = op('teardown', teardownInput(fixture(), { kind }), [])
    assert.deepEqual(r.result, { state: 'done', actions: [], notes: [] })
    assert.equal(r.calls.length, 0)
  }
})

test('teardown refuses another failure without the password', () => {
  const r = op('teardown', teardownInput(fixture()), [['docker exec', fail(`ERROR: permission denied (${PASSWORD})`)]])
  assert.equal(r.code, 1)
  assert.ok(!r.result.error.includes(PASSWORD))
})

// ---------------------------------------------------------------- the CLI

test('the CLI prints one result and exits 1 on a refusal', () => {
  const r = spawnSync('node', [cli, 'provision'], { input: JSON.stringify({ root: '/work', config: {}, input: {} }), encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).state, 'refused')
  const skip = spawnSync('node', [cli, 'provision'], {
    input: JSON.stringify({ root: '/work', config: CONFIG, input: provisionInput({ worktree: '/w', main: '/m' }, { needs: [] }) }),
    encoding: 'utf8'
  })
  assert.equal(skip.status, 0)
  assert.equal(JSON.parse(skip.stdout).state, 'done')
  const bad = spawnSync('node', [cli, 'provision'], { input: 'not json', encoding: 'utf8' })
  assert.equal(bad.status, 1)
})
