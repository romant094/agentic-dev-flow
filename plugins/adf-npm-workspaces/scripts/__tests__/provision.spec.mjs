import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_RULE, expandWorkspaces } from '../lib/provision.mjs'

// Every case runs the real CLI as the core does: the payload on stdin, the host root as cwd,
// against a fixture monorepo and a real git worktree of it in the system temp directory.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'provision.mjs')
const WORKTREES = '.claude/worktrees'

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function link(root, path, target) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  symlinkSync(target, join(root, path))
}

// A monorepo with two workspaces, installed as npm would: third-party packages as real
// directories, the workspace self-links as relative links, `.bin` as relative links.
function fixture(t, { workspaces = ['packages/*', 'apps/*'] } = {}) {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'npm-workspaces-')))
  t.after(() => rmSync(main, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: main, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  write(main, 'package.json', JSON.stringify({ name: 'mono', private: true, workspaces }))
  write(main, '.gitignore', 'node_modules\n.claude/worktrees\n')
  write(main, 'packages/shared/package.json', JSON.stringify({ name: '@s/shared', bin: { 'shared-cli': 'cli.js' } }))
  write(main, 'packages/shared/cli.js', 'main shared cli\n')
  write(main, 'apps/web/package.json', JSON.stringify({ name: '@s/web' }))
  git('add', '.')
  git('commit', '-q', '-m', 'base')

  write(main, 'node_modules/left-pad/package.json', '{"name":"left-pad"}')
  write(main, 'node_modules/left-pad/bin.js', 'left-pad bin\n')
  write(main, 'node_modules/@types/node/index.d.ts', 'export {}\n')
  write(main, 'node_modules/.package-lock.json', '{}')
  write(main, 'node_modules/.vite/deps.json', '{}')
  link(main, 'node_modules/.bin/left-pad', '../left-pad/bin.js')
  link(main, 'node_modules/.bin/shared-cli', '../@s/shared/cli.js')
  link(main, 'node_modules/@s/shared', '../../packages/shared')
  link(main, 'node_modules/@s/web', '../../apps/web')
  write(main, 'apps/web/node_modules/vite/index.js', 'vite\n')
  write(main, 'apps/web/node_modules/.vite/deps/x.js', 'cache\n')
  write(main, 'apps/web/node_modules/.vite-temp/y.js', 'cache\n')
  // Dangling in the main checkout until the shared package is built there.
  link(main, 'apps/web/node_modules/@s/shared', '../../../../packages/shared/dist/esm')

  const worktree = join(main, WORKTREES, 'feature')
  git('worktree', 'add', '-q', '-b', 'feature', worktree)
  return { main, worktree, git }
}

function provision(f, config = {}, input = {}) {
  const payload = {
    root: f.worktree,
    config,
    input: {
      worktree: f.worktree,
      main: f.main,
      kind: 'change',
      change: 'x',
      branch: 'feature',
      base: { ref: 'main', commit: 'abc' },
      files: [],
      needs: [],
      ...input
    }
  }
  const r = spawnSync('node', [CLI, 'provision'], { cwd: f.worktree, input: JSON.stringify(payload), encoding: 'utf8' })
  return { code: r.status, result: JSON.parse(r.stdout), stderr: r.stderr }
}

// Every path under the main checkout but the worktrees, with its link text or content hash.
function listing(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (relPath === WORKTREES) continue
      const st = lstatSync(path)
      if (st.isSymbolicLink()) out.push(`${relPath} -> ${readlinkSync(path)}`)
      else if (st.isDirectory()) {
        out.push(`${relPath}/`)
        walk(path, relPath)
      } else out.push(`${relPath} ${createHash('sha256').update(readFileSync(path)).digest('hex')} ${st.mtimeMs}`)
    }
  }
  walk(root, '')
  return out
}

const real = (path) => realpathSync(path)

