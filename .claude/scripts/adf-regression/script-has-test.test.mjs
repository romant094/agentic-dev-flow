import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, meta } from './script-has-test.mjs'

// Fixtures are served through an injected `list`; nothing here reads the real tree.
function listFrom(tree) {
  return async (dir) => {
    const key = dir.replace(/\/$/, '')
    if (!(key in tree)) {
      const err = new Error(`ENOENT: ${dir}`)
      err.code = 'ENOENT'
      throw err
    }
    return tree[key]
  }
}

test('meta names the concrete incident and reports never having fired', () => {
  assert.match(meta.incident, /adf-flow-improvements/)
  assert.match(meta.incident, /index\.mjs/)
  assert.equal(meta.lastFired, null)
})

test('flags a script with no .test.mjs sibling', async () => {
  const list = listFrom({
    '.claude/scripts': ['lonely.mjs', 'paired.mjs', 'paired.test.mjs'],
    '.claude/scripts/adf-regression': []
  })
  const result = await check({ read: async () => '', list })
  assert.equal(result.ok, false)
  assert.match(result.detail, /lonely\.mjs/)
  assert.doesNotMatch(result.detail, /paired\.mjs/)
})

test('passes when every script has a sibling test', async () => {
  const list = listFrom({
    '.claude/scripts': ['a.mjs', 'a.test.mjs', 'b.mjs', 'b.test.mjs'],
    '.claude/scripts/adf-regression': ['index.mjs', 'index.test.mjs']
  })
  const result = await check({ read: async () => '', list })
  assert.equal(result.ok, true, result.detail)
})

test('does not require a test file to have a test of its own', async () => {
  // `mr-template.test.mjs` exists in the real tree with no `mr-template.mjs` beside it;
  // a test file is never itself a subject of this rule.
  const list = listFrom({
    '.claude/scripts': ['mr-template.test.mjs'],
    '.claude/scripts/adf-regression': []
  })
  const result = await check({ read: async () => '', list })
  assert.equal(result.ok, true, result.detail)
})

test('holds regression scripts to the same rule as any other script', async () => {
  const list = listFrom({
    '.claude/scripts': [],
    '.claude/scripts/adf-regression': ['index.mjs', 'index.test.mjs', 'untested-check.mjs']
  })
  const result = await check({ read: async () => '', list })
  assert.equal(result.ok, false)
  assert.match(result.detail, /adf-regression\/untested-check\.mjs/)
})

test('ignores non-.mjs entries', async () => {
  const list = listFrom({
    '.claude/scripts': ['README.md', 'helper.sh'],
    '.claude/scripts/adf-regression': ['README.md']
  })
  const result = await check({ read: async () => '', list })
  assert.equal(result.ok, true, result.detail)
})
