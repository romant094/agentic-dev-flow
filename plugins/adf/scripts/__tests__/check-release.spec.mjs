// The release check in scripts/check-release.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changelogVersions, checkRelease, pinFiles, pinnedTags } from '../../../../scripts/check-release.mjs'

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

const consistent = { marketplace: marketplace('0.18.1'), manifests: { adf: '0.18.1' }, headTags: [] }

test('a version with no changelog section fails', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.18.0] — 2026-10-01\n'
  const errors = checkRelease({ ...consistent, changelog })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /CHANGELOG\.md has no section for 0\.18\.1/)
  assert.deepEqual(checkRelease({ ...consistent, changelog: `${changelog}\n## [0.18.1] — 2026-10-02\n` }), [])
})

test('the Unreleased section is not a version', () => {
  assert.deepEqual(changelogVersions('## [Unreleased]\n\n### Added\n\n## [0.20.0] — 2026-11-03\n## [0.19.0] — 2026-10-30\n'), [
    '0.20.0',
    '0.19.0',
  ])
})

test('a stale pinned tag fails and names the file', () => {
  const pinned = [
    { file: 'README.md', tags: ['v0.18.1'] },
    { file: 'docs/guide/getting-started/codex.md', tags: ['v0.17.0'] },
  ]
  const errors = checkRelease({ ...consistent, pinned })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/guide\/getting-started\/codex\.md: pinned tag v0\.17\.0 must be v0\.18\.1/)
})

test('prose mentions of a version are not pins', () => {
  const text = [
    'codex plugin marketplace add romant094/agentic-dev-flow --ref v0.20.0',
    '{ "ref": "v0.19.0" }',
    'claude plugin marketplace add https://github.com/romant094/agentic-dev-flow.git#v0.18.1',
    'Codex support starts at v0.20.0: use v0.20.0 or a later tag in `--ref`.',
  ].join('\n')
  assert.deepEqual(pinnedTags(text), ['v0.20.0', 'v0.19.0', 'v0.18.1'])
})

test('a link anchor is not a pin, and a git URL fragment is', () => {
  assert.deepEqual(pinnedTags('See [the notes](a.md#v0.19.0).'), [])
  assert.deepEqual(pinnedTags('"url": "https://github.com/romant094/agentic-dev-flow.git#v0.20.0"'), ['v0.20.0'])
})

test('a pre-release tag is not its release', () => {
  assert.deepEqual(pinnedTags('--ref v1.0.0-rc.1\n"ref": "v1.0.0-rc.1"\nrepo.git#v1.0.0-rc.1'), [])
})

test('pins are read from README.md and every page of the guide, at any depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pins-'))
  mkdirSync(join(dir, 'docs/guide/plugins'), { recursive: true })
  for (const file of ['README.md', 'docs/guide/update.md', 'docs/guide/plugins/a.md', 'docs/guide/x.txt']) writeFileSync(join(dir, file), '')
  assert.deepEqual(pinFiles(dir), ['README.md', 'docs/guide/plugins/a.md', 'docs/guide/update.md'])
})
