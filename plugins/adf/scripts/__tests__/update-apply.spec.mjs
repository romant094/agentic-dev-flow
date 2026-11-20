// /adf:update end to end on a fixture marketplace repository with two tags: `plan` clones the
// two releases and lists what changed, `apply` writes the update on its own branch, `commit`
// finishes an update whose merge left conflicts.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run as runCli } from '../update.mjs'

// plan leaves its clones for apply; the tests remove them at the end.
const made = []
function run(argv, opts) {
  const result = runCli(argv, opts)
  if (argv[0] === 'plan' && result?.clones) made.push(dirname(result.clones.repo))
  return result
}
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const marketplace = (version, plugins) => JSON.stringify({ name: 'agentic-dev-flow', metadata: { version }, plugins: Object.entries(plugins).map(([name, v]) => ({ name, version: v, source: `./plugins/${name}` })) })
const REVIEW_V1 = 'R1\nR2\nR3\nR4\nR5\n'
const REVIEW_V2 = 'R1 new\nR2\nR3\nR4\nR5\n'
const PLANNING_V1 = '# Planning\n\nintro A\n\n## Whole-suite command\n\nTODO\n'
const PLANNING_V2 = '# Planning\n\nintro B\n\n## Whole-suite command\n\nTODO\n'
const PLANNING_FILLED = PLANNING_V1.replace('TODO', 'npm test')

// v0.1.0: adf, adf-demo and adf-gone at 0.1.0. v0.2.0: adf-demo 0.2.0 with a migration and a
// new host file, adf-gone dropped, both core templates changed.
function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'adf-ua-repo-'))
  git(repo, 'init', '-q', '-b', 'main')
  put(repo, '.claude-plugin/marketplace.json', marketplace('0.1.0', { adf: '0.1.0', 'adf-demo': '0.1.0', 'adf-gone': '0.1.0' }))
  put(repo, 'plugins/adf/contract/contract.json', JSON.stringify({ version: '1.9', points: {} }))
  put(repo, 'plugins/adf/host/planning.md', PLANNING_V1)
  put(repo, 'plugins/adf/host/review-prompt.md', REVIEW_V1)
  put(repo, 'plugins/adf-demo/adf-extension.json', JSON.stringify({ name: 'adf-demo', contract: '1.9', provides: {}, hostFiles: [{ from: 'host/review.md', to: '.demo/review.md' }] }))
  put(repo, 'plugins/adf-demo/host/review.md', REVIEW_V1)
  put(repo, 'plugins/adf-gone/adf-extension.json', JSON.stringify({ name: 'adf-gone', contract: '1.9', provides: {} }))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat: first release')
  git(repo, 'tag', 'v0.1.0')
  put(repo, 'plugins/adf-demo/m/0.2.0.mjs', 'export default (c) => ({ renamed: c.old })\n')
  put(repo, 'plugins/adf-demo/host/mr.md', 'template\n')
  put(repo, 'plugins/adf-demo/host/review.md', REVIEW_V2)
  put(repo, 'plugins/adf-demo/adf-extension.json', JSON.stringify({ name: 'adf-demo', contract: '1.9', provides: {}, migrations: [{ version: '0.2.0', script: 'm/0.2.0.mjs' }], hostFiles: [{ from: 'host/review.md', to: '.demo/review.md' }, { from: 'host/mr.md', to: '.demo/mr.md' }] }))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'feat(adf-demo): rename the old key')
  put(repo, 'plugins/adf-demo/notes.txt', 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'wip on demo')
  put(repo, 'plugins/adf/host/planning.md', PLANNING_V2)
  put(repo, 'plugins/adf/host/review-prompt.md', REVIEW_V2)
  put(repo, '.claude-plugin/marketplace.json', marketplace('0.2.0', { adf: '0.2.0', 'adf-demo': '0.2.0' }))
  git(repo, 'rm', '-q', '-r', 'plugins/adf-gone')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fix(adf): new host templates')
  git(repo, 'tag', 'v0.2.0')
  return repo
}

