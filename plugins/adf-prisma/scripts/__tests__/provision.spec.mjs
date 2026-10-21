import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliVersion, databaseIdentity, envValue, matchingFiles, redact } from '../lib/provision.mjs'
import { runOperation } from '../lib/prisma.mjs'

const MAIN_URL = 'postgresql://nms:s3cret-pass@localhost:5432/nms?schema=public'
const OWN_URL = 'postgresql://nms:s3cret-pass@localhost:5432/nms_feat_x?schema=public'

// ---------------------------------------------------------------- fixture

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

// A main checkout with a generated client, and a worktree as the dependency provider leaves it:
// a real node_modules whose Prisma entries are links into the main checkout's.
function fixture({ clientVersion = '6.19.2', seed = 'tsx prisma/seed.ts', schema = true, mainEnv = MAIN_URL, worktreeEnv = MAIN_URL, scopeLink = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'adf-prisma-'))
  const main = join(base, 'main')
  const worktree = join(base, 'worktree')
  const pkg = { name: 'host', dependencies: clientVersion === null ? {} : { '@prisma/client': clientVersion }, ...(seed ? { prisma: { seed } } : {}) }
  for (const dir of [main, worktree]) {
    write(join(dir, 'package.json'), JSON.stringify(pkg))
    if (schema) write(join(dir, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n')
  }
  write(join(main, 'node_modules/.prisma/client/index.js'), 'main client\n')
  write(join(main, 'node_modules/@prisma/client/package.json'), '{"name":"@prisma/client"}\n')
  write(join(main, 'node_modules/@prisma/engines/package.json'), '{"name":"@prisma/engines"}\n')
  if (mainEnv !== null) write(join(main, '.env'), `# fixture\nDATABASE_URL="${mainEnv}"\n`)
  if (worktreeEnv !== null) write(join(worktree, '.env'), `DATABASE_URL="${worktreeEnv}"\n`)
  mkdirSync(join(worktree, 'node_modules'), { recursive: true })
  symlinkSync(join(main, 'node_modules/.prisma'), join(worktree, 'node_modules/.prisma'))
  if (scopeLink) symlinkSync(join(main, 'node_modules/@prisma'), join(worktree, 'node_modules/@prisma'))
  else {
    mkdirSync(join(worktree, 'node_modules/@prisma'))
    symlinkSync(join(main, 'node_modules/@prisma/client'), join(worktree, 'node_modules/@prisma/client'))
    symlinkSync(join(main, 'node_modules/@prisma/engines'), join(worktree, 'node_modules/@prisma/engines'))
  }
  return { main, worktree }
}

// Records every call; `generate` writes into the worktree's client the way prisma does, so a
// link left in place would carry the write into the main checkout.
const fake = (fail = {}) => {
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push({ line: `${cmd} ${args.join(' ')}`, cwd: opts.cwd, url: opts.env?.DATABASE_URL })
    const step = args.includes('generate') ? 'generate' : args.includes('migrate') ? 'migrate' : args.includes('seed') ? 'seed' : 'other'
    if (fail[step]) return { status: 1, stdout: '', stderr: fail[step] }
    if (step === 'generate') writeFileSync(join(opts.cwd, 'node_modules/.prisma/client/index.js'), 'worktree client\n')
    return { status: 0, stdout: 'ok', stderr: '' }
  }
  return { run, calls }
}

const provision = ({ main, worktree }, { files = [], config = {}, run }) =>
  runOperation('provision', { root: worktree, config, input: { worktree, main, kind: 'change', change: 'c', branch: 'feat/x', base: { ref: 'develop', commit: 'abc' }, files, needs: [] } }, { run })

const isLink = (path) => lstatSync(path).isSymbolicLink()
const mainClient = ({ main }) => readFileSync(join(main, 'node_modules/.prisma/client/index.js'), 'utf8')

// ---------------------------------------------------------------- version

test('the CLI version is the exact @prisma/client version', () => {
  assert.deepEqual(cliVersion({}, { dependencies: { '@prisma/client': '6.19.2' } }), { version: '6.19.2' })
})

test('a leading ^ or ~ is stripped', () => {
  assert.deepEqual(cliVersion({}, { dependencies: { '@prisma/client': '^6.19.2' } }), { version: '6.19.2' })
  assert.deepEqual(cliVersion({}, { devDependencies: { '@prisma/client': '~5.22.0' } }), { version: '5.22.0' })
})

