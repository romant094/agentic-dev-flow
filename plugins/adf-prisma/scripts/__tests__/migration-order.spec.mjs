import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationOrderVerdict, passLine } from '../lib/migration-order.mjs'
import { runOperation } from '../lib/prisma.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'prisma.mjs')

// ---------------------------------------------------------------- verdict parity with the origin

test('a missing comparison ref fails instead of reading as "the base gained nothing"', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260101_a', '20260201_mine'], baseMigrations: [], baseRefMissing: true })
  assert.equal(v.ok, false)
  assert.equal(v.refMissing, true)
  assert.equal(v.blockedBy, null)
})

test('a present ref never sets refMissing, even when it holds no migrations', () => {
  const v = migrationOrderVerdict({ branchMigrations: [], baseMigrations: [] })
  assert.equal(v.ok, true)
  assert.notEqual(v.refMissing, true)
})

test('the pass line names the ref that was compared against', () => {
  assert.match(passLine({ ok: true, added: [] }, 'origin/develop'), /compared against origin\/develop/)
  assert.match(passLine({ ok: true, added: ['20260201_mine'] }, 'origin/develop'), /origin\/develop gained/)
})

test('a branch that adds no migration passes', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260101_a'], baseMigrations: ['20260101_a'] })
  assert.equal(v.ok, true)
  assert.deepEqual(v.added, [])
})

test('a branch whose migration is newer than everything on the base passes', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260101_a', '20260301_mine'], baseMigrations: ['20260101_a', '20260201_theirs'] })
  assert.equal(v.ok, true)
})

test('a branch whose migration predates one the base gained is blocked', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260101_a', '20260201_mine'], baseMigrations: ['20260101_a', '20260301_theirs'] })
  assert.equal(v.ok, false)
  assert.deepEqual(v.added, ['20260201_mine'])
  assert.equal(v.blockedBy, '20260301_theirs')
})

test('the base moving ahead without new migrations is not a problem', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260101_a', '20260201_mine'], baseMigrations: ['20260101_a'] })
  assert.equal(v.ok, true)
})

test('several added migrations are all reported, and the oldest decides', () => {
  const v = migrationOrderVerdict({ branchMigrations: ['20260201_mine', '20260401_mine2'], baseMigrations: ['20260301_theirs'] })
  assert.equal(v.ok, false)
  assert.deepEqual(v.added, ['20260201_mine', '20260401_mine2'])
  assert.equal(v.blockedBy, '20260301_theirs')
})

// ---------------------------------------------------------------- real repositories

