// The core's hook callers against the three real stack plugins of this repository, named by an
// absolute registry path in the order the plugins' READMEs ask for: adf-npm-workspaces,
// adf-postgres, adf-prisma. The host is an npm-workspaces monorepo with no Prisma schema and a
// plan with no needs, so adf-prisma never runs npx and adf-postgres never creates a database;
// its teardown points at a closed port, so it is done with a note whether psql is installed or not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addBaseCheck, removeBaseCheck } from '../lib/groups.mjs'
import { provisionWorktree, teardownWorktree } from '../lib/provision.mjs'
import { readRegistry, writeRegistry } from '../lib/registry.mjs'
import { CORE } from '../lib/roles.mjs'
import { claudeHome } from '../lib/superpowers.mjs'
import { extensionChecks, resolveBase } from '../lib/verify.mjs'
import { git, host } from './git-host.mjs'

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const PLAN = ['# Plan', '', '### Task 1: one', '', '> Implements tasks.md 1.1.', '', '**Files:**', '- Modify: `packages/shared/index.js`', ''].join('\n')

const GUIDE = ['# Planning Guide', '', '## Worktree copies', '', '- `.env`', ''].join('\n')

const INSTALL_RULE = "Never run npm install, ci, add, update or uninstall in a worktree: its node_modules links into the main checkout's, so the command rewrites the main checkout's dependencies. A dependency update is its own change."

const ORDER = ['adf-npm-workspaces', 'adf-postgres', 'adf-prisma']

// The main checkout's node_modules as `path type [link text]` lines, recursed into real
// directories only.
function listing(dir, prefix = '') {
  const lines = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const st = lstatSync(path)
    const rel = `${prefix}${name}`
    if (st.isSymbolicLink()) lines.push(`${rel} link ${readlinkSync(path)}`)
    else if (st.isDirectory()) lines.push(`${rel} dir`, ...listing(path, `${rel}/`))
    else lines.push(`${rel} file`)
  }
  return lines
}

// A host monorepo: the workspaces package.json and packages/shared committed on develop and
// merged into add-x; the main checkout's node_modules with a third-party package, .bin, .vite
// and the scoped self-link; `.env` and node_modules ignored in every worktree; the three
// plugins in the change worktree's registry, committed so the tree stays clean.
function setup() {
  const { root, change } = host({ 'plan.md': PLAN })
  appendFileSync(join(root, '.git', 'info', 'exclude'), '.env\nnode_modules\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'], dependencies: { '@prisma/client': '6.1.0' } }, null, 2) + '\n')
  mkdirSync(join(root, 'packages', 'shared'), { recursive: true })
  writeFileSync(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@s/shared', version: '1.0.0' }) + '\n')
  git(root, 'add', 'package.json', 'packages/shared/package.json')
  git(root, 'commit', '-q', '-m', 'monorepo')
  git(change, 'merge', '-q', '--no-edit', 'develop')

  const nm = join(root, 'node_modules')
  mkdirSync(join(nm, 'left-pad'), { recursive: true })
  writeFileSync(join(nm, 'left-pad', 'package.json'), '{"name":"left-pad"}\n')
  writeFileSync(join(nm, 'left-pad', 'cli.js'), '\n')
  mkdirSync(join(nm, '.bin'))
  symlinkSync('../left-pad/cli.js', join(nm, '.bin', 'left-pad'))
  mkdirSync(join(nm, '.vite'))
  writeFileSync(join(nm, '.vite', 'cache.json'), '{}\n')
  mkdirSync(join(nm, '@s'))
  symlinkSync('../../packages/shared', join(nm, '@s', 'shared'))
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://u:secret@127.0.0.1:1/app\n')

  mkdirSync(join(change, 'openspec'), { recursive: true })
  writeFileSync(join(change, 'openspec', 'planning.md'), GUIDE)
  const config = { 'adf-npm-workspaces': {}, 'adf-postgres': { prefix: 't', url: { file: '.env', key: 'DATABASE_URL' }, exec: 'local' }, 'adf-prisma': {} }
  const points = { 'adf-npm-workspaces': ['provision'], 'adf-postgres': ['provision', 'teardown'], 'adf-prisma': ['provision', 'verify-check'] }
  const extensions = ORDER.map((name) => ({ path: join(PLUGINS, name), points: points[name], config: config[name] }))
  writeRegistry(change, { ...readRegistry(change), extensions })
  git(change, 'add', 'openspec/planning.md', '.claude/adf-extensions.json')
  git(change, 'commit', '-q', '-m', 'guide and stack plugins')
  return { root, change }
}

const byPlugin = (out) => Object.fromEntries(out.hook.results.map((r) => [r.plugin, r]))

