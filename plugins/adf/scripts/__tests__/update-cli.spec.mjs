import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { run, UsageError } from '../update.mjs'

const ID = 'adf@agentic-dev-flow'
const URL = 'https://example.com/adf.git'
const TAGS = 'a\trefs/tags/v0.9.0\nb\trefs/tags/v0.10.0\n'

function setup({ ref, user, installedProject, userUrl = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-uc-'))
  const home = mkdtempSync(join(tmpdir(), 'adf-uch-'))
  mkdirSync(join(root, '.claude'))
  if (ref !== undefined) {
    const source = { source: 'git', url: URL, ...(ref ? { ref } : {}) }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { 'agentic-dev-flow': { source } } }))
  }
  mkdirSync(join(home, 'plugins'))
  const records = []
  if (user) {
    const path = mkdtempSync(join(tmpdir(), 'adf-ui-'))
    records.push({ scope: 'user', installPath: path, version: user })
  }
  if (installedProject) {
    const path = mkdtempSync(join(tmpdir(), 'adf-pi-'))
    records.push({ scope: 'project', projectPath: root, installPath: path, version: installedProject })
  }
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [ID]: records } }))
  if (userUrl) writeFileSync(join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'agentic-dev-flow': { source: { source: 'git', url: URL } } }))
  return { root, home }
}

const git = (out) => () => out

test('check reports behind when ref < latest', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.equal(r.scope, 'project')
  assert.equal(r.latest, 'v0.10.0')
  assert.equal(r.behind, true)
  assert.equal(r.pull, false)
  assert.deepEqual(r.inFlight, [])
})

test('check sets pull when installed < ref', () => {
  const { root, home } = setup({ ref: 'v0.10.0', installedProject: '0.9.0' })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.equal(r.pull, true)
  assert.equal(r.behind, false)
})

test('check lists the changes in flight and their worktrees', () => {
  const { root, home } = setup({ ref: 'v0.10.0', installedProject: '0.10.0' })
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })
  mkdirSync(join(root, 'openspec', 'changes', 'alpha'))
  mkdirSync(join(root, 'openspec', 'changes', 'beta'))
  mkdirSync(join(root, '.claude', 'worktrees', 'beta'), { recursive: true })
  const r = run(['check', '--root', root, '--home', home], { git: git(TAGS) })
  assert.deepEqual(r.inFlight.map((c) => c.change).sort(), ['alpha', 'beta'])
  assert.equal(r.inFlight.find((c) => c.change === 'alpha').worktree, null)
  assert.match(r.inFlight.find((c) => c.change === 'beta').worktree, /worktrees[\\/]beta$/)
})

test('user scope is checked only outside a pinned project', () => {
  const user = setup({ user: '0.9.0' })
  const u = run(['check', '--root', user.root, '--home', user.home], { git: git(TAGS) })
  assert.equal(u.scope, 'user')
  assert.equal(u.installed, '0.9.0')
  assert.equal(u.behind, true)
  assert.equal(u.pull, false)
  const pinned = setup({ ref: 'v0.10.0', user: '0.9.0', installedProject: '0.10.0' })
  const p = run(['check', '--root', pinned.root, '--home', pinned.home], { git: git(TAGS) })
  assert.equal(p.scope, 'project')
  assert.equal(p.behind, false)
  const unpinned = setup({ ref: 'develop', user: '0.9.0' })
  const n = run(['check', '--root', unpinned.root, '--home', unpinned.home], { git: git(TAGS) })
  assert.equal(n.scope, 'project')
  assert.deepEqual([n.behind, n.pull], [false, false])
  assert.equal(run(['check', '--root', setup().root, '--home', setup().home]).scope, 'none')
})

test('notice prints the system message when behind or pull', () => {
  const a = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', a.root, '--home', a.home], { git: git(TAGS) }), {
    systemMessage: 'ADF v0.10.0 is available; this project is on v0.9.0. Run /adf:update.'
  })
  const b = setup({ ref: 'v0.10.0', installedProject: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', b.root, '--home', b.home], { git: git(TAGS) }), {
    systemMessage: 'This project pins ADF v0.10.0; v0.9.0 is installed. Run /adf:update to install it.'
  })
  const c = setup({ ref: 'v0.10.0', installedProject: '0.10.0' })
  assert.equal(run(['notice', '--root', c.root, '--home', c.home], { git: git(TAGS) }), null)
})

