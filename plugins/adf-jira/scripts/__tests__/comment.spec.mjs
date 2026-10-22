import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFields, checkMr, escapeWiki, loadTemplate, parseTemplate, renderComment } from '../lib/comment.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const template = loadTemplate({ root: '/nowhere', pluginRoot: PLUGIN_ROOT })
const MR = { url: 'https://git.example.com/g/r/-/merge_requests/7' }

describe('the default hand-off template', () => {
  it('renders a taken item: done, how to test as a numbered list, the commit and the merge request', () => {
    const body = renderComment(template, 'taken', { done: ['The port is validated.'], test: ['Open the page.', 'Save 70000.'], commit: 'abc1234' }, MR)
    assert.equal(
      body,
      'h3. Done\n# The port is validated.\n\nh3. How to test\n# Open the page.\n# Save 70000.\n\nCommit: abc1234\n\nMerge request: https://git.example.com/g/r/-/merge_requests/7'
    )
  })

  it('renders a partial item with what remains, and without a done section when none is given', () => {
    const body = renderComment(template, 'partial', { remains: ['The bulk path is open.'] }, null)
    assert.equal(body, 'h3. Remains\n# The bulk path is open.')
  })

  it('renders a partial item as the core sends it: done, how to test, and what remains', () => {
    const body = renderComment(template, 'partial', { done: ['The count is shown.'], test: ['Open the page.', 'Read the count.'], remains: ['The gauge.'] }, MR)
    assert.equal(body, 'h3. Done\n# The count is shown.\n\nh3. How to test\n# Open the page.\n# Read the count.\n\nh3. Remains\n# The gauge.\n\nMerge request: https://git.example.com/g/r/-/merge_requests/7')
  })

  it('renders a not-reproduced item with the commit and what was tried', () => {
    const body = renderComment(template, 'not-reproduced', { tried: ['Followed the steps.'], commit: 'abc1234' }, null)
    assert.equal(body, 'h3. Does not reproduce\nThe issue does not reproduce on commit abc1234.\n\nh3. Tried\n# Followed the steps.')
  })

  it('has no merge request line with no forge, and no link anywhere then', () => {
    const body = renderComment(template, 'taken', { done: ['a'], test: ['b'] }, null)
    assert.doesNotMatch(body, /Merge request|https?:/)
  })

  it('escapes brackets and braces in agent text, so it opens no link or macro', () => {
    assert.equal(escapeWiki('Set [x] to {y}'), 'Set \\[x\\] to \\{y\\}')
    const body = renderComment(template, 'taken', { done: ['Set [x].'], test: ['b'] }, null)
    assert.match(body, /# Set \\\[x\\\]\./)
  })
})

describe('parseTemplate', () => {
  it('refuses a template without every section', () => {
    assert.throws(() => parseTemplate('<!-- taken -->\n{{done}}\n<!-- partial -->\n{{remains}}\n', 'host.md'), /no section "not-reproduced"/)
  })

  it('refuses an unknown placeholder and an unclosed block', () => {
    const sections = (taken) => `<!-- taken -->\n${taken}\n<!-- partial -->\nx\n<!-- not-reproduced -->\ny\n`
    assert.throws(() => parseTemplate(sections('{{author}}'), 'host.md'), /unknown placeholder/)
    assert.throws(() => parseTemplate(sections('{{#mr}}\nM {{mr}}'), 'host.md'), /never closed/)
    assert.throws(() => parseTemplate(sections('# {{done}} {{test}}'), 'host.md'), /more than one list/)
  })

  it('ignores the preface above the first marker', () => {
    const parsed = parseTemplate('About {{anything}}\n<!-- taken -->\nT\n<!-- partial -->\nP\n<!-- not-reproduced -->\nN\n', 'host.md')
    assert.deepEqual(parsed.taken, ['T'])
  })
})

describe('checkFields', () => {
  it('accepts the fields each state takes', () => {
    assert.deepEqual(checkFields('P-1', 'taken', { done: ['a'], test: ['b'] }), [])
    assert.deepEqual(checkFields('P-1', 'partial', { done: ['a'], test: ['b'], remains: ['c'] }), [])
    assert.deepEqual(checkFields('P-1', 'not-reproduced', { tried: ['a'], commit: 'abc1234' }), [])
  })

  it('names a missing required field, an unknown field, a link, and a bad commit', () => {
    assert.deepEqual(checkFields('P-1', 'taken', { done: ['a'] }), ['P-1: taken needs test'])
    assert.deepEqual(checkFields('P-1', 'partial', { done: ['a'], test: ['b'], remains: ['c'], tried: ['d'] }), ['P-1: partial takes no field tried'])
    assert.deepEqual(checkFields('P-1', 'partial', { remains: ['a'] }), ['P-1: partial needs done', 'P-1: partial needs test'])
    assert.deepEqual(checkFields('P-1', 'taken', { done: ['see www.example.com'], test: ['b'] }), ['P-1: done holds a link; agent text carries no link'])
    assert.deepEqual(checkFields('P-1', 'not-reproduced', { tried: ['a'], commit: 'HEAD' }), ['P-1: commit is not a commit hash'])
  })

  it('refuses a multi-line text and an unknown state', () => {
    assert.deepEqual(checkFields('P-1', 'taken', { done: ['a\nb'], test: ['c'] }), ['P-1: done is not a list of one-line texts'])
    assert.deepEqual(checkFields('P-1', 'taken', { done: 'a', test: ['c'] }), ['P-1: done is not a list of one-line texts'])
    assert.match(checkFields('P-1', 'closed', {})[0], /not one of/)
  })
})

describe('checkMr', () => {
  it('takes a URL object or null, nothing else', () => {
    assert.deepEqual(checkMr(null), [])
    assert.deepEqual(checkMr(MR), [])
    assert.equal(checkMr(undefined).length, 1)
    assert.equal(checkMr({ url: 'not a url' }).length, 1)
  })
})