test('the change worktree is provisioned by all three plugins in registry order; the main checkout is only read', () => {
  const { root, change } = setup()
  const porcelain = git(root, 'status', '--porcelain')
  const before = listing(join(root, 'node_modules'))
  const out = provisionWorktree(change, { worktree: change, kind: 'change', change: 'add-x' })
  assert.equal(out.ok, true, out.error)
  assert.equal(out.state, 'done', out.report)
  assert.deepEqual(out.hook.results.map((r) => [r.plugin, r.state]), ORDER.map((name) => [name, 'done']))

  assert.equal(realpathSync(join(change, 'node_modules', '@s', 'shared')), join(change, 'packages', 'shared'))
  assert.equal(lstatSync(join(change, 'node_modules', '@s')).isSymbolicLink(), false, 'the scope is a real directory')
  assert.equal(realpathSync(join(change, 'node_modules', 'left-pad')), join(root, 'node_modules', 'left-pad'))
  assert.equal(realpathSync(join(change, 'node_modules', '.bin', 'left-pad')), join(root, 'node_modules', 'left-pad', 'cli.js'))
  assert.equal(existsSync(join(change, 'node_modules', '.vite')), false)
  assert.equal(lstatSync(join(change, '.env')).isFile(), true)
  assert.equal(readFileSync(join(change, '.env'), 'utf8'), 'DATABASE_URL=postgres://u:secret@127.0.0.1:1/app\n')
  assert.deepEqual(out.copies.copied, ['.env'])

  assert.equal(git(root, 'status', '--porcelain'), porcelain)
  assert.deepEqual(listing(join(root, 'node_modules')), before)
  assert.equal(git(change, 'status', '--porcelain'), '')

  const plugins = byPlugin(out)
  assert.equal(plugins['adf-npm-workspaces'].notes.at(-1), INSTALL_RULE)
  assert.deepEqual(plugins['adf-postgres'].notes, ['needs does not name database, so no database was made.'])
  assert.deepEqual(plugins['adf-postgres'].actions, [])
  assert.deepEqual(plugins['adf-prisma'].notes, ['no prisma directory in the worktree: nothing for Prisma to provision'])
  assert.deepEqual(plugins['adf-prisma'].actions, [])
  assert.match(out.report, /adf-postgres: done\n {2}needs does not name database/)
  assert.match(out.report, /adf-prisma: done\n {2}no prisma directory in the worktree/)

  const again = provisionWorktree(change, { worktree: change, kind: 'change', change: 'add-x' })
  assert.equal(again.ok, true, again.error)
  assert.deepEqual(byPlugin(again)['adf-npm-workspaces'].actions, [], 'a second run makes no new actions')
  assert.equal(byPlugin(again)['adf-npm-workspaces'].notes[0], 'node_modules was provisioned already; nothing changed.')
  assert.deepEqual(listing(join(root, 'node_modules')), before)
})

test('a base-check worktree is provisioned the same way, its self-link inside its own tree', () => {
  const { root, change } = setup()
  const base = addBaseCheck(change, { change: 'add-x' })
  assert.equal(base.provision.ok, true, base.provision.error)
  assert.equal(base.provision.state, 'done')
  const states = base.provision.report.split('\n').filter((l) => /^adf-[a-z-]+: /.test(l))
  assert.deepEqual(states, ORDER.map((name) => `${name}: done`), 'all three plugins, in registry order')
  assert.match(base.provision.report, /adf-postgres: done\n {2}a base-check worktree gets no database\./)
  const tree = realpathSync(base.root)
  assert.equal(realpathSync(join(tree, 'node_modules', '@s', 'shared')), join(tree, 'packages', 'shared'))
  assert.equal(realpathSync(join(tree, 'node_modules', 'left-pad')), join(root, 'node_modules', 'left-pad'))
  assert.equal(existsSync(join(tree, 'node_modules', '.vite')), false)
  assert.equal(readFileSync(join(tree, '.env'), 'utf8'), 'DATABASE_URL=postgres://u:secret@127.0.0.1:1/app\n')
  removeBaseCheck(change, { change: 'add-x' })
  assert.equal(existsSync(tree), false)
})

test('teardown of the change worktree is done: adf-postgres cannot reach a server and drops nothing', () => {
  const { change } = setup()
  provisionWorktree(change, { worktree: change, kind: 'change', change: 'add-x' })
  const out = teardownWorktree(change, { worktree: change, kind: 'change', change: 'add-x', branch: 'feat/add-x' })
  assert.equal(out.ok, true, out.error)
  assert.equal(out.state, 'done', out.report)
  assert.deepEqual(out.hook.results.map((r) => r.plugin), ['adf-postgres'], 'only adf-postgres provides teardown')
  const [pg] = out.hook.results
  assert.deepEqual(pg.actions, [])
  assert.equal(pg.notes.length, 1)
  assert.match(pg.notes[0], /^cannot reach psql, so t_feat_add_x_[0-9a-f]{8} was not dropped\.$/)
  assert.doesNotMatch(out.report, /secret/)
})

test('verify-check through the core gives adf-prisma\'s migration-order section: pass, no Prisma migrations', () => {
  const { change } = setup()
  const run = (...args) => git(change, ...args)
  const checks = extensionChecks(change, 'add-x', run, resolveBase(change, 'add-x', run), { ...CORE, home: claudeHome() })
  assert.deepEqual(checks.map((c) => [c.id, c.verdict, c.summary]), [['ext:adf-prisma:migration-order', 'pass', 'no Prisma migrations']])
})
