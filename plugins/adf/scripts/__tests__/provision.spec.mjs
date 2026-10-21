// lib/provision.mjs and its callers against real git repositories: the copies of the planning
// guide's `## Worktree copies`, the `provision` hook on all four worktree kinds, the comparison
// that refuses a provider writing a tracked path or into the main checkout, and the `teardown`
// hook before every removal. The providers are fixture plugins named by an absolute registry path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addBaseCheck, addGroup, mergeGroup, removeBaseCheck, removeGroup } from '../lib/groups.mjs'
import { copiesIn, provisionWorktree, teardownWorktree } from '../lib/provision.mjs'
import { readRegistry, writeRegistry } from '../lib/registry.mjs'
import { tddProof } from '../lib/tdd-proof.mjs'
import { remove } from '../lib/workspace.mjs'
import { run } from '../workspace.mjs'
import { commitIn, git, host } from './git-host.mjs'

const PLAN = [
  '# Plan',
  '',
  '**Needs:** database, cache',
  '',
  '### Task 1: one',
  '',
  '> Implements tasks.md 1.1.',
  '',
  '**Files:**',
  '- Modify: `src/a.mjs`',
  '- Test: `test/a.test.mjs`',
  ''
].join('\n')

const GUIDE = ['# Planning Guide', '', '## Worktree copies', '', '<!-- untracked files every worktree gets -->', '- `.env`', '- `config/local.json`', '- `missing.txt`', '- `../outside`', '', '## Packages', ''].join('\n')