test('notice is silent when ls-remote fails', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const now = Date.now()
  let calls = 0
  const failing = () => {
    calls++
    throw new Error('network down')
  }
  assert.equal(run(['notice', '--root', root, '--home', home], { git: failing, now }), null)
  assert.equal(calls, 1)
  const cache = JSON.parse(readFileSync(join(home, 'adf', 'update-check.json'), 'utf8'))
  assert.deepEqual(cache[URL], { checkedAt: now, latest: null })
  assert.equal(run(['notice', '--root', root, '--home', home], { git: failing, now: now + 3600_000 }), null)
  assert.equal(calls, 1)
})

test('notice for a user-scope install names the installed version', () => {
  const { root, home } = setup({ user: '0.9.0' })
  assert.deepEqual(run(['notice', '--root', root, '--home', home], { git: git(TAGS) }), {
    systemMessage: 'ADF v0.10.0 is available; v0.9.0 is installed. Run /adf:update.'
  })
})

test('notice reads the cache within a day', () => {
  const { root, home } = setup({ ref: 'v0.9.0', installedProject: '0.9.0' })
  const now = Date.now()
  let calls = 0
  const counting = () => (calls++, TAGS)
  run(['notice', '--root', root, '--home', home], { git: counting, now })
  assert.equal(calls, 1)
  const cache = JSON.parse(readFileSync(join(home, 'adf', 'update-check.json'), 'utf8'))
  assert.deepEqual(cache[URL], { checkedAt: now, latest: 'v0.10.0' })
  const again = run(['notice', '--root', root, '--home', home], { git: counting, now: now + 3600_000 })
  assert.equal(calls, 1)
  assert.match(again.systemMessage, /v0\.10\.0 is available/)
  run(['notice', '--root', root, '--home', home], { git: counting, now: now + 25 * 3600_000 })
  assert.equal(calls, 2)
})

test('notice is silent with scope none and writes no cache', () => {
  const { root, home } = setup()
  assert.equal(run(['notice', '--root', root, '--home', home], { git: git(TAGS) }), null)
  assert.equal(existsSync(join(home, 'adf', 'update-check.json')), false)
})

test('usage errors', () => {
  assert.throws(() => run(['bogus']), /usage/)
  assert.throws(() => run(['check', '--nope', 'x']), /unknown option/)
  assert.throws(() => run(['check', '--root']), /needs a value/)
})

function gitProject(settings = { enabledPlugins: { 'adf@agentic-dev-flow': true, 'x@other': true } }) {
  const { root, home } = setup({ ref: 'v0.10.0', installedProject: '0.9.0' })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ ...settings, extraKnownMarketplaces: { 'agentic-dev-flow': { source: { source: 'git', url: URL, ref: 'v0.10.0' } } } }))
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'adf-jira@agentic-dev-flow': true, 'adf-off@agentic-dev-flow': false } }))
  const sh = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' })
  sh('init', '-q')
  sh('add', '.claude/settings.json')
  sh('commit', '-q', '-m', 'init')
  // The main directory as git reports it (the temp directory's real path).
  const file = join(home, 'plugins', 'installed_plugins.json')
  const records = JSON.parse(readFileSync(file, 'utf8'))
  for (const record of records.plugins[ID]) if (record.scope === 'project') record.projectPath = realpathSync(root)
  writeFileSync(file, JSON.stringify(records))
  // What a real `claude plugin install adf@...` does to the install record: the pinned version.
  const installPinned = (args) => {
    if (args[1] !== 'install' || args[2] !== ID) return
    const file = join(home, 'plugins', 'installed_plugins.json')
    const records = JSON.parse(readFileSync(file, 'utf8'))
    for (const record of records.plugins[ID]) if (record.scope === 'project') record.version = '0.10.0'
    writeFileSync(file, JSON.stringify(records))
  }
  return { root, home, sh, installPinned }
}

function fakeClaude({ onCall, failOn } = {}) {
  const calls = []
  const fn = (args, opts) => {
    calls.push({ args, cwd: opts.cwd })
    if (failOn === calls.length) throw Object.assign(new Error('boom'), { stderr: 'no network' })
    onCall?.(args, opts)
    return ''
  }
  return { fn, calls }
}