test('a range that is not one version, or no @prisma/client, is an error naming config.cli', () => {
  assert.match(cliVersion({}, { dependencies: { '@prisma/client': '>=6' } }).error, /config\.cli/)
  assert.match(cliVersion({}, { dependencies: { '@prisma/client': '6.x' } }).error, /config\.cli/)
  assert.match(cliVersion({}, { dependencies: {} }).error, /config\.cli/)
  assert.match(cliVersion({}, null).error, /config\.cli/)
})

test('config.cli overrides the derived version and must itself be exact', () => {
  assert.deepEqual(cliVersion({ cli: '6.18.0' }, { dependencies: { '@prisma/client': '6.19.2' } }), { version: '6.18.0' })
  assert.match(cliVersion({ cli: '^6' }, {}).error, /config\.cli must be one exact version/)
})

test('provision refuses an inexact version before running anything', () => {
  const fx = fixture({ clientVersion: 'latest' })
  const { run, calls } = fake()
  const outcome = provision(fx, { files: ['prisma/schema.prisma'], run })
  assert.equal(outcome.code, 1)
  assert.match(outcome.result.error, /config\.cli/)
  assert.equal(calls.length, 0)
  assert.ok(isLink(join(fx.worktree, 'node_modules/.prisma')))
})

test('every command is npx with the pinned version, never a bare prisma', () => {
  const fx = fixture({ worktreeEnv: OWN_URL })
  const { run, calls } = fake()
  provision(fx, { files: ['prisma/schema.prisma'], run })
  assert.deepEqual(
    calls.map((c) => c.line),
    ['npx --yes prisma@6.19.2 generate', 'npx --yes prisma@6.19.2 migrate deploy', 'npx --yes prisma@6.19.2 db seed']
  )
  assert.ok(calls.every((c) => c.cwd === fx.worktree))
})

test('config.cli is the version run, and a configured schema is passed to generate and migrate', () => {
  const fx = fixture({ worktreeEnv: OWN_URL })
  const { run, calls } = fake()
  provision(fx, { files: ['prisma/x.prisma'], config: { cli: '6.18.0', schema: 'prisma' }, run })
  assert.deepEqual(
    calls.map((c) => c.line),
    ['npx --yes prisma@6.18.0 generate --schema prisma', 'npx --yes prisma@6.18.0 migrate deploy --schema prisma', 'npx --yes prisma@6.18.0 db seed']
  )
})

// ---------------------------------------------------------------- client

test('no schema directory: done, nothing run, a note says so', () => {
  const fx = fixture({ schema: false, clientVersion: null })
  const { run, calls } = fake()
  const outcome = provision(fx, { files: ['package.json'], run })
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.result.actions, [])
  assert.match(outcome.result.notes[0], /no prisma directory/)
  assert.equal(calls.length, 0)
})

test('ownClientWhen matching files replaces both links with copies and generates', () => {
  const fx = fixture()
  const { run, calls } = fake()
  const outcome = provision(fx, { files: ['apps/server/src/a.ts', 'prisma/schema.prisma'], run })
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result))
  assert.ok(!isLink(join(fx.worktree, 'node_modules/.prisma')))
  assert.ok(!isLink(join(fx.worktree, 'node_modules/@prisma/client')))
  assert.ok(isLink(join(fx.worktree, 'node_modules/@prisma/engines')), 'other @prisma entries stay links')
  assert.deepEqual(outcome.result.actions, [
    { op: 'copy', path: 'node_modules/.prisma' },
    { op: 'copy', path: 'node_modules/@prisma/client' },
    { op: 'generate', path: 'node_modules/.prisma' }
  ])
  assert.equal(calls[0].line, 'npx --yes prisma@6.19.2 generate')
  assert.match(outcome.result.notes.join('\n'), /its own Prisma client/)
})

test('the links are replaced, never written through: the main checkout keeps its client', () => {
  const fx = fixture()
  const { run } = fake()
  provision(fx, { files: ['package-lock.json'], run })
  assert.equal(mainClient(fx), 'main client\n')
  assert.equal(readFileSync(join(fx.worktree, 'node_modules/.prisma/client/index.js'), 'utf8'), 'worktree client\n')
  assert.ok(lstatSync(join(fx.main, 'node_modules/.prisma')).isDirectory())
})