// A host project pinning v0.1.0, its settings indented with four spaces. `review` is its copy
// of the review prompt.
function hostProject(url, { review = REVIEW_V1, legacy = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adf-ua-host-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 't')
  git(root, 'config', 'user.email', 't@t')
  put(root, '.gitignore', '.claude/worktrees/\n.adf/*\n')
  put(root, '.claude/settings.json', `${JSON.stringify({ enabledPlugins: { 'adf@agentic-dev-flow': true }, extraKnownMarketplaces: { 'agentic-dev-flow': { source: { source: 'git', url, ref: 'v0.1.0' } } } }, null, 4)}\n`)
  put(root, '.claude/adf-extensions.json', `${JSON.stringify({
    contract: '1.9',
    branches: { integration: 'main' },
    extensions: [
      { plugin: 'adf-demo@agentic-dev-flow', version: '0.1.0', config: { old: 'v' } },
      { plugin: 'adf-gone@agentic-dev-flow', version: '0.1.0' },
      { path: 'local/plugin' }
    ],
    ...(legacy ? { review: { prompt: 'openspec/review-prompt.md' } } : {})
  }, null, 2)}\n`)
  if (legacy) for (const [path, text] of Object.entries(legacy)) put(root, path, text)
  else {
    // The template with its managed section filled in: a value, not an edit.
    put(root, 'adf/planning.md', PLANNING_FILLED)
    put(root, 'adf/review-prompt.md', 'the project\'s own review prompt\n')
  }
  put(root, '.demo/review.md', review)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'chore: init')
  return root
}

const repo = fixtureRepo()

function planned(options) {
  const root = hostProject(repo, options)
  return { root, plan: run(['plan', '--root', root]) }
}

const apply = (root, plan, choices = {}) =>
  run(['apply', '--root', root, '--to', plan.to, '--clones', JSON.stringify(plan.clones), '--base', plan.baseCommit, '--choices', JSON.stringify(choices)])

test('plan lists the changed plugins and their log', () => {
  const { plan } = planned({ review: 'R1\nR2\nR3\nR4\nR5 mine\n' })
  assert.equal(plan.from, 'v0.1.0')
  assert.equal(plan.to, 'v0.2.0')
  assert.equal(plan.upToDate, false)
  assert.equal(plan.base, 'main')
  assert.deepEqual(plan.plugins, [
    { id: 'adf-demo@agentic-dev-flow', from: '0.1.0', to: '0.2.0', changed: true },
    { id: 'adf-gone@agentic-dev-flow', from: '0.1.0', to: null, changed: true }
  ])
  assert.deepEqual(plan.log, { adf: ['fix(adf): new host templates'], 'adf-demo': ['feat(adf-demo): rename the old key'] })
  // The core's templates changed, and no core file is listed: the planning guide and the review
  // prompt are project files (#23, #26).
  assert.deepEqual(plan.hostFiles, [
    { path: '.demo/review.md', class: 'edited' },
    { path: '.demo/mr.md', class: 'new' }
  ])
  assert.deepEqual(plan.contract, { from: '1.9', to: '1.9', compatible: true })
  assert.deepEqual(plan.inFlight, [])
  assert.equal(readFileSync(join(plan.clones.old, 'plugins/adf/host/planning.md'), 'utf8'), PLANNING_V1)
  assert.equal(readFileSync(join(plan.clones.new, 'plugins/adf/host/planning.md'), 'utf8'), PLANNING_V2)
  assert.ok(existsSync(join(plan.clones.repo, '.git')))
})

test('plan on the latest tag reports upToDate and clones nothing', () => {
  const root = hostProject(repo)
  const settings = join(root, '.claude', 'settings.json')
  writeFileSync(settings, readFileSync(settings, 'utf8').replace('v0.1.0', 'v0.2.0'))
  git(root, 'commit', '-q', '-am', 'chore: pin v0.2.0')
  assert.deepEqual(run(['plan', '--root', root]), { from: 'v0.2.0', to: 'v0.2.0', base: 'main', baseCommit: git(root, 'rev-parse', 'HEAD').trim(), upToDate: true })
})

