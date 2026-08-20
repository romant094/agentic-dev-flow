import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { REQUIRED_SECTIONS } from './mr.mjs'

// Compared against the validator's own list, not a copy of it: a template that drifts from
// what parseBody demands rejects every description the flow generates, silently.
test('the shipped GitLab template has exactly the sections the validator requires', () => {
  const tpl = readFileSync('.gitlab/merge_request_templates/opsx.md', 'utf8')
  const names = [...tpl.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  assert.deepEqual(names, [...REQUIRED_SECTIONS])
})

test('the template carries an opsx marker pair for description scoping', () => {
  const tpl = readFileSync('.gitlab/merge_request_templates/opsx.md', 'utf8')
  assert.match(tpl, /<!-- opsx:/)
  assert.match(tpl, /<!-- \/opsx:/)
})
