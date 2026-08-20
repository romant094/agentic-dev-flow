import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { findForeignLines, isInScope } from './check-english.mjs'

test('flags Cyrillic', () => {
  assert.deepEqual(findForeignLines('ok\nпривет\nfine'), [{ line: 2, text: 'привет' }])
})

test('flags CJK', () => {
  assert.equal(findForeignLines('ok\n中文\n').length, 1)
})

test('leaves English prose alone, including typography', () => {
  assert.deepEqual(findForeignLines('An em dash — an arrow → a quote "x"'), [])
})

test('reports every offending line, not just the first', () => {
  assert.equal(findForeignLines('привет\n中文').length, 2)
})

test('an opsx command file is in scope', () => {
  assert.equal(isInScope('.claude/commands/opsx/apply.md'), true)
})

test('a wiki memory page is out of scope', () => {
  assert.equal(isInScope('.claude/memory/index.md'), false)
})

test('a skill README other than the sync-specs skill is out of scope', () => {
  assert.equal(isInScope('.claude/skills/some-other-skill/README.md'), false)
  assert.equal(isInScope('.claude/skills/openspec-sync-specs/README.md'), true)
})

test("the checker's own test fixtures are excluded", () => {
  assert.equal(isInScope('.claude/scripts/check-english.test.mjs'), false)
})

test('a filled-in change plan.md is excluded', () => {
  assert.equal(isInScope('openspec/changes/integrate-superpowers-workflow/plan.md'), false)
})

test('a change plan stays exempt after it is archived', () => {
  assert.equal(isInScope('openspec/changes/integrate-superpowers-workflow/plan.md'), false)
  assert.equal(isInScope('openspec/changes/archive/2026-08-03-integrate-superpowers-workflow/plan.md'), false)
})

test('an archived artifact other than the plan stays in scope', () => {
  assert.equal(isInScope('openspec/changes/archive/2026-08-03-integrate-superpowers-workflow/proposal.md'), true)
})