test('apply writes the ref, the migrated config and the versions, and commits on its own branch', async () => {
  const { root, plan } = planned({ review: 'R1\nR2\nR3\nR4\nR5 mine\n' })
  const out = await apply(root, plan, { '.demo/review.md': 'keep' })
  assert.equal(out.branch, 'chore/adf-update-0.2.0')
  assert.equal(out.worktree, join(realpathSync(root), '.claude', 'worktrees', 'adf-update-0.2.0'))
  assert.equal(out.committed, true)
  assert.deepEqual(out.dropped, ['adf-gone@agentic-dev-flow'])
  assert.deepEqual(out.ran, { 'adf-demo@agentic-dev-flow': ['0.2.0'] })
  assert.deepEqual([out.manual, out.conflicts], [[], []])
  assert.deepEqual(out.written.sort(), ['.claude/adf-extensions.json', '.claude/settings.json', '.demo/mr.md', '.demo/review.md'])
  const wt = out.worktree
  const settings = readFileSync(join(wt, '.claude/settings.json'), 'utf8')
  assert.match(settings, /\n {4}"enabledPlugins"/)
  assert.equal(JSON.parse(settings).extraKnownMarketplaces['agentic-dev-flow'].source.ref, 'v0.2.0')
  const registry = JSON.parse(readFileSync(join(wt, '.claude/adf-extensions.json'), 'utf8'))
  assert.deepEqual(registry.extensions[0], { plugin: 'adf-demo@agentic-dev-flow', version: '0.2.0', config: { renamed: 'v' } })
  assert.deepEqual(registry.extensions[1], { plugin: 'adf-gone@agentic-dev-flow', version: '0.1.0' })
  assert.deepEqual(registry.extensions[2], { path: 'local/plugin' })
  assert.equal(registry.contract, '1.9')
  assert.equal(readFileSync(join(wt, 'adf/planning.md'), 'utf8'), PLANNING_FILLED)
  assert.equal(readFileSync(join(wt, 'adf/review-prompt.md'), 'utf8'), 'the project\'s own review prompt\n')
  assert.equal(readFileSync(join(wt, '.demo/review.md'), 'utf8'), 'R1 new\nR2\nR3\nR4\nR5 mine\n')
  assert.equal(readFileSync(join(wt, '.demo/mr.md'), 'utf8'), 'template\n')
  assert.equal(git(wt, 'log', '-1', '--format=%s').trim(), 'chore(adf): update to v0.2.0')
  assert.equal(git(wt, 'status', '--porcelain').trim(), '')
  assert.equal(git(root, 'branch', '--show-current').trim(), 'main')
  assert.equal(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).extraKnownMarketplaces['agentic-dev-flow'].source.ref, 'v0.1.0')
})

