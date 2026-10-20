// Iteration keys in scripts/check-lessons.mjs: `10` and `10b` are distinct iterations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEvidence, doneIterations } from '../../../../scripts/check-lessons.mjs'

function iterations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'iterations-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return doneIterations(dir)
}

test('10b pending while 10 is done and 10b is not is ok', () => {
  const done = iterations({ '10-core.md': '# 10\n\n## Result\n', '10b-maintainer.md': '# 10b\n' })
  assert.deepEqual(checkEvidence('pending: iteration 10b', 'ported', done), [])
})

test('10b pending after 10b has a Result is an error', () => {
  const done = iterations({ '10-core.md': '# 10\n', '10b-maintainer.md': '# 10b\n\n## Result\n' })
  assert.deepEqual(checkEvidence('pending: iteration 10b', 'ported', done), ['pending on iteration 10b, which is done'])
  assert.deepEqual(checkEvidence('pending: iteration 10', 'ported', done), [])
})

test('malformed pending: iteration 10bb is an error', () => {
  assert.equal(checkEvidence('pending: iteration 10bb', 'ported', new Set()).length, 1)
})