test('a scope directory that is one link is made real, its other entries linked', () => {
  const fx = fixture({ scopeLink: true })
  const { run } = fake()
  const outcome = provision(fx, { files: ['package.json'], run })
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result))
  assert.ok(!isLink(join(fx.worktree, 'node_modules/@prisma')))
  assert.ok(!isLink(join(fx.worktree, 'node_modules/@prisma/client')))
  assert.equal(readlinkSync(join(fx.worktree, 'node_modules/@prisma/engines')), realpathSync(join(fx.main, 'node_modules/@prisma/engines')))
  assert.ok(lstatSync(join(fx.main, 'node_modules/@prisma/client')).isDirectory())
  assert.equal(mainClient(fx), 'main client\n')
})

test('files outside ownClientWhen leave the links shared and generate nothing', () => {
  const fx = fixture()
  const { run, calls } = fake()
  const outcome = provision(fx, { files: ['apps/server/src/a.ts', 'apps/server/package.json'], run })
  assert.equal(outcome.code, 0)
  assert.ok(isLink(join(fx.worktree, 'node_modules/.prisma')))
  assert.ok(isLink(join(fx.worktree, 'node_modules/@prisma/client')))
  assert.equal(calls.length, 0)
  assert.match(outcome.result.notes.join('\n'), /shared with the main checkout/)
})

test('config.ownClientWhen takes globs and replaces the default', () => {
  assert.deepEqual(matchingFiles(['apps/server/package.json', 'package.json'], ['apps/*/package.json']), ['apps/server/package.json'])
  assert.deepEqual(matchingFiles(['db/x/y.prisma', 'src/a.ts'], ['**/*.prisma']), ['db/x/y.prisma'])
  assert.deepEqual(matchingFiles(['./prisma/a.sql', 'prismatic.ts'], ['prisma/']), ['prisma/a.sql'])
  const fx = fixture()
  const { run } = fake()
  provision(fx, { files: ['prisma/schema.prisma'], config: { ownClientWhen: ['apps/'] }, run })
  assert.ok(isLink(join(fx.worktree, 'node_modules/.prisma')))
})

test('a rerun with real copies regenerates and copies nothing again', () => {
  const fx = fixture()
  const first = fake()
  provision(fx, { files: ['prisma/schema.prisma'], run: first.run })
  const second = fake()
  const outcome = provision(fx, { files: [], run: second.run })
  assert.deepEqual(outcome.result.actions, [{ op: 'generate', path: 'node_modules/.prisma' }])
  assert.equal(second.calls[0].line, 'npx --yes prisma@6.19.2 generate')
  assert.match(outcome.result.notes.join('\n'), /already had its own Prisma client/)
})