// A provider that logs each call's operation and input to config.log, writes config.writes
// ([where, path, text], where `worktree` or `main`) and answers config.state.
const PROVIDER = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
let t = ''
process.stdin.on('data', (d) => (t += d)).on('end', () => {
  const { config, input } = JSON.parse(t)
  appendFileSync(config.log, JSON.stringify({ op: process.argv[2], name: config.name, input }) + '\\n')
  for (const [where, path, text] of config.writes?.[process.argv[2]] ?? []) {
    const file = join(where === 'main' ? input.main : input.worktree, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const state = config.states?.[process.argv[2]] ?? 'done'
  console.log(JSON.stringify({ state, actions: [], notes: config.notes ?? [], ...(state === 'refused' ? { error: config.name + ' says no' } : {}), ...(state === 'degraded' ? { hint: 'start the tool' } : {}) }))
})
`

// A host with add-x in its worktree, the plan above, `.env` and `deps/` ignored in every
// worktree (the common info/exclude), `.env` and config/local.json in the main checkout.
function setup({ guide = GUIDE } = {}) {
  const { root, change } = host({ 'plan.md': PLAN })
  appendFileSync(join(root, '.git', 'info', 'exclude'), '.env\ndeps/\n')
  writeFileSync(join(root, '.env'), 'URL=main\n')
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'local.json'), '{}\n')
  mkdirSync(join(change, 'openspec'), { recursive: true })
  writeFileSync(join(change, 'openspec', 'planning.md'), guide)
  git(change, 'add', 'openspec/planning.md')
  git(change, 'commit', '-q', '-m', 'guide')
  return { root, change }
}

// Registers fixture providers in the change worktree's registry, committed so the tree stays
// clean; each gets config { name, log, ...config }. Returns the log reader.
function providers(change, list) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adf-prov-')))
  const log = join(dir, 'calls.jsonl')
  const extensions = list.map(({ name, points = ['provision', 'teardown'], config = {} }) => {
    mkdirSync(join(dir, name), { recursive: true })
    const provides = Object.fromEntries(points.map((p) => [p, { script: 'p.mjs', operations: [p] }]))
    writeFileSync(join(dir, name, 'adf-extension.json'), JSON.stringify({ name, contract: '1.6', provides }))
    writeFileSync(join(dir, name, 'p.mjs'), PROVIDER)
    return { path: join(dir, name), points, config: { name, log, ...config } }
  })
  writeRegistry(change, { ...readRegistry(change), extensions })
  git(change, 'add', '.claude/adf-extensions.json')
  git(change, 'commit', '-q', '-m', 'providers')
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
}

test('copiesIn reads every backticked path of the section, comments left out', () => {
  assert.deepEqual(copiesIn(GUIDE), ['.env', 'config/local.json', 'missing.txt', '../outside'])
  assert.deepEqual(copiesIn('## Worktree copies\n\n`dir/`, `a`\n## Next\n`b`\n'), ['dir', 'a'])
  assert.deepEqual(copiesIn('# Guide\n'), [])
})

test('the change worktree gets its copies and the provision call; a second run changes nothing', () => {
  const { root, change } = setup()
  const calls = providers(change, [{ name: 'one', config: { notes: ['dependencies linked'] } }, { name: 'two' }])
  const out = run(['provision', '--change', 'add-x', '--root', change, '--need', 'queue', '--need', 'cache'])
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.copies.copied, ['.env'])
  assert.deepEqual(out.copies.skipped.map((s) => s.path), ['config/local.json', 'missing.txt', '../outside'])
  assert.equal(readFileSync(join(change, '.env'), 'utf8'), 'URL=main\n')
  assert.match(out.report, /copy config\/local\.json skipped: git does not ignore it in the worktree/, 'a copy git would see is never made')
  assert.equal(existsSync(join(change, 'config', 'local.json')), false)
  assert.equal(git(change, 'status', '--porcelain'), '')
  assert.match(out.report, /copy missing\.txt skipped: not in the main checkout/)
  assert.match(out.report, /one: done\n {2}dependencies linked/)
  const [one, two] = calls()
  assert.deepEqual([one.op, one.name, two.name], ['provision', 'one', 'two'])
  assert.deepEqual(one.input, {
    worktree: change,
    main: root,
    kind: 'change',
    change: 'add-x',
    branch: 'feat/add-x',
    base: { ref: 'develop', commit: git(root, 'rev-parse', 'develop') },
    files: ['src/a.mjs', 'test/a.test.mjs'],
    needs: ['database', 'cache', 'queue']
  })

  writeFileSync(join(change, '.env'), 'URL=rewritten\n')
  const again = run(['provision', '--change', 'add-x', '--root', change])
  assert.equal(again.ok, true, again.error)
  assert.deepEqual([again.copies.copied, again.copies.kept], [[], ['.env']])
  assert.equal(readFileSync(join(change, '.env'), 'utf8'), 'URL=rewritten\n', 'a copy a provider rewrote is kept')
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'URL=main\n')
})

test('no copy is written through a link: a link in its place is replaced, a linked parent is skipped', () => {
  const { root, change } = setup({ guide: '## Worktree copies\n\n`.env`\n`linked/x.txt`\n' })
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'adf-elsewhere-')))
  writeFileSync(join(elsewhere, 'target'), 'keep\n')
  symlinkSync(join(elsewhere, 'target'), join(change, '.env'))
  symlinkSync(elsewhere, join(change, 'linked'))
  mkdirSync(join(root, 'linked'))
  writeFileSync(join(root, 'linked', 'x.txt'), 'x\n')
  appendFileSync(join(root, '.git', 'info', 'exclude'), 'linked\n')
  const out = provisionWorktree(change, { worktree: change, kind: 'change', change: 'add-x' })
  assert.equal(out.ok, true, out.error)
  assert.equal(lstatSync(join(change, '.env')).isSymbolicLink(), false)
  assert.equal(readFileSync(join(change, '.env'), 'utf8'), 'URL=main\n')
  assert.equal(readFileSync(join(elsewhere, 'target'), 'utf8'), 'keep\n', 'the link target is untouched')
  assert.deepEqual(out.copies.skipped, [{ path: 'linked/x.txt', reason: 'linked is a link in the worktree; nothing is written through it' }])
  assert.equal(existsSync(join(elsewhere, 'x.txt')), false)
})

test('a provider that changes a tracked path, or writes into the main checkout, is refused with the paths', () => {
  const { change } = setup()
  providers(change, [{ name: 'bad', config: { writes: { provision: [['worktree', 'a.txt', 'changed\n'], ['main', 'stray.txt', 'x\n'], ['worktree', 'deps/ok.js', '1\n']] } } }])
  const out = run(['provision', '--change', 'add-x', '--root', change])
  assert.equal(out.ok, false)
  assert.equal(out.state, 'refused')
  assert.match(out.error, /a\.txt \(worktree\), stray\.txt \(main checkout\)/)
  assert.doesNotMatch(out.error, /deps/, 'an ignored path is the provider\'s to write')
})

test('a refused provider stops the step; a degraded one continues with its hint', () => {
  const { change } = setup()
  providers(change, [{ name: 'tool', config: { states: { provision: 'degraded' } } }])
  const degraded = run(['provision', '--change', 'add-x', '--root', change])
  assert.deepEqual([degraded.ok, degraded.state], [true, 'degraded'])
  assert.match(degraded.report, /tool: degraded; start the tool/)
  const other = setup()
  const calls = providers(other.change, [{ name: 'no', config: { states: { provision: 'refused' } } }, { name: 'after' }])
  const refused = run(['provision', '--change', 'add-x', '--root', other.change])
  assert.deepEqual([refused.ok, refused.state], [false, 'refused'])
  assert.match(refused.error, /provision refused: no says no/)
  assert.match(refused.report, /not called after the refusal: after/)
  assert.deepEqual(calls().map((c) => c.name), ['no'])
})

test('needs reach a change or group worktree only; the main checkout is never provisioned', () => {
  const { root, change } = setup()
  assert.throws(() => run(['provision', '--change', 'add-x', '--root', change, '--kind', 'base-check', '--need', 'database']), /--need applies to a change or group worktree, not base-check/)
  assert.throws(() => run(['provision', '--change', 'add-x', '--root', change, '--need', 'Data Base']), /--need takes a lowercase word/)
  assert.throws(() => run(['provision', '--change', 'add-x', '--root', change, '--kind', 'other']), /--kind must be one of change, group, base-check, proof/)
  assert.throws(() => provisionWorktree(change, { worktree: root, kind: 'change', change: 'add-x' }), /is the main checkout/)
  const calls = providers(change, [{ name: 'one' }])
  assert.equal(provisionWorktree(change, { worktree: change, kind: 'proof', change: 'add-x', needs: ['database'] }).ok, true)
  assert.deepEqual(calls()[0].input.needs, [])
})

test('group-add and base-check-add provision their worktrees; their removals tear them down first', () => {
  const { root, change } = setup()
  const calls = providers(change, [{ name: 'one' }])
  const group = addGroup(change, { change: 'add-x', group: 1 })
  assert.equal(group.provision.ok, true, group.provision.error)
  assert.equal(readFileSync(join(group.root, '.env'), 'utf8'), 'URL=main\n')
  const base = addBaseCheck(change, { change: 'add-x' })
  assert.equal(base.provision.ok, true)
  commitIn(group.root, 'g.txt', 'g\n')
  mergeGroup(change, { change: 'add-x', group: 1 })
  removeGroup(change, { change: 'add-x', group: 1 })
  removeBaseCheck(change, { change: 'add-x' })
  const seen = calls().map(({ op, input }) => [op, input.kind, input.branch, input.needs ?? null, input.worktree])
  assert.deepEqual(seen, [
    ['provision', 'group', 'feat/add-x--group-1', ['database', 'cache'], group.root],
    ['provision', 'base-check', null, [], base.root],
    ['teardown', 'group', 'feat/add-x--group-1', null, group.root],
    ['teardown', 'base-check', null, null, base.root]
  ])
  assert.deepEqual(Object.keys(calls()[2].input), ['worktree', 'main', 'kind', 'change', 'branch'])
  assert.equal(calls()[2].input.main, root)
})

test('a refused provisioning of a group says so and leaves the worktree; a refused teardown keeps it', () => {
  const { change } = setup()
  providers(change, [{ name: 'db', config: { states: { provision: 'refused', teardown: 'refused' } } }])
  const group = addGroup(change, { change: 'add-x', group: 1 })
  assert.equal(group.ok, false)
  assert.match(group.error, /the group worktree is made at .*add-x--group-1, but provision refused: db says no; fix the cause, then run workspace\.mjs provision --change add-x --kind group/)
  assert.equal(existsSync(group.root), true)
  const cli = run(['group-add', '--change', 'add-x', '--group', '2', '--root', change])
  assert.equal(cli.ok, false, 'the CLI exits 1 on ok: false')
  commitIn(group.root, 'g.txt', 'g\n')
  mergeGroup(change, { change: 'add-x', group: 1 })
  assert.throws(() => removeGroup(change, { change: 'add-x', group: 1 }), /teardown refused, so .*add-x--group-1 is not removed: db says no/)
  assert.equal(existsSync(group.root), true)
  addBaseCheck(change, { change: 'add-x' })
  assert.throws(() => removeBaseCheck(change, { change: 'add-x' }), /teardown refused/)
})

test('archive\'s remove tears the change worktree down first; refused keeps it, degraded removes it with the hint', () => {
  const { root, change } = setup()
  const calls = providers(change, [{ name: 'db', points: ['teardown'], config: { states: { teardown: 'refused' } } }])
  assert.throws(() => remove(root, { change: 'add-x' }), /teardown refused, so .*worktrees\/add-x is not removed: db says no/)
  assert.equal(existsSync(change), true)
  assert.deepEqual(calls()[0].input, { worktree: change, main: root, kind: 'change', change: 'add-x', branch: 'feat/add-x' })

  const other = setup()
  providers(other.change, [{ name: 'db', points: ['teardown'], config: { states: { teardown: 'degraded' } } }])
  const out = remove(other.root, { change: 'add-x' })
  assert.equal(out.state, 'removed')
  assert.equal(out.teardown.state, 'degraded')
  assert.match(out.teardown.report, /db: degraded; start the tool/)
  assert.equal(existsSync(other.change), false)
})

test('teardownWorktree with no provider is none, and ok', () => {
  const { change } = setup()
  const out = teardownWorktree(change, { worktree: change, kind: 'change', change: 'add-x', branch: 'feat/add-x' })
  assert.deepEqual([out.ok, out.state], [true, 'none'])
})

test('the proof tree is provisioned at the parent and again at the commit, with no needs, and torn down before removal', () => {
  const { change } = setup()
  const calls = providers(change, [{ name: 'one' }])
  commitIn(change, 'src/f.mjs', 'export const f = () => 1\n')
  writeFileSync(join(change, 'src/f.mjs'), 'export const f = () => 2\n')
  mkdirSync(join(change, 'test'), { recursive: true })
  writeFileSync(join(change, 'test/f.test.mjs'), "import { f } from '../src/f.mjs'\nif (f() !== 2) process.exit(1)\n")
  git(change, 'add', 'src/f.mjs', 'test/f.test.mjs')
  git(change, 'commit', '-q', '-m', 'feat: f is 2')
  const sha = git(change, 'rev-parse', 'HEAD')
  const out = tddProof(change, { change: 'add-x', commit: sha, test: 'node test/f.test.mjs' })
  assert.equal(out.proof, true, JSON.stringify(out))
  assert.equal(out.removed, true)
  assert.deepEqual(calls().map(({ op, input }) => [op, input.kind, input.branch, input.needs ?? null]), [
    ['provision', 'proof', null, []],
    ['provision', 'proof', null, []],
    ['teardown', 'proof', null, null]
  ])
  assert.equal(calls()[0].input.files.includes('src/a.mjs'), true)
})

test('a refused provisioning ends the proof with its error; the tree is still torn down and removed', () => {
  const { change } = setup()
  providers(change, [{ name: 'no', config: { states: { provision: 'refused' } } }])
  commitIn(change, 'src/f.mjs', 'export const f = () => 1\n')
  mkdirSync(join(change, 'test'), { recursive: true })
  writeFileSync(join(change, 'test/f.test.mjs'), 'process.exit(0)\n')
  git(change, 'add', 'test/f.test.mjs')
  git(change, 'commit', '-q', '-m', 'test')
  const out = tddProof(change, { change: 'add-x', commit: 'HEAD', test: 'node test/f.test.mjs' })
  assert.equal(out.proof, false)
  assert.match(out.error, /provision refused: no says no/)
  assert.equal(out.parentFails, null, 'nothing ran')
  assert.equal(out.removed, true)
})
