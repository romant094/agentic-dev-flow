import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertResolvable, placeholdersIn, resolvePlaceholders } from '../lib/placeholders.mjs'
import { commentRow, issueRow, readAllComments } from '../lib/readers.mjs'

describe('issueRow', () => {
  it('flattens the fields the read script prints', () => {
    const row = issueRow({
      key: 'PROJ-1',
      fields: { summary: 'S', status: { name: 'Opened' }, assignee: { displayName: 'Dev' }, issuetype: { name: 'Bug' }, parent: { key: 'PROJ-9' }, labels: ['a', 1], description: '' }
    })
    assert.deepEqual(row, {
      key: 'PROJ-1',
      summary: 'S',
      status: 'Opened',
      resolution: null,
      assignee: 'Dev',
      issueType: 'Bug',
      parent: 'PROJ-9',
      labels: ['a'],
      created: null,
      updated: null,
      description: null
    })
  })
})

describe('commentRow', () => {
  it('keeps the id an edit needs and the author name', () => {
    assert.deepEqual(commentRow({ id: 42, author: { name: 'dev' }, created: 'c', body: 'b' }), { id: '42', author: 'dev', created: 'c', updated: null, body: 'b' })
  })
})

describe('readAllComments', () => {
  it('reads every page', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: i }))
    const paths = []
    const client = {
      get: async (path) => {
        paths.push(path)
        const startAt = Number(/startAt=(\d+)/.exec(path)[1])
        return { total: all.length, comments: all.slice(startAt, startAt + 100) }
      }
    }
    assert.equal((await readAllComments(client, 'PROJ-1')).length, 250)
    assert.equal(paths.length, 3)
  })
})

describe('login placeholders', () => {
  const plan = { rows: [{ steps: [{ fields: { assignee: { name: '<JIRA_QA>' } } }, { comment: { body: 'for <JIRA_PM>' } }] }] }

  it('finds every placeholder a plan uses, and resolves them', () => {
    assert.deepEqual([...placeholdersIn(plan)].sort(), ['<JIRA_PM>', '<JIRA_QA>'])
    const resolved = resolvePlaceholders(plan, { qa: 'qa.login', pm: 'pm.login' })
    assert.equal(resolved.rows[0].steps[0].fields.assignee.name, 'qa.login')
    assert.equal(resolved.rows[0].steps[1].comment.body, 'for pm.login')
    assert.equal(plan.rows[0].steps[0].fields.assignee.name, '<JIRA_QA>')
  })

  it('refuses a plan whose placeholder has no value, naming the variable', () => {
    assert.throws(() => assertResolvable(plan, { qa: 'qa.login' }), /JIRA_PM is not set in the env file/)
  })
})
