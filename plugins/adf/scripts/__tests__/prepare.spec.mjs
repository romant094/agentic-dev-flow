// lib/prepare.mjs and prepare.mjs against real git repositories: the planning guide's
// `## Worktree preparation` recipe, its run when a step's inputs changed since the worktree's last
// preparation, the per-worktree state git never sees, and the callers that run it: provisioning,
// a covering run, the whole suite and a group merge. The candidates init offers come from the
// package manifest and the workspace layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addGroup, mergeGroup } from '../lib/groups.mjs'
import { addStep, candidates, prepareWorktree, readRecipe, recipeIn, stateFile } from '../lib/prepare.mjs'
import { runCovering, runSuite, writeCommand } from '../lib/suite.mjs'
import { run } from '../prepare.mjs'
import { commitIn, git, host } from './git-host.mjs'

const BUILD = `import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
mkdirSync('out', { recursive: true })
if (readFileSync('lib/src/mode.txt', 'utf8').trim() === 'broken') { console.error('build failed'); process.exit(3) }
appendFileSync('out/builds.txt', 'built\\n')
`

const GUIDE = [
  '# Planning Guide',
  '',
  '## Worktree preparation',
  '',
  '<!-- - `node never.mjs` from `nowhere` -->',
  '- `node build.mjs` from `lib/src`, `build.mjs`',
  '',
  '## Packages',
  ''
].join('\n')

const PLAN = '# Plan\n\n### Task 1: one\n\n> Implements tasks.md 1.1.\n\n**Files:**\n- Modify: `lib/src/a.txt`\n'

// add-x in its worktree with the recipe above committed, `out/` ignored in every worktree.
function setup(guide = GUIDE) {
  const { root, change } = host({ 'plan.md': PLAN })
  appendFileSync(join(root, '.git', 'info', 'exclude'), 'out/\n')
  for (const [file, text] of Object.entries({ 'build.mjs': BUILD, 'lib/src/mode.txt': 'ok\n', 'lib/src/a.txt': 'a\n', 'other.txt': 'o\n', 'openspec/planning.md': guide })) {
    mkdirSync(join(change, file, '..'), { recursive: true })
    writeFileSync(join(change, file), text)
  }
  git(change, 'add', '.')
  git(change, 'commit', '-q', '-m', 'recipe')
  return { root, change }
}

const builds = (dir) => (existsSync(join(dir, 'out/builds.txt')) ? readFileSync(join(dir, 'out/builds.txt'), 'utf8').split('\n').filter(Boolean).length : 0)

test('the recipe reads one step per list item: the command, then its input paths; comments left out', () => {
  assert.deepEqual(recipeIn(GUIDE), [{ command: 'node build.mjs', inputs: ['lib/src', 'build.mjs'] }])
  assert.deepEqual(recipeIn('# Guide\n\n## Packages\n'), [])
  assert.throws(() => recipeIn('## Worktree preparation\n\n- `npm run build`\n'), /names no input path/)
  assert.throws(() => recipeIn('## Worktree preparation\n\n- `npm run build` from `../x`\n'), /not a path inside the project/)
})