const gitRun = (calls) => (cmd, args, opts = {}) => {
  calls?.push(`${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-prisma-order-'))
  git(dir, 'init', '-q', '-b', 'develop')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
function migration(dir, name, schema = 'prisma') {
  const path = join(dir, schema, 'migrations', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'migration.sql'), `-- ${name}\n`)
  writeFileSync(join(dir, schema, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', name)
}

const verify = (root, input, { config = {}, calls } = {}) => runOperation('verify-check', { root, config, input: { change: 'c', head: 'HEAD', files: [], ...input } }, { run: gitRun(calls) })
const only = (outcome) => {
  assert.equal(outcome.code, 0)
  assert.equal(outcome.result.state, 'done')
  assert.equal(outcome.result.checks.length, 1)
  const [check] = outcome.result.checks
  assert.equal(check.id, 'migration-order')
  assert.equal(check.title, 'Prisma migration order')
  return check
}

test('a repository without Prisma migrations passes with "no Prisma migrations"', () => {
  const dir = repo()
  git(dir, 'checkout', '-q', '-b', 'feat')
  const check = only(verify(dir, { base: { ref: 'develop', commit: git(dir, 'rev-parse', 'develop') } }))
  assert.equal(check.verdict, 'pass')
  assert.equal(check.summary, 'no Prisma migrations')
})

test('a base ref that does not exist fails and says it does not fetch', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  const check = only(verify(dir, { base: { ref: 'origin/develop', commit: null } }))
  assert.equal(check.verdict, 'fail')
  assert.match(check.summary, /origin\/develop does not exist/)
  assert.match(check.text, /does not fetch/)
})

test('a branch migration newer than everything the base gained passes, and the base is the input ref', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  const start = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', '-b', 'feat')
  migration(dir, '20260301_mine')
  git(dir, 'checkout', '-q', 'develop')
  migration(dir, '20260201_theirs')
  git(dir, 'checkout', '-q', 'feat')
  const check = only(verify(dir, { base: { ref: 'develop', commit: start } }))
  assert.equal(check.verdict, 'pass')
  assert.match(check.summary, /20260301_mine/)
  assert.match(check.summary, /develop gained/)
})

test('a branch migration that sorts before one the base gained fails and says to recreate it', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  git(dir, 'checkout', '-q', '-b', 'feat')
  migration(dir, '20260201_mine')
  git(dir, 'checkout', '-q', 'develop')
  migration(dir, '20260301_theirs')
  git(dir, 'checkout', '-q', 'feat')
  const before = git(dir, 'show-ref')
  const calls = []
  const check = only(verify(dir, { base: { ref: 'develop', commit: null } }, { calls }))
  assert.equal(check.verdict, 'fail')
  assert.match(check.summary, /20260201_mine sorts before 20260301_theirs/)
  assert.match(check.text, /Recreate the migration so that its timestamp is last/)
  assert.doesNotMatch(check.text, /migration_lock/)
  // Never fetches, never rewrites.
  assert.ok(calls.every((c) => /^git (rev-parse|ls-tree) /.test(c)), calls.join('\n'))
  assert.equal(git(dir, 'show-ref'), before)
  assert.equal(git(dir, 'status', '--porcelain'), '')
})

test('the base moving ahead without a migration passes', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  git(dir, 'checkout', '-q', '-b', 'feat')
  migration(dir, '20260201_mine')
  git(dir, 'checkout', '-q', 'develop')
  writeFileSync(join(dir, 'other.txt'), 'x\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'other')
  git(dir, 'checkout', '-q', 'feat')
  assert.equal(only(verify(dir, { base: { ref: 'develop' } })).verdict, 'pass')
})

test('config.schema moves the migrations directory', () => {
  const dir = repo()
  migration(dir, '20260101_a', 'db')
  git(dir, 'checkout', '-q', '-b', 'feat')
  migration(dir, '20260201_mine', 'db')
  git(dir, 'checkout', '-q', 'develop')
  migration(dir, '20260301_theirs', 'db')
  git(dir, 'checkout', '-q', 'feat')
  assert.equal(only(verify(dir, { base: { ref: 'develop' } }, { config: { schema: 'db' } })).verdict, 'fail')
  assert.equal(only(verify(dir, { base: { ref: 'develop' } })).summary, 'no Prisma migrations')
})

test('a head that does not resolve fails rather than passing as "adds nothing"', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  const check = only(verify(dir, { base: { ref: 'develop' }, head: 'no-such-head' }))
  assert.equal(check.verdict, 'fail')
})

test('verify-check without a base ref is refused', () => {
  const outcome = runOperation('verify-check', { root: '/x', config: {}, input: { change: 'c', head: 'HEAD', files: [] } }, { run: gitRun() })
  assert.equal(outcome.code, 1)
  assert.equal(outcome.result.state, 'refused')
})

test('the CLI runs verify-check from stdin and exits 0 on a failing verdict', () => {
  const dir = repo()
  migration(dir, '20260101_a')
  git(dir, 'checkout', '-q', '-b', 'feat')
  migration(dir, '20260201_mine')
  git(dir, 'checkout', '-q', 'develop')
  migration(dir, '20260301_theirs')
  git(dir, 'checkout', '-q', 'feat')
  const payload = { root: dir, config: {}, input: { change: 'c', base: { ref: 'develop', commit: null }, head: 'HEAD', files: [] } }
  const r = spawnSync(process.execPath, [cli, 'verify-check'], { cwd: dir, input: JSON.stringify(payload), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.state, 'done')
  assert.equal(result.checks[0].verdict, 'fail')
})
