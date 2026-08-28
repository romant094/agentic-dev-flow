import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, normalise } from './normative-duplication.mjs'

const files = {
  'a.md': 'A change MUST state its verdict.\n',
  'b.md': 'A change **MUST** state its   verdict.\n'
}
const read = async (p) => files[p] ?? ''
const list = async () => Object.keys(files)

test('reports one rule restated in a second file', async () => {
  const r = await check({ read, list, files: ['a.md', 'b.md'] })
  assert.equal(r.ok, false)
  assert.match(r.detail, /a\.md/)
  assert.match(r.detail, /b\.md/)
})

test('ignores a repeated sentence carrying no normative modal', async () => {
  const plain = { 'a.md': 'The report is written last.\n', 'b.md': 'The report is written last.\n' }
  const r = await check({ read: async (p) => plain[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(r.ok, true)
})

test('ignores a command repeated inside fenced blocks', async () => {
  const fenced = {
    'a.md': '```bash\ngit status --porcelain\n```\n',
    'b.md': '```bash\ngit status --porcelain\n```\n'
  }
  const r = await check({ read: async (p) => fenced[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(r.ok, true)
})

test('strips a fenced command even when it carries a normative modal itself', async () => {
  // Unlike the fixture above, this one's fenced content contains a modal — if fence
  // stripping were ever removed, the modal filter alone would still catch this duplicate
  // and the test would fail, which is what actually pins stripNonProse's behaviour.
  const fenced = {
    'a.md': '```bash\n# You MUST never run this in prod\ngit status --porcelain\n```\n',
    'b.md': '```bash\n# You MUST never run this in prod\ngit status --porcelain\n```\n'
  }
  const r = await check({ read: async (p) => fenced[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(r.ok, true)
})

test('normalises emphasis, backticks, list markers and whitespace', () => {
  assert.equal(normalise('- A change **MUST** run `foo`   now.'), 'a change must run foo now.')
})

test('a normative modal spelled Never at a sentence start is detected as a restatement', async () => {
  // The original pattern matched all-caps MUST/SHALL/NEVER/ALWAYS and fully-lowercase
  // never/always, but missed a capitalised-first-letter sentence start such as "Never …" —
  // the gap code review caught with `NORMATIVE.test('Always let the user choose.') === false`.
  const capitalised = {
    'a.md': 'Never do a missing skills work manually.\n',
    'b.md': 'Never do a missing skills work manually.\n'
  }
  const r = await check({ read: async (p) => capitalised[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(r.ok, false)
})

test('the deferred-duplicate allowlist is pinned to the exact recorded sentence, not a general escape hatch', async () => {
  const pinned = {
    'a.md': 'If vague or ambiguous you MUST prompt for available changes.\n',
    'b.md': 'If vague or ambiguous you MUST prompt for available changes.\n'
  }
  const allowlisted = await check({ read: async (p) => pinned[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(allowlisted.ok, true)

  const reworded = {
    'a.md': 'If vague or ambiguous you MUST prompt for every available change.\n',
    'b.md': 'If vague or ambiguous you MUST prompt for every available change.\n'
  }
  const notAllowlisted = await check({ read: async (p) => reworded[p] ?? '', list, files: ['a.md', 'b.md'] })
  assert.equal(notAllowlisted.ok, false)
})

test('a file that cannot be read is reported as a finding, not silently skipped', async () => {
  const unreadable = async (p) => {
    if (p === 'missing.md') throw new Error('ENOENT')
    return files[p] ?? ''
  }
  const r = await check({ read: unreadable, list, files: ['a.md', 'missing.md'] })
  assert.equal(r.ok, false)
  assert.match(r.detail, /missing\.md/)
})