test('a worktree node_modules that is one link is refused before anything runs', () => {
  const base = mkdtempSync(join(tmpdir(), 'adf-prisma-'))
  const main = join(base, 'main')
  const worktree = join(base, 'worktree')
  write(join(main, 'node_modules/@prisma/client/package.json'), '{}')
  for (const dir of [main, worktree]) {
    write(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@prisma/client': '6.19.2' } }))
    write(join(dir, 'prisma/schema.prisma'), '')
  }
  symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'))
  const { run, calls } = fake()
  const outcome = provision({ main, worktree }, { files: ['prisma/schema.prisma'], run })
  assert.equal(outcome.code, 1)
  assert.match(outcome.result.error, /adf-npm-workspaces/)
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------- database

test('a worktree-own database is migrated, then seeded, with its own URL in the environment', () => {
  const fx = fixture({ worktreeEnv: OWN_URL })
  const { run, calls } = fake()
  const outcome = provision(fx, { files: [], run })
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result))
  assert.deepEqual(calls.map((c) => c.line), ['npx --yes prisma@6.19.2 migrate deploy', 'npx --yes prisma@6.19.2 db seed'])
  assert.ok(calls.every((c) => c.url === OWN_URL))
  assert.deepEqual(outcome.result.actions, [
    { op: 'migrate-deploy', path: 'prisma/migrations' },
    { op: 'seed', path: 'package.json' }
  ])
  assert.doesNotMatch(JSON.stringify(outcome.result), /s3cret|nms_feat_x|postgresql:/)
})

test('equal URLs: the developer database is not migrated, and a note says so', () => {
  const fx = fixture()
  const { run, calls } = fake()
  const outcome = provision(fx, { files: [], run })
  assert.equal(calls.length, 0)
  assert.match(outcome.result.notes.join('\n'), /main checkout's database.*no migration/)
  assert.doesNotMatch(JSON.stringify(outcome.result), /s3cret|postgresql:/)
})

test('the same database with another password is still the developer database', () => {
  assert.equal(databaseIdentity(MAIN_URL), databaseIdentity(MAIN_URL.replace('s3cret-pass', 'other')))
  assert.notEqual(databaseIdentity(MAIN_URL), databaseIdentity(OWN_URL))
  assert.equal(databaseIdentity('not a url'), null)
})

test('no URL in the worktree, or none in the main checkout to compare with: no migration', () => {
  for (const env of [{ worktreeEnv: null }, { worktreeEnv: OWN_URL, mainEnv: null }]) {
    const fx = fixture(env)
    const { run, calls } = fake()
    const outcome = provision(fx, { files: [], run })
    assert.equal(outcome.code, 0)
    assert.equal(calls.length, 0)
    assert.match(outcome.result.notes.join('\n'), /no migration was applied/)
  }
})

test('the seed runs only with config.seed and a prisma.seed in package.json', () => {
  for (const [options, config] of [[{ worktreeEnv: OWN_URL, seed: null }, {}], [{ worktreeEnv: OWN_URL }, { seed: false }]]) {
    const fx = fixture(options)
    const { run, calls } = fake()
    const outcome = provision(fx, { files: [], config, run })
    assert.deepEqual(calls.map((c) => c.line), ['npx --yes prisma@6.19.2 migrate deploy'])
    assert.match(outcome.result.notes.join('\n'), /not seeded/)
  }
})

test('config.env names another file and key', () => {
  const fx = fixture({ worktreeEnv: null, mainEnv: null })
  write(join(fx.main, 'apps/server/.env'), `DB_URL=${MAIN_URL}\n`)
  write(join(fx.worktree, 'apps/server/.env'), `export DB_URL='${OWN_URL}' \n`)
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push(opts.env?.DB_URL)
    return { status: 0, stdout: '', stderr: '' }
  }
  const outcome = provision(fx, { files: [], config: { env: { file: 'apps/server/.env', key: 'DB_URL' } }, run })
  assert.equal(outcome.code, 0)
  assert.deepEqual(calls, [OWN_URL, OWN_URL])
})

test('a failing command refuses with its output tail, the URL and password redacted', () => {
  const fx = fixture({ worktreeEnv: OWN_URL })
  const leak = `Error: P1001 cannot reach ${OWN_URL}\npassword s3cret-pass rejected\nat postgres://other:pw1234@db:5432/x`
  const { run, calls } = fake({ migrate: leak })
  const outcome = provision(fx, { files: [], run })
  assert.equal(outcome.code, 1)
  assert.equal(outcome.result.state, 'refused')
  assert.match(outcome.result.error, /prisma migrate deploy failed/)
  assert.match(outcome.result.error, /P1001/)
  assert.doesNotMatch(outcome.result.error, /s3cret|nms_feat_x|pw1234/)
  assert.equal(calls.length, 1, 'the seed does not run after a failed migration')
})

test('a failing generate refuses and runs no migration', () => {
  const fx = fixture({ worktreeEnv: OWN_URL })
  const { run, calls } = fake({ generate: 'boom' })
  const outcome = provision(fx, { files: ['prisma/schema.prisma'], run })
  assert.equal(outcome.code, 1)
  assert.match(outcome.result.error, /prisma generate failed[\s\S]*boom/)
  assert.equal(calls.length, 1)
})

test('envValue and redact handle quotes, comments and encoded passwords', () => {
  const base = mkdtempSync(join(tmpdir(), 'adf-prisma-env-'))
  write(join(base, 'e'), '# DATABASE_URL=commented\nOTHER=1\nDATABASE_URL=plain # trailing\n')
  assert.equal(envValue(join(base, 'e'), 'DATABASE_URL'), 'plain')
  assert.equal(envValue(join(base, 'missing'), 'DATABASE_URL'), null)
  const url = 'postgresql://u:p%40ss123@h:5432/d'
  assert.equal(redact(`x ${url} p@ss123 p%40ss123`, [url]), 'x <redacted> <redacted> <redacted>')
})

test('provision input without worktree, main or files is refused', () => {
  const outcome = runOperation('provision', { root: '/x', config: {}, input: { main: '/m', files: [] } }, { run: () => assert.fail('no call') })
  assert.equal(outcome.code, 1)
  assert.match(outcome.result.error, /input\.worktree/)
  const bad = runOperation('provision', { root: '/x', config: { seed: 'yes' }, input: {} }, { run: () => assert.fail('no call') })
  assert.match(bad.result.error, /config\.seed/)
  assert.match(runOperation('teardown', { root: '/x' }, {}).result.error, /unknown operation/)
})