test('the worktree gets a real node_modules: self-links resolve inside it, third-party into the main checkout', (t) => {
  const f = fixture(t)
  const out = provision(f)
  assert.equal(out.code, 0, JSON.stringify(out.result))
  assert.equal(out.result.state, 'done')
  const wt = (p) => join(f.worktree, p)

  assert.ok(lstatSync(wt('node_modules')).isDirectory())
  assert.ok(lstatSync(wt('node_modules/@s')).isDirectory())
  assert.equal(readlinkSync(wt('node_modules/@s/shared')), '../../packages/shared')
  assert.equal(real(wt('node_modules/@s/shared')), real(wt('packages/shared')))
  assert.equal(real(wt('node_modules/@s/web')), real(wt('apps/web')))

  assert.equal(readlinkSync(wt('node_modules/left-pad')), join(f.main, 'node_modules/left-pad'))
  assert.equal(readlinkSync(wt('node_modules/@types')), join(f.main, 'node_modules/@types'))
  assert.equal(readlinkSync(wt('node_modules/.package-lock.json')), join(f.main, 'node_modules/.package-lock.json'))

  assert.ok(lstatSync(wt('node_modules/.bin')).isDirectory())
  assert.equal(real(wt('node_modules/.bin/left-pad')), real(join(f.main, 'node_modules/left-pad/bin.js')))
  assert.equal(real(wt('node_modules/.bin/shared-cli')), real(wt('packages/shared/cli.js')))

  assert.equal(existsSync(wt('node_modules/.vite')), false)
  assert.equal(existsSync(wt('apps/web/node_modules/.vite')), false)
  assert.equal(existsSync(wt('apps/web/node_modules/.vite-temp')), false)
  assert.equal(readlinkSync(wt('apps/web/node_modules/vite')), join(f.main, 'apps/web/node_modules/vite'))
  assert.equal(readlinkSync(wt('apps/web/node_modules/@s/shared')), '../../../../packages/shared/dist/esm')
  write(f.worktree, 'packages/shared/dist/esm/index.js', 'worktree build\n')
  assert.equal(readFileSync(wt('apps/web/node_modules/@s/shared/index.js'), 'utf8'), 'worktree build\n')

  assert.ok(out.result.actions.some((a) => a.op === 'link' && a.path === 'node_modules/@s/shared'))
  assert.equal(out.result.notes.at(-1), INSTALL_RULE)
})

test('the main checkout is not written, and a second run does nothing', (t) => {
  const f = fixture(t)
  const before = listing(f.main)
  assert.equal(provision(f).code, 0)
  assert.deepEqual(listing(f.main), before)
  const again = provision(f)
  assert.equal(again.code, 0)
  assert.deepEqual(again.result.actions, [])
  assert.match(again.result.notes[0], /nothing changed/)
  assert.ok(again.result.notes.includes(INSTALL_RULE))
  assert.deepEqual(listing(f.main), before)
})

test('the git status of both trees is unchanged', (t) => {
  const f = fixture(t)
  const status = (cwd) => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
  const before = [status(f.main), status(f.worktree)]
  assert.equal(provision(f).code, 0)
  assert.deepEqual([status(f.main), status(f.worktree)], before)
})

test('a node_modules link left by the retired scheme is replaced, not written through', (t) => {
  const f = fixture(t)
  symlinkSync(join(f.main, 'node_modules'), join(f.worktree, 'node_modules'))
  link(f.worktree, 'apps/web/node_modules', join(f.main, 'apps/web/node_modules'))
  const before = listing(f.main)
  const out = provision(f)
  assert.equal(out.code, 0, JSON.stringify(out.result))
  assert.deepEqual(listing(f.main), before)
  assert.ok(lstatSync(join(f.worktree, 'node_modules')).isDirectory())
  assert.ok(lstatSync(join(f.worktree, 'apps/web/node_modules')).isDirectory())
  assert.ok(out.result.actions.some((a) => a.op === 'unlink' && a.path === 'node_modules'))
  assert.equal(real(join(f.worktree, 'node_modules/@s/shared')), real(join(f.worktree, 'packages/shared')))
})

test('a scope link, a stale entry link and a shared cache link in the worktree are replaced', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.worktree, 'node_modules'))
  symlinkSync(join(f.main, 'node_modules/@s'), join(f.worktree, 'node_modules/@s'))
  symlinkSync('/nowhere', join(f.worktree, 'node_modules/left-pad'))
  symlinkSync(join(f.main, 'node_modules/.vite'), join(f.worktree, 'node_modules/.vite'))
  const before = listing(f.main)
  const out = provision(f)
  assert.equal(out.code, 0, JSON.stringify(out.result))
  assert.deepEqual(listing(f.main), before)
  assert.ok(lstatSync(join(f.worktree, 'node_modules/@s')).isDirectory())
  assert.equal(readlinkSync(join(f.worktree, 'node_modules/left-pad')), join(f.main, 'node_modules/left-pad'))
  assert.equal(existsSync(join(f.worktree, 'node_modules/.vite')), false)
  assert.ok(out.result.actions.some((a) => a.op === 'relink' && a.path === 'node_modules/left-pad'))
})

test("the worktree's own cache is kept", (t) => {
  const f = fixture(t)
  write(f.worktree, 'apps/web/node_modules/.vite/own.js', 'own\n')
  assert.equal(provision(f).code, 0)
  assert.equal(readFileSync(join(f.worktree, 'apps/web/node_modules/.vite/own.js'), 'utf8'), 'own\n')
})

