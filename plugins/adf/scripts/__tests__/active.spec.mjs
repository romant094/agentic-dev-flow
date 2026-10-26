// The active change of a checkout (lib/active.mjs): the local pointer `.adf/active.json`, one
// entry per branch, set by propose and by any command given a change name, read by the commands
// given none, so they do not ask; each switch recorded in the ledger of the change switched to.
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { handOver, pointerOf, readPointers, resolveActive, setPointer } from '../lib/active.mjs'
import { listRecords } from '../lib/ledger.mjs'
import { loadSchema } from '../lib/schema.mjs'
import { run as changes } from '../changes.mjs'
import { commitIn, git, host } from './git-host.mjs'

const schema = loadSchema()
const active = (cwd, options = {}) => resolveActive(cwd, { schema, env: {}, ...options })

// add-x in its worktree, beside old-y, a change the worktree's branch also holds.
function twoInFlight() {
  const made = host()
  commitIn(made.change, 'openspec/changes/old-y/tasks.md', '- [ ] 1.1 old\n')
  return made
}

test('the pointer is the checkout\'s own, one entry per branch, in an ignored file', () => {
  const { root, change } = host()
  assert.equal(pointerOf(change), null)
  const set = setPointer(change, 'add-x', { env: {} })
  assert.deepEqual([set.key, set.previous, set.switched], ['feat/add-x', null, false])
  assert.equal(pointerOf(change).change, 'add-x')
  assert.deepEqual(Object.keys(readPointers(change)), ['feat/add-x'])
  assert.equal(pointerOf(root), null, 'the main checkout keeps no pointer of the worktree')
  assert.equal(git(change, 'status', '--porcelain'), '', 'the pointer is never committed')
})

test('with no pointer and more than one change in flight the command asks', () => {
  const { change } = twoInFlight()
  const out = active(change)
  assert.equal(out.ask, true)
  assert.deepEqual(out.choices.map((c) => c.name).sort(), ['add-x', 'old-y'])
})

test('a name sets the pointer; without a name the pointer answers, from the worktree and from the main checkout', () => {
  const { root, change } = twoInFlight()
  const named = active(change, { name: 'add-x' })
  assert.deepEqual([named.ok, named.ask, named.change, named.root, named.source, named.switched], [true, false, 'add-x', change, 'named', false])
  assert.deepEqual([active(change).change, active(change).source, active(change).ask], ['add-x', 'pointer', false])
  assert.deepEqual([active(root).change, active(root).root], ['add-x', change])
  assert.equal(listRecords(change, 'add-x').filter((r) => r.kind === 'switch').length, 0, 'a first pointer is no switch')
})

test('a name switches the pointer and the switch is recorded in the ledger of the change switched to', () => {
  const { change } = twoInFlight()
  active(change, { name: 'add-x' })
  const out = active(change, { name: 'old-y' })
  assert.deepEqual([out.change, out.switched], ['old-y', true])
  const [record] = listRecords(change, 'old-y').filter((r) => r.kind === 'switch')
  assert.deepEqual([record.from, record.to, record.pointer], ['add-x', 'old-y', '.adf/active.json#feat/add-x'])
  assert.equal(listRecords(change, 'add-x').length, 0, 'the old change stays as it is')
  assert.equal(active(change).change, 'old-y')
  // Naming the active change again is no switch.
  assert.equal(active(change, { name: 'old-y' }).switched, false)
})

test('one change in flight is used without asking; an unknown name is refused with the list', () => {
  const { root } = host()
  assert.deepEqual([active(root).change, active(root).source, active(root).ask], ['add-x', 'only', false])
  const unknown = active(root, { name: 'nope' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /no change "nope" is in flight/)
  assert.deepEqual(unknown.choices.map((c) => c.name), ['add-x'])
})

test('archive hands the pointer to the main checkout, where land finds the archived change until it is landed', () => {
  const { root, change } = host()
  setPointer(change, 'add-x', { env: {} })
  commitIn(root, 'openspec/changes/archive/2026-10-19-add-x/tasks.md', '- [x] 1.1 a\n')
  assert.deepEqual(handOver(change, root, 'add-x'), { handed: true, key: 'feat/add-x' })
  assert.equal(readPointers(root)['feat/add-x'].change, 'add-x')
  const out = active(root, { archived: true })
  assert.deepEqual([out.ok, out.ask, out.change, out.root, out.source], [true, false, 'add-x', root, 'pointer'])
  // A landed change is no candidate: land asks.
  const land = join(root, '.superpowers', 'sdd', 'add-x', 'land')
  mkdirSync(land, { recursive: true })
  const done = { state: 'done' }
  writeFileSync(join(land, 'land.json'), JSON.stringify({ version: 1, change: 'add-x', steps: { check: done, wait: done, 'comment-input': done, comment: done, handoff: done } }))
  assert.equal(active(root, { archived: true }).ask, true)
  // A worktree whose pointer names another change hands nothing over.
  assert.deepEqual(handOver(change, root, 'other'), { handed: false, key: 'feat/add-x' })
})

test('changes.mjs active prints the resolution and sets the pointer for a name', async () => {
  const { change } = twoInFlight()
  const asked = await changes(['active', '--root', change], { env: {} })
  assert.equal(asked.ask, true)
  const named = await changes(['active', '--change', 'add-x', '--root', change], { env: {} })
  assert.deepEqual([named.change, named.source], ['add-x', 'named'])
  assert.deepEqual([(await changes(['active', '--root', change], { env: {} })).change], ['add-x'])
})