test('apply refuses a dirty main directory and an existing branch', async () => {
  const { root, plan } = planned()
  writeFileSync(join(root, 'adf/planning.md'), 'dirty\n')
  await assert.rejects(apply(root, plan), /main directory has uncommitted changes/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
  git(root, 'checkout', '-q', '--', '.')
  git(root, 'branch', 'chore/adf-update-0.2.0')
  await assert.rejects(apply(root, plan), /branch chore\/adf-update-0\.2\.0 already exists/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
})

test('apply raises a major contract change as a refusal naming both versions', async () => {
  const { root, plan } = planned()
  writeFileSync(join(plan.clones.new, 'plugins/adf/contract/contract.json'), JSON.stringify({ version: '2.0', points: {} }))
  await assert.rejects(apply(root, plan), /1\.9.*2\.0/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
  assert.equal(git(root, 'branch', '--list', 'chore/adf-update-0.2.0').trim(), '')
})

test('an edited file with no choice is refused', async () => {
  const { root, plan } = planned({ review: 'R1 mine\nR2\nR3\nR4\nR5\n' })
  await assert.rejects(apply(root, plan), /no choice for \.demo\/review\.md/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
})

test('commit refuses while conflict markers remain', async () => {
  const { root, plan } = planned({ review: 'R1 mine\nR2\nR3\nR4\nR5\n' })
  const out = await apply(root, plan, { '.demo/review.md': 'keep' })
  assert.equal(out.committed, false)
  assert.deepEqual(out.conflicts, ['.demo/review.md'])
  const wt = out.worktree
  assert.match(readFileSync(join(wt, '.demo/review.md'), 'utf8'), /^<<<<<<< /m)
  const commit = () => run(['commit', '--worktree', wt, '--to', 'v0.2.0'])
  assert.throws(commit, /\.demo\/review\.md.*conflict markers/)
  writeFileSync(join(wt, '.demo/review.md'), 'R1 merged\nR2\nR3\nR4\nR5\n')
  writeFileSync(join(wt, 'stray.txt'), 'not ours\n')
  assert.deepEqual(commit(), { worktree: wt, branch: 'chore/adf-update-0.2.0', committed: true })
  assert.equal(git(wt, 'log', '-1', '--format=%s').trim(), 'chore(adf): update to v0.2.0')
  assert.equal(git(wt, 'status', '--porcelain').trim(), '?? stray.txt')
})

test('a manual file is left untouched and listed, and commit stages it', async () => {
  const { root, plan } = planned({ review: 'R1 mine\nR2\nR3\nR4\nR5\n' })
  const out = await apply(root, plan, { '.demo/review.md': 'manual' })
  assert.equal(out.committed, false)
  assert.deepEqual(out.manual, ['.demo/review.md'])
  assert.equal(readFileSync(join(out.worktree, '.demo/review.md'), 'utf8'), 'R1 mine\nR2\nR3\nR4\nR5\n')
  writeFileSync(join(out.worktree, '.demo/review.md'), 'R1 decided\n')
  run(['commit', '--worktree', out.worktree, '--to', 'v0.2.0'])
  assert.equal(git(out.worktree, 'status', '--porcelain').trim(), '')
})

test('plan reads the integration branch at origin, not a main directory behind it', async () => {
  const root = hostProject(repo)
  const bare = mkdtempSync(join(tmpdir(), 'adf-ua-origin-'))
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(root, 'remote', 'add', 'origin', bare)
  git(root, 'push', '-q', 'origin', 'main')
  const mate = mkdtempSync(join(tmpdir(), 'adf-ua-mate-'))
  git(mate, 'clone', '-q', bare, '.')
  writeFileSync(join(mate, '.demo/review.md'), 'R1\nR2\nR3\nR4\nR5 mine\n')
  git(mate, 'commit', '-q', '-am', 'docs: tune the review prompt')
  git(mate, 'push', '-q', 'origin', 'main')
  const plan = run(['plan', '--root', root])
  assert.equal(plan.base, 'origin/main')
  assert.equal(plan.hostFiles.find((f) => f.path === '.demo/review.md').class, 'edited')
  assert.equal(plan.baseCommit, git(mate, 'rev-parse', 'HEAD').trim())
  const out = await apply(root, plan, { '.demo/review.md': 'keep' })
  assert.equal(out.committed, true)
  assert.equal(readFileSync(join(out.worktree, '.demo/review.md'), 'utf8'), 'R1 new\nR2\nR3\nR4\nR5 mine\n')
})

test('plan removes its clones when it fails after cloning', () => {
  const root = hostProject(repo)
  let target = null
  const failing = (args) => {
    if (args[0] === 'clone') target = args.at(-1)
    if (args.includes('log')) throw new Error('log failed')
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  assert.throws(() => run(['plan', '--root', root, '--to', 'v0.2.0'], { git: failing }), /log failed/)
  assert.ok(target)
  assert.equal(existsSync(dirname(target)), false)
})

test('apply refuses clones whose new release is not at --to', async () => {
  const { root, plan } = planned()
  await assert.rejects(apply(root, { ...plan, clones: { ...plan.clones, new: plan.clones.old } }), /is not at v0\.2\.0; run plan again/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
})

test('a failing commit leaves apply uncommitted, and commit finishes it; a second commit is refused', async () => {
  const { root, plan } = planned()
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const out = await apply(root, plan)
  assert.equal(out.committed, false)
  assert.equal(typeof out.commitError, 'string')
  assert.ok(existsSync(join(out.worktree, '.claude/settings.json')))
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const commit = () => run(['commit', '--worktree', out.worktree, '--to', 'v0.2.0'])
  assert.equal(commit().committed, true)
  assert.throws(commit, /nothing to commit/)
})

test('apply refuses when the integration branch moved since plan', async () => {
  const root = hostProject(repo)
  const plan = run(['plan', '--root', root])
  writeFileSync(join(root, '.demo/review.md'), 'R1 later\nR2\nR3\nR4\nR5\n')
  git(root, 'commit', '-q', '-am', 'docs: a later edit')
  await assert.rejects(apply(root, plan, { '.demo/review.md': 'keep' }), /the integration branch moved since plan .*run plan again/)
  assert.equal(existsSync(join(root, '.claude', 'worktrees')), false)
})

test('plan refuses before cloning a dirty main directory or an existing update branch or worktree', () => {
  const root = hostProject(repo)
  let cloned = false
  const spy = (args) => {
    if (args[0] === 'clone') cloned = true
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const plan = () => run(['plan', '--root', root, '--to', 'v0.2.0'], { git: spy })
  writeFileSync(join(root, 'adf/planning.md'), 'dirty\n')
  assert.throws(plan, /cannot start: the main directory has uncommitted changes to tracked files/)
  git(root, 'checkout', '-q', '--', '.')
  git(root, 'branch', 'chore/adf-update-0.2.0')
  assert.throws(plan, /branch chore\/adf-update-0\.2\.0 already exists/)
  git(root, 'branch', '-q', '-D', 'chore/adf-update-0.2.0')
  mkdirSync(join(root, '.claude', 'worktrees', 'adf-update-0.2.0'), { recursive: true })
  assert.throws(plan, /adf-update-0\.2\.0 already exists/)
  assert.equal(cloned, false)
})

test('a github source is read as its repository on GitHub', () => {
  const root = hostProject(repo)
  const settings = join(root, '.claude', 'settings.json')
  const text = readFileSync(settings, 'utf8')
  const parsed = JSON.parse(text)
  parsed.extraKnownMarketplaces['agentic-dev-flow'].source = { source: 'github', repo: 'owner/agentic-dev-flow', ref: 'v0.1.0' }
  writeFileSync(settings, JSON.stringify(parsed))
  git(root, 'commit', '-q', '-am', 'chore: github source')
  const asked = []
  const fake = (args) => {
    asked.push(args)
    if (args[0] === 'ls-remote') return 'a\trefs/tags/v0.1.0\n'
    throw new Error('unexpected')
  }
  assert.equal(run(['plan', '--root', root], { git: fake }).upToDate, true)
  assert.deepEqual(asked, [['ls-remote', '--tags', 'https://github.com/owner/agentic-dev-flow.git']])
  assert.equal(run(['check', '--root', root, '--home', mkdtempSync(join(tmpdir(), 'adf-ua-home-'))], { git: fake }).latest, 'v0.1.0')
  assert.equal(asked.at(-1)[2], 'https://github.com/owner/agentic-dev-flow.git')
})

// ---------------------------------------------------------------- the move to adf/ (#26)

// A project on the earlier layout: openspec/ with its specs, an archived change, the planning
// guide with values, the review prompt at the old default, and a CLAUDE.md that names openspec/.
const LEGACY = {
  'openspec/planning.md': '# Planning Guide\n\n## Where to look\n\nThe memory first.\n\n## Whole-suite command\n\n`npm test -- --force`\n\n## Worktree copies\n\n- `.env`\n\n## Test-first shares\n\n- `.env`\n',
  'openspec/review-prompt.md': 'Our review criteria.\n',
  'openspec/context.md': 'The project.\n',
  'openspec/specs/cap/spec.md': '# cap Specification\n\n## Purpose\nThe cap.\n',
  'openspec/changes/archive/2026-01-01-one/proposal.md': 'Once under openspec/changes/one.\n',
  'openspec/changes/archive/2026-01-01-one/tasks.md': '- [x] 1.1 a\n',
  'CLAUDE.md': '# Rules\n\nThe specs are in openspec/specs/.\n'
}

test('plan shows the move: the archived changes, the guide, the review prompt, no change in flight', () => {
  const { plan } = planned({ legacy: LEGACY })
  assert.deepEqual(plan.migration, { from: 'openspec', to: 'adf', archived: 1, guide: true, reviewPrompt: { from: 'openspec/review-prompt.md', to: 'adf/review-prompt.md' }, inFlight: [] })
  const { plan: moved } = planned()
  assert.equal(moved.migration, null)
})

test('apply moves openspec/ to adf/, converts the guide, moves the review prompt and stages it all', async () => {
  const { root, plan } = planned({ legacy: LEGACY })
  const out = await apply(root, plan)
  assert.equal(out.committed, true, out.commitError)
  const wt = out.worktree
  assert.equal(git(wt, 'status', '--porcelain').trim(), '')
  assert.equal(existsSync(join(wt, 'openspec')), false)
  for (const path of ['adf/review-prompt.md', 'adf/context.md', 'adf/specs/cap/spec.md', 'adf/changes/archive/2026-01-01-one/proposal.md']) assert.ok(existsSync(join(wt, path)), path)
  assert.equal(existsSync(join(wt, 'adf/planning.md')), false)
  // The archived change keeps its text, old paths included.
  assert.equal(readFileSync(join(wt, 'adf/changes/archive/2026-01-01-one/proposal.md'), 'utf8'), 'Once under openspec/changes/one.\n')
  const settings = JSON.parse(readFileSync(join(wt, 'adf/settings.json'), 'utf8'))
  assert.deepEqual([settings.wholeSuiteCommand, settings.worktreeCopies, settings.testFirstShares], ['npm test -- --force', ['.env'], ['.env']])
  assert.match(readFileSync(join(wt, 'adf/guide.md'), 'utf8'), /## Where to look\n\nThe memory first\./)
  assert.equal(JSON.parse(readFileSync(join(wt, '.claude/adf-extensions.json'), 'utf8')).review.prompt, 'adf/review-prompt.md')
  assert.deepEqual(out.migration.mentions, [{ file: 'CLAUDE.md', lines: [3] }])
  assert.deepEqual(out.migration.notes, [])
  assert.equal(out.migration.archived, 1)
  // One commit, the files moved as renames.
  const renamed = git(wt, 'show', '-M', '--name-status', '--format=', 'HEAD').trim().split('\n')
  assert.ok(renamed.includes('R100\topenspec/specs/cap/spec.md\tadf/specs/cap/spec.md'), renamed.join('\n'))
  assert.equal(git(wt, 'log', '-1', '--format=%s').trim(), 'chore(adf): update to v0.2.0')
})

test('a move left uncommitted is finished by commit, the moved files staged', async () => {
  const { root, plan } = planned({ legacy: LEGACY })
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const out = await apply(root, plan)
  assert.equal(out.committed, false)
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  assert.equal(run(['commit', '--worktree', out.worktree, '--to', 'v0.2.0']).committed, true)
  assert.equal(git(out.worktree, 'status', '--porcelain').trim(), '')
  assert.equal(git(out.worktree, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'openspec').trim(), '')
})
