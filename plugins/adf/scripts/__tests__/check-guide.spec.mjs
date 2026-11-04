// The guide check in scripts/check-guide.mjs and its helpers in scripts/lib/guide.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSources, matchGlob } from '../../../../scripts/lib/guide.mjs'
import { checkGuide, COVERED_DIRS, REGISTRY_KEYS } from '../../../../scripts/check-guide.mjs'

test('parseSources reads the leading comment', () => {
  const text = '<!-- sources:\n- plugins/adf/skills/propose/**\n- plugins/adf/scripts/lib/propose.mjs\n-->\n# Page\n'
  assert.deepEqual(parseSources(text), ['plugins/adf/skills/propose/**', 'plugins/adf/scripts/lib/propose.mjs'])
})

test('a page with no sources comment has none', () => {
  assert.deepEqual(parseSources('# Page\n\ntext\n'), [])
  assert.deepEqual(parseSources('# Page\n<!-- sources:\n- a\n-->\n'), [])
})

test('matchGlob: * stays in a segment, ** crosses them', () => {
  assert.equal(matchGlob('a/*/c.md', 'a/b/c.md'), true)
  assert.equal(matchGlob('a/*/c.md', 'a/b/d/c.md'), false)
  assert.equal(matchGlob('a/**', 'a/b/d/c.md'), true)
  assert.equal(matchGlob('a/**/c.md', 'a/c.md'), true)
  assert.equal(matchGlob('a/**/c.md', 'a/x/y/c.md'), true)
  assert.equal(matchGlob('a/*.md', 'a/b.md'), true)
  assert.equal(matchGlob('a/*.md', 'a/b.mdx'), false)
  assert.equal(matchGlob('a/b.mjs', 'a/bXmjs'), false)
})

const base = () => ({
  pages: [
    {
      path: 'docs/guide/index.md',
      text: '<!-- sources:\n- plugins/adf/skills/**\n-->\nUse `/adf:propose`. Plugin `adf`. Point `tracker`. Key `contract`.\n',
      sources: ['plugins/adf/skills/**'],
    },
  ],
  extraLinkPages: [],
  skills: ['adf:propose'],
  plugins: ['adf'],
  points: ['tracker'],
  registryKeys: ['contract'],
  coveredFiles: ['plugins/adf/skills/propose/SKILL.md'],
  files: ['plugins/adf/skills/propose/SKILL.md'],
  exists: () => true,
})

test('a complete fixture passes', () => {
  assert.deepEqual(checkGuide(base()), [])
})

test('REGISTRY_KEYS lists the registry fields', () => {
  assert.deepEqual(REGISTRY_KEYS, ['contract', 'branches', 'extensions', 'metrics', 'plugin', 'path', 'points', 'config', 'version'])
})

test('a skill no page names is an error', () => {
  const errors = checkGuide({ ...base(), skills: ['adf:propose', 'adf:apply'] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /\/adf:apply/)
})

test('a plugin, a point and a registry key no page names are errors', () => {
  const errors = checkGuide({ ...base(), plugins: ['adf', 'adf-jira'], points: ['tracker', 'rules'], registryKeys: ['contract', 'metrics'] })
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /adf-jira/)
  assert.match(errors.join('\n'), /rules/)
  assert.match(errors.join('\n'), /metrics/)
})

test('a covered file no sources entry matches is an error', () => {
  const errors = checkGuide({ ...base(), coveredFiles: ['plugins/adf/skills/propose/SKILL.md', 'plugins/adf/hooks/hooks.json'] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /plugins\/adf\/hooks\/hooks\.json/)
})

test('a glob that matches nothing is an error', () => {
  const input = base()
  input.pages[0].sources = ['plugins/adf/skills/**', 'plugins/none/**']
  const errors = checkGuide(input)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/guide\/index\.md/)
  assert.match(errors[0], /plugins\/none\/\*\*/)
})

test('links: anchors, directories and external links', () => {
  const input = base()
  const present = new Set(['docs/guide/x.md', 'docs/guide/dir', 'docs/guide/sub/y.md'])
  input.exists = (p) => present.has(p)
  input.pages[0].text +=
    '[a](x.md#a) [b](dir) [c](https://e.com) [d](http://e.com) [e](mailto:a@b.c) [f](#a) [g](sub/y.md) [h](missing.md#z)\n' +
    '```\n[no](ignored.md)\n```\n'
  const errors = checkGuide(input)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/guide\/index\.md/)
  assert.match(errors[0], /missing\.md#z/)
})

test('README.md links are checked', () => {
  const input = base()
  input.exists = (p) => p === 'docs/guide/index.md'
  input.extraLinkPages = [{ path: 'README.md', text: 'See [guide](docs/guide/index.md) and [gone](docs/gone.md).' }]
  const errors = checkGuide(input)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /README\.md/)
  assert.match(errors[0], /docs\/gone\.md/)
})

test('the covered directories include commands', () => {
  assert.deepEqual(COVERED_DIRS, ['skills', 'commands', 'contract', 'hooks'])
})