test('a step runs when the worktree was never prepared, or its inputs changed by a commit or uncommitted; not otherwise', () => {
  const { change } = setup()
  const first = prepareWorktree(change)
  assert.equal(first.ok, true, first.error)
  assert.deepEqual(first.ran.map((r) => [r.command, r.reason]), [['node build.mjs', 'never prepared in this worktree']])
  assert.equal(builds(change), 1)
  assert.equal(git(change, 'status', '--porcelain'), '', 'git sees neither the state nor the build output')
  assert.match(stateFile(change), /\.git\/worktrees\//)

  assert.deepEqual(prepareWorktree(change).skipped, [{ command: 'node build.mjs', reason: 'inputs unchanged' }])
  commitIn(change, 'other.txt', 'o2\n')
  assert.equal(prepareWorktree(change).ran.length, 0, 'a commit outside the inputs')
  commitIn(change, 'lib/src/a.txt', 'a2\n')
  assert.match(prepareWorktree(change).ran[0].reason, /inputs changed since [0-9a-f]{7}: lib\/src\/a\.txt/)
  writeFileSync(join(change, 'lib/src/a.txt'), 'a3\n')
  assert.equal(prepareWorktree(change).ran[0].reason, 'uncommitted changes to its inputs')
  assert.equal(prepareWorktree(change).ran.length, 0, 'the same uncommitted changes')
  assert.equal(prepareWorktree(change, { force: true }).ran[0].reason, 'forced')
  assert.equal(builds(change), 4)
})

test('a failed step stops the run and records nothing, so the next run tries again', () => {
  const { change } = setup()
  writeFileSync(join(change, 'lib/src/mode.txt'), 'broken\n')
  const out = prepareWorktree(change)
  assert.equal(out.ok, false)
  assert.match(out.error, /node build\.mjs failed \(exit 3\)[\s\S]*build failed/)
  writeFileSync(join(change, 'lib/src/mode.txt'), 'ok\n')
  assert.equal(prepareWorktree(change).ran[0].reason, 'never prepared in this worktree')
})

test('provisioning prepares each worktree it makes; a group merge prepares the change worktree', () => {
  const { change } = setup()
  const made = addGroup(change, { change: 'add-x', group: 1 })
  assert.equal(made.ok, undefined, made.error)
  assert.match(made.provision.report, /Preparation: node build\.mjs ran \(never prepared in this worktree\)/)
  assert.equal(builds(made.root), 1)
  commitIn(made.root, 'lib/src/a.txt', 'group\n')
  const merged = mergeGroup(change, { change: 'add-x', group: 1 })
  assert.equal(merged.merged, true)
  assert.equal(merged.prepare.ok, true)
  assert.equal(builds(change), 1)
})

test('a covering run and the whole suite prepare their worktree first; a failed preparation refuses the run', () => {
  const { change } = setup()
  writeCommand(change, 'node -e "process.exit(0)"')
  git(change, 'add', '.')
  git(change, 'commit', '-q', '-m', 'suite')
  const covering = runCovering(change, { change: 'add-x', name: 'T1 impl', command: 'node -e "console.log(1)"', worktree: change })
  assert.deepEqual(covering.prepare.ran.map((r) => r.command), ['node build.mjs'])
  assert.equal(builds(change), 1)
  writeFileSync(join(change, 'lib/src/a.txt'), 'edited\n')
  assert.equal(runSuite(change, { change: 'add-x' }).status, 'pass')
  assert.equal(builds(change), 2)
  writeFileSync(join(change, 'lib/src/mode.txt'), 'broken\n')
  assert.throws(() => runCovering(change, { change: 'add-x', name: 'T1 impl', command: 'node -e "1"', worktree: change }), /worktree preparation failed: node build\.mjs failed/)
  assert.throws(() => runSuite(change, { change: 'add-x' }), /worktree preparation failed/)
})

test('candidates are the build scripts of workspace packages another workspace depends on', () => {
  const { change } = setup()
  const write = (file, value) => {
    mkdirSync(join(change, file, '..'), { recursive: true })
    writeFileSync(join(change, file), `${JSON.stringify(value)}\n`)
  }
  write('package.json', { name: 'mono', workspaces: ['packages/*', 'apps/web'], scripts: { 'build:core': 'npm run build --workspace @m/core', test: 'x' } })
  write('packages/core/package.json', { name: '@m/core', scripts: { build: 'tsc' } })
  write('packages/util/package.json', { name: '@m/util', scripts: { build: 'tsc' } })
  write('apps/web/package.json', { name: 'web', dependencies: { '@m/core': '*' }, scripts: { build: 'vite build' } })
  assert.deepEqual(candidates(change), [{ command: 'npm run build:core', inputs: ['packages/core'], why: 'web depends on @m/core, whose build output git does not track' }])
})

test('the CLI adds a step, reads the recipe, runs it and offers candidates', () => {
  const { change } = setup('# Planning Guide\n\n## Packages\n')
  assert.deepEqual(run(['recipe', '--root', change]).steps, [])
  const added = run(['add', '--command', 'node build.mjs', '--input', 'lib/src', '--input', 'build.mjs', '--root', change])
  assert.deepEqual(added.steps, [{ command: 'node build.mjs', inputs: ['lib/src', 'build.mjs'] }])
  assert.deepEqual(readRecipe(change), added.steps)
  assert.deepEqual(addStep(change, { command: 'node build.mjs', inputs: ['lib/src'] }).steps, [{ command: 'node build.mjs', inputs: ['lib/src'] }], 'the same command is replaced')
  assert.equal(run(['run', '--worktree', change, '--root', change]).ok, true)
  assert.equal(run(['run', '--worktree', change, '--root', change, '--force']).ran[0].reason, 'forced')
  assert.deepEqual(run(['candidates', '--root', change]).candidates, [])
  assert.throws(() => run(['add', '--command', 'x', '--root', change]), /needs at least one --input/)
})