test('config.unshared extends the default list', (t) => {
  const f = fixture(t)
  write(f.main, 'node_modules/.cache/x', 'cache\n')
  assert.equal(provision(f, { unshared: ['.cache'] }).code, 0)
  assert.equal(existsSync(join(f.worktree, 'node_modules/.cache')), false)
  assert.equal(existsSync(join(f.worktree, 'node_modules/.vite')), false)
})

test('config.build runs in the worktree, after the links exist', (t) => {
  const f = fixture(t)
  const out = provision(f, { build: ['pwd > built.txt', 'test -L node_modules/@s/shared && echo ok >> built.txt'] })
  assert.equal(out.code, 0, JSON.stringify(out.result))
  assert.equal(readFileSync(join(f.worktree, 'built.txt'), 'utf8'), `${f.worktree}\nok\n`)
  assert.equal(existsSync(join(f.main, 'built.txt')), false)
  assert.ok(out.result.notes.some((n) => n.includes('pwd > built.txt')))
})

test('a failing build command refuses with its output tail and runs nothing after it', (t) => {
  const f = fixture(t)
  const out = provision(f, { build: ['echo first line; echo boom >&2; exit 3', 'touch after.txt'] })
  assert.equal(out.code, 1)
  assert.equal(out.result.state, 'refused')
  assert.match(out.result.error, /exit 3/)
  assert.match(out.result.error, /boom/)
  assert.equal(existsSync(join(f.worktree, 'after.txt')), false)
  assert.ok(lstatSync(join(f.worktree, 'node_modules')).isDirectory())
})

test('the main checkout as the worktree is refused', (t) => {
  const f = fixture(t)
  const before = listing(f.main)
  const out = provision({ ...f, worktree: f.main })
  assert.equal(out.code, 1)
  assert.match(out.result.error, /is the main checkout/)
  assert.deepEqual(listing(f.main), before)
})

test('without workspaces, or without node_modules, nothing is provisioned and the reason is said', (t) => {
  const f = fixture(t, { workspaces: null })
  const out = provision(f, { build: ['touch built.txt'] })
  assert.equal(out.code, 0)
  assert.deepEqual(out.result.actions, [])
  assert.match(out.result.notes[0], /has no workspaces/)
  assert.ok(out.result.notes.includes(INSTALL_RULE))
  assert.equal(existsSync(join(f.worktree, 'node_modules')), false)
  assert.equal(existsSync(join(f.worktree, 'built.txt')), false)

  const g = fixture(t)
  rmSync(join(g.main, 'node_modules'), { recursive: true })
  const none = provision(g)
  assert.equal(none.code, 0)
  assert.match(none.result.notes[0], /node_modules does not exist/)
})

test('a tracked link on the way to a workspace node_modules is refused, never written through', (t) => {
  const f = fixture(t)
  rmSync(join(f.worktree, 'apps/web'), { recursive: true })
  symlinkSync(join(f.main, 'apps/web'), join(f.worktree, 'apps/web'))
  const before = listing(f.main)
  const out = provision(f)
  assert.equal(out.code, 1)
  assert.match(out.result.error, /apps\/web in the worktree is not a real directory/)
  assert.deepEqual(listing(f.main), before)
})

test('bad input and config are refused before anything is written', (t) => {
  const f = fixture(t)
  assert.match(provision(f, { builds: [] }).result.error, /unknown config field\(s\): builds/)
  assert.match(provision(f, { build: 'npm run build' }).result.error, /config.build is not a list/)
  assert.match(provision(f, {}, { kind: 'other' }).result.error, /input.kind/)
  assert.match(provision(f, {}, { worktree: 'relative' }).result.error, /input.worktree/)
  assert.equal(existsSync(join(f.worktree, 'node_modules')), false)
  const r = spawnSync('node', [CLI, 'teardown'], { input: '{}', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(JSON.parse(r.stdout).error, /unknown operation/)
  const bad = spawnSync('node', [CLI, 'provision'], { input: 'not json', encoding: 'utf8' })
  assert.equal(bad.status, 1)
})

test('workspace patterns expand literal and starred segments; unsupported ones are noted', (t) => {
  const f = fixture(t)
  write(f.main, 'tools/x/package.json', '{}')
  const notes = []
  assert.deepEqual(expandWorkspaces(f.main, ['apps/*', 'packages/shared', 'tools/x', '!apps/y', 'libs/**', 'missing/*'], notes), [
    'apps/web',
    'packages/shared',
    'tools/x'
  ])
  assert.equal(notes.length, 2)
})
