// The release check in scripts/check-release.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRelease } from '../../../../scripts/check-release.mjs'

const marketplace = (version, plugins = [{ name: 'adf', version: '0.18.1' }]) => ({ metadata: { version }, plugins })

test('a consistent marketplace with no tag passes', () => {
  assert.deepEqual(checkRelease({ marketplace: marketplace('0.18.1'), manifests: { adf: '0.18.1' }, headTags: [] }), [])
})

test('metadata.version must be x.y.z', () => {
  for (const bad of ['0.18', 'v0.18.1', undefined]) {
    const errors = checkRelease({ marketplace: marketplace(bad), manifests: { adf: '0.18.1' }, headTags: [] })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /metadata\.version must be x\.y\.z/)
  }
})

test("each plugin entry's version equals its plugin.json", () => {
  const errors = checkRelease({ marketplace: marketplace('0.18.1'), manifests: { adf: '0.19.0' }, headTags: [] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /adf/)
  assert.match(errors[0], /0\.18\.1/)
  assert.match(errors[0], /0\.19\.0/)
})

test('a v-tag on HEAD must equal v<metadata.version>', () => {
  const base = { marketplace: marketplace('0.18.1'), manifests: { adf: '0.18.1' } }
  assert.equal(checkRelease({ ...base, headTags: ['v0.19.0'] }).length, 1)
  assert.deepEqual(checkRelease({ ...base, headTags: ['v0.18.1'] }), [])
})

test('a generated Codex manifest that differs fails the check', () => {
  const base = { marketplace: marketplace('0.18.1'), manifests: { adf: '0.18.1' }, headTags: [] }
  const errors = checkRelease({ ...base, differ: ['plugins/adf/plugin.json'] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /plugins\/adf\/plugin\.json/)
})