test('pull runs the marketplace update, then one install per enabled plugin', () => {
  const { root, home, installPinned } = gitProject()
  const { fn, calls } = fakeClaude({ onCall: installPinned })
  const r = run(['pull', '--root', root, '--home', home], { claude: fn, git: git(TAGS) })
  assert.deepEqual(r.ran, [
    ['plugin', 'marketplace', 'update', 'agentic-dev-flow'],
    ['plugin', 'install', 'adf@agentic-dev-flow', '--scope', 'project'],
    ['plugin', 'install', 'adf-jira@agentic-dev-flow', '--scope', 'project']
  ])
  assert.deepEqual(calls.map((c) => c.args), r.ran)
  assert.equal(r.restored, false)
  assert.deepEqual([r.installed, r.ref], ['0.10.0', 'v0.10.0'])
})

test('pull refuses, naming both versions, when the installed release is still older than the ref', () => {
  const { root, home } = gitProject()
  try {
    run(['pull', '--root', root, '--home', home], { claude: fakeClaude().fn, git: git(TAGS) })
    assert.fail('should throw')
  } catch (error) {
    assert.match(error.message, /v0\.9\.0 installed .*older than the pinned v0\.10\.0/)
    assert.equal(error.ran.length, 3)
  }
})

test('pull restores a settings file it changed', () => {
  const { root, home, installPinned } = gitProject()
  const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
  const { fn } = fakeClaude({ onCall: (args) => (installPinned(args), args[1] === 'install' && writeFileSync(join(root, '.claude', 'settings.json'), '{}')) })
  const r = run(['pull', '--root', root, '--home', home], { claude: fn, git: git(TAGS) })
  assert.equal(r.restored, true)
  assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), before)
})

test('pull refuses when settings.json had uncommitted changes', () => {
  const { root, home } = gitProject()
  writeFileSync(join(root, '.claude', 'settings.json'), '{"dirty":true}')
  const { fn, calls } = fakeClaude()
  assert.throws(() => run(['pull', '--scope', 'project', '--root', root, '--home', home], { claude: fn, git: git(TAGS) }), /\.claude\/settings\.json has uncommitted changes; commit or revert them first/)
  assert.equal(calls.length, 0)
})

test('pull at user scope installs with --scope user and reports restored false', () => {
  const { root, home } = setup({ user: '0.9.0' })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'adf@agentic-dev-flow': true } }))
  const { fn } = fakeClaude()
  const r = run(['pull', '--root', root, '--home', home], { claude: fn, git: git(TAGS) })
  assert.deepEqual(r.ran[1], ['plugin', 'install', 'adf@agentic-dev-flow', '--scope', 'user'])
  assert.equal(r.restored, false)
  assert.equal(r.installed, '0.9.0')
})

test('pull stops on a failing claude call and names the calls made', () => {
  const { root, home } = gitProject()
  const { fn } = fakeClaude({ failOn: 2 })
  try {
    run(['pull', '--root', root, '--home', home], { claude: fn, git: git(TAGS) })
    assert.fail('should throw')
  } catch (error) {
    assert.match(error.message, /plugin install adf@agentic-dev-flow --scope project.*no network/)
    assert.equal(error.ran.length, 1)
  }
})

test('pull refuses scope none', () => {
  const { root, home } = setup({})
  assert.throws(() => run(['pull', '--root', root, '--home', home], { claude: fakeClaude().fn }), /nothing to pull/)
})

test('pull restores settings.json when a later call fails', () => {
  const { root, home } = gitProject()
  const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
  const { fn } = fakeClaude({ failOn: 3, onCall: (args) => args[1] === 'install' && writeFileSync(join(root, '.claude', 'settings.json'), '{}') })
  try {
    run(['pull', '--root', root, '--home', home], { claude: fn, git: git(TAGS) })
    assert.fail('should throw')
  } catch (error) {
    assert.equal(error.restored, true)
    assert.equal(error.ran.length, 2)
  }
  assert.equal(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), before)
})

test('pull with an invalid --scope is a usage error', () => {
  const { root, home } = setup({})
  assert.throws(() => run(['pull', '--scope', 'team', '--root', root, '--home', home]), UsageError)
})

test('the notice hook runs at session startup only', () => {
  const hooks = JSON.parse(readFileSync(new globalThis.URL('../../hooks/hooks.json', import.meta.url), 'utf8'))
  const [entry] = hooks.hooks.SessionStart
  assert.equal(entry.matcher, 'startup')
  assert.match(entry.hooks[0].command, /update\.mjs" notice$/)
})
