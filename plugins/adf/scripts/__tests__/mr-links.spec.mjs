import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLinks, linksInput, LINKS_SINCE, renderLinks } from '../lib/mr-links.mjs'

const scope = {
  items: [
    { source: 'debt', key: 'D-0001', title: 'Three', state: 'taken', files: ['docs/debt/a/index.md', 'docs/debt/a/body.md'] },
    { source: 'tracker', key: 'PROJ-1', title: 'One', state: 'taken', url: 'https://t/PROJ-1' },
    { source: 'tracker', key: 'PROJ-9', title: 'Nine', state: 'excluded', url: 'https://t/PROJ-9' },
    { source: 'tracker', key: 'PROJ-2', title: 'Two', state: 'partial', url: null },
    { source: 'debt', key: 'D-0002', title: 'Four', state: 'partial', files: ['docs/debt/b/index.md'] }
  ]
}

const fakeGit = ({ mergeBase = 0, catFile = 0 } = {}) => (args) => {
  if (args[0] === 'merge-base') return { status: mergeBase, stdout: mergeBase === 0 ? 'abc123\n' : '' }
  if (args[0] === 'cat-file') return { status: catFile, stdout: '' }
  return { status: 1, stdout: '' }
}

test('buildLinks keeps taken and partial items, tracker first', () => {
  const links = buildLinks('/r', scope, 'main', { git: fakeGit() })
  assert.deepEqual(links.map((l) => [l.kind, l.key]), [['tracker', 'PROJ-1'], ['tracker', 'PROJ-2'], ['debt', 'D-0001'], ['debt', 'D-0002']])
  assert.deepEqual(links[1], { kind: 'tracker', key: 'PROJ-2', title: 'Two', url: null })
  assert.equal(links[2].path, 'docs/debt/a/index.md')
})

test('a debt entry present at the merge base carries the commit', () => {
  const links = buildLinks('/r', scope, 'main', { git: fakeGit() })
  assert.equal(links[2].commit, 'abc123')
})

test('a debt entry absent at the merge base has no commit', () => {
  const links = buildLinks('/r', scope, 'main', { git: fakeGit({ catFile: 1 }) })
  assert.equal(links[2].commit, null)
})

test('no origin gives debt links without a commit', () => {
  const links = buildLinks('/r', scope, 'main', { git: fakeGit({ mergeBase: 128 }) })
  assert.deepEqual(links.filter((l) => l.kind === 'debt').map((l) => l.commit), [null, null])
})

test('no scope or nothing taken gives no links', () => {
  assert.deepEqual(buildLinks('/r', null, 'main'), [])
  assert.deepEqual(buildLinks('/r', { items: [{ source: 'tracker', key: 'P-1', title: 'x', state: 'excluded' }] }, 'main'), [])
})

test('renderLinks writes the exact lines', () => {
  const links = [
    { kind: 'tracker', key: 'PROJ-1', title: 'One', url: 'https://t/PROJ-1' },
    { kind: 'tracker', key: 'PROJ-2', title: 'Two', url: null },
    { kind: 'debt', key: 'D-0001', title: 'Three', path: 'p', commit: 'abc' }
  ]
  assert.equal(renderLinks(links), 'Scope:\n- Issue [PROJ-1](https://t/PROJ-1): One\n- Issue PROJ-2: Two\n- Debt D-0001: Three\n\n')
  assert.equal(renderLinks([]), '')
})

test('renderLinks escapes a closing bracket and puts a title on one line', () => {
  const links = [{ kind: 'tracker', key: 'P-1', title: 'a ] b\nc\r\nd', url: 'https://t/P-1' }]
  assert.equal(renderLinks(links), 'Scope:\n- Issue [P-1](https://t/P-1): a \\] b c d\n\n')
})

test('linksInput passes links to a 1.10 provider and into body for 1.9', () => {
  const links = [{ kind: 'tracker', key: 'PROJ-1', title: 'One', url: null }]
  const input = { change: 'c', body: 'Body' }
  assert.equal(LINKS_SINCE, '1.10')
  for (const v of ['1.10', '1.12']) {
    assert.deepEqual(linksInput('finalize', input, links, v), { ...input, links })
    assert.deepEqual(linksInput('open', input, links, v), { ...input, links })
  }
  for (const v of ['1.9', '1.7']) {
    const out = linksInput('finalize', input, links, v)
    assert.ok(out.body.startsWith('Scope:'))
    assert.ok(out.body.endsWith('Body'))
    assert.equal(out.links, undefined)
    assert.deepEqual(linksInput('open', input, links, v), input)
  }
  assert.deepEqual(linksInput('finalize', input, [], '1.10'), input)
})
