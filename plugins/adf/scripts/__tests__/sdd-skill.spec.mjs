// sdd.mjs brief and package: the skill's two scripts, called with the change's own output paths.
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { run } from '../sdd.mjs'
import { commitIn, host, superpowersHome } from './git-host.mjs'

const PLAN = '# Plan\n\n### Task 1: one\n\nbody\n'

test('brief writes the task brief into the change workspace through bash', () => {
  const { change } = host({ 'plan.md': PLAN })
  const home = superpowersHome()
  const out = run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', home])
  assert.equal(out.ok, true, out.error)
  assert.equal(out.file, join(change, '.superpowers/sdd/add-x/task-1-brief.md'))
  assert.match(readFileSync(out.file, 'utf8'), /^brief 1 of .*openspec\/changes\/add-x\/plan\.md/)
  assert.deepEqual(out.stray, [])
})

test('output the script left on the shared default path is moved into the change workspace', () => {
  const { change } = host({ 'plan.md': PLAN })
  const out = run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', superpowersHome({ leak: true })])
  assert.equal(out.ok, true)
  assert.deepEqual(out.stray, [{ from: '.superpowers/sdd/plan/leak.md', to: '.superpowers/sdd/add-x/leak.md' }])
  assert.equal(existsSync(join(change, '.superpowers/sdd/plan')), false)
  assert.equal(readFileSync(join(change, '.superpowers/sdd/add-x/leak.md'), 'utf8'), 'leaked\n')
})

test('package resolves both refs to commit ids and names the file by their first seven characters', () => {
  const { change } = host({ 'plan.md': PLAN })
  const home = superpowersHome()
  const base = commitIn(change, 'b.txt', 'b\n')
  const head = commitIn(change, 'c.txt', 'c\n')
  const out = run(['package', '--change', 'add-x', '--base', 'HEAD~1', '--head', 'HEAD', '--root', change, '--home', home])
  assert.equal(out.ok, true, out.error)
  assert.deepEqual([out.base, out.head], [base, head])
  assert.equal(out.file, join(change, `.superpowers/sdd/add-x/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`))
  assert.match(readFileSync(out.file, 'utf8'), /c\.txt/)
  const wrong = run(['package', '--change', 'add-x', '--base', 'HEAD', '--head', 'HEAD~1', '--root', change, '--home', home])
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /review-package exited 3/)
  assert.throws(() => run(['package', '--change', 'add-x', '--base', 'nope', '--head', 'HEAD', '--root', change, '--home', home]), /does not resolve/)
})

test('brief and package refuse without their arguments, a plan, or the skill', () => {
  const { change } = host()
  const home = superpowersHome()
  assert.throws(() => run(['brief', '--change', 'add-x', '--root', change, '--home', home]), /--task/)
  assert.throws(() => run(['package', '--change', 'add-x', '--base', 'HEAD', '--root', change]), /--head/)
  assert.throws(() => run(['brief', '--change', 'add-x', '--task', '1', '--root', change, '--home', home]), /plan\.md does not exist/)
  const empty = superpowersHome()
  const { change: other } = host({ 'plan.md': PLAN })
  assert.throws(() => run(['brief', '--change', 'add-x', '--task', '1', '--root', other, '--home', join(empty, 'none')]), /not installed/)
})
