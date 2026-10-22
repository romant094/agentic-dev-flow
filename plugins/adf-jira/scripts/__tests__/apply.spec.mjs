import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyPlan } from '../lib/apply.mjs'
import { JiraError } from '../lib/client.mjs'

function planWith(rows) {
  return {
    version: 1,
    operation: 'transition',
    allowlist: ['PROJ'],
    discoveredAt: '2026-09-09T13:06:36.000+03:00',
    rows
  }
}

function row(key, from, state = 'pending') {
  return { key, summary: 's', from, steps: [{ transitionId: '821', to: 'Review' }], state }
}

// Both paths put the issue key at index 5:
//   /rest/api/2/issue/PROJ-1?fields=status  -> ['', 'rest', 'api', '2', 'issue', 'PROJ-1?fields=status']
//   /rest/api/2/issue/PROJ-1/transitions    -> ['', 'rest', 'api', '2', 'issue', 'PROJ-1', 'transitions']
// so the query string has to be stripped.
function keyFrom(path) {
  return path.split('/')[5].split('?')[0]
}

function stub(statuses, failOn, failGetOn) {
  const posts = []
  const puts = []
  const client = {
    get: async (path) => {
      const key = keyFrom(path)
      if (failGetOn?.has(key)) throw new Error('read timed out')
      return { fields: { status: { name: statuses[key] } } }
    },
    post: async (path, body) => {
      if (failOn?.has(keyFrom(path))) throw new JiraError(400, ['Resolution is required.'])
      posts.push({ path, body })
      return undefined
    },
    put: async (path, body) => {
      if (failOn?.has(keyFrom(path))) throw new JiraError(400, ['Resolution is required.'])
      puts.push({ path, body })
      return undefined
    }
  }
  return { client, posts, puts }
}

const noop = () => {}

describe('applyPlan', () => {
  it('applies a pending row whose status still matches', async () => {
    const s = stub({ 'PROJ-1': 'In Progress' })
    const plan = planWith([row('PROJ-1', 'In Progress')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(plan.rows[0].state, 'done')
    assert.equal(s.posts.length, 1)
    assert.deepEqual(s.posts[0].body, { transition: { id: '821' } })
  })

  it('skips a row already marked done, issuing no request', async () => {
    const s = stub({ 'PROJ-1': 'In Progress' })
    const plan = planWith([row('PROJ-1', 'In Progress', 'done')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.skippedDone, 1)
    assert.equal(s.posts.length, 0)
  })

  it('marks a row skipped-drift when someone moved the issue by hand', async () => {
    const s = stub({ 'PROJ-1': 'Closed' })
    const plan = planWith([row('PROJ-1', 'In Progress')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.skippedDrift, 1)
    assert.equal(plan.rows[0].state, 'skipped-drift')
    assert.match(plan.rows[0].error, /Closed/)
    assert.equal(s.posts.length, 0)
  })

  it('persists after every row so an interruption leaves an accurate file', async () => {
    const s = stub({ 'PROJ-1': 'In Progress', 'PROJ-2': 'In Progress' })
    const plan = planWith([row('PROJ-1', 'In Progress'), row('PROJ-2', 'In Progress')])
    const snapshots = []
    await applyPlan({ plan, client: s.client, persist: (p) => snapshots.push(p.rows.map((r) => r.state)) })

    assert.deepEqual(snapshots, [
      ['done', 'pending'],
      ['done', 'done']
    ])
  })

  it('records a failure and carries on to the next row', async () => {
    const s = stub({ 'PROJ-1': 'In Progress', 'PROJ-2': 'In Progress' }, new Set(['PROJ-1']))
    const plan = planWith([row('PROJ-1', 'In Progress'), row('PROJ-2', 'In Progress')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.failed, 1)
    assert.equal(outcome.applied, 1)
    assert.equal(plan.rows[0].state, 'failed')
    assert.match(plan.rows[0].error, /Resolution is required/)
    assert.equal(plan.rows[1].state, 'done')
  })

  it('aborts after three consecutive failures, leaving later rows pending', async () => {
    const keys = ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']
    const statuses = Object.fromEntries(keys.map((k) => [k, 'In Progress']))
    const s = stub(statuses, new Set(keys))
    const plan = planWith(keys.map((k) => row(k, 'In Progress')))
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.abortedAfterConsecutiveFailures, true)
    assert.equal(outcome.failed, 3)
    assert.equal(plan.rows[3].state, 'pending')
  })

  it('records a failed drift-check read and carries on to the next row', async () => {
    const s = stub({ 'PROJ-1': 'In Progress', 'PROJ-2': 'In Progress' }, undefined, new Set(['PROJ-1']))
    const plan = planWith([row('PROJ-1', 'In Progress'), row('PROJ-2', 'In Progress')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.failed, 1)
    assert.equal(plan.rows[0].state, 'failed')
    assert.match(plan.rows[0].error, /read timed out/)
    assert.equal(plan.rows[1].state, 'done')
    assert.equal(outcome.applied, 1)
  })

  it('aborts after three consecutive drift-check read failures, leaving a later row pending', async () => {
    const keys = ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']
    const statuses = Object.fromEntries(keys.map((k) => [k, 'In Progress']))
    const s = stub(statuses, undefined, new Set(keys))
    const plan = planWith(keys.map((k) => row(k, 'In Progress')))
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.abortedAfterConsecutiveFailures, true)
    assert.equal(outcome.failed, 3)
    assert.equal(plan.rows[3].state, 'pending')
  })

  it('resets the failure streak after a drift-check read failure is followed by success', async () => {
    const s = stub({ 'PROJ-1': 'In Progress', 'PROJ-2': 'In Progress' }, undefined, new Set(['PROJ-1']))
    const plan = planWith([row('PROJ-1', 'In Progress'), row('PROJ-2', 'In Progress')])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.abortedAfterConsecutiveFailures, false)
    assert.equal(plan.rows[1].state, 'done')
  })

  it('runs every step of a multi-hop row in order', async () => {
    const s = stub({ 'PROJ-1': 'In Progress' })
    const plan = planWith([
      {
        key: 'PROJ-1',
        summary: 's',
        from: 'In Progress',
        steps: [
          { transitionId: '821', to: 'Review' },
          { transitionId: '751', to: 'Resolved', fields: { resolution: { name: 'Fixed' } } }
        ],
        state: 'pending'
      }
    ])
    await applyPlan({ plan, client: s.client, persist: noop })

    assert.deepEqual(
      s.posts.map((p) => p.body.transition.id),
      ['821', '751']
    )
    assert.deepEqual(s.posts[1].body, { transition: { id: '751' }, fields: { resolution: { name: 'Fixed' } } })
  })

  it('issues a PUT with just the fields for a step that carries no transitionId', async () => {
    const s = stub({ 'PROJ-1': 'In Progress' })
    const plan = {
      ...planWith([{ key: 'PROJ-1', summary: 's', from: 'In Progress', steps: [{ fields: { timetracking: { originalEstimate: '2h' } } }], state: 'pending' }]),
      operation: 'edit'
    }
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(s.puts.length, 1)
    assert.equal(s.puts[0].path, '/rest/api/2/issue/PROJ-1')
    assert.deepEqual(s.puts[0].body, { fields: { timetracking: { originalEstimate: '2h' } } })
    assert.equal(plan.rows[0].state, 'done')
    assert.equal(outcome.applied, 1)
  })

  it('posts a worklog entry for a worklog step and never touches the issue itself', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([
      {
        key: 'PROJ-586',
        summary: 'Bind write requests to a form',
        steps: [{ worklog: { timeSpent: '8h', started: '2026-08-20T09:00:00.000+0300', comment: 'Added the `@Form` decorator + resolving guard' } }],
        state: 'pending'
      }
    ])
    plan.operation = 'worklog'
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(plan.rows[0].state, 'done')
    assert.equal(s.posts.length, 1)
    assert.equal(s.posts[0].path, '/rest/api/2/issue/PROJ-586/worklog')
    assert.deepEqual(s.posts[0].body, {
      timeSpent: '8h',
      started: '2026-08-20T09:00:00.000+0300',
      comment: 'Added the `@Form` decorator + resolving guard'
    })
    // a worklog must never edit the issue - that is how an estimate gets overwritten
    assert.equal(s.puts.length, 0)
  })

  it('omits an absent worklog comment rather than sending an empty one', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([{ key: 'PROJ-586', summary: 's', steps: [{ worklog: { timeSpent: '4h', started: '2026-08-21T09:00:00.000+0300' } }], state: 'pending' }])
    plan.operation = 'worklog'
    await applyPlan({ plan, client: s.client, persist: noop })

    assert.deepEqual(s.posts[0].body, { timeSpent: '4h', started: '2026-08-21T09:00:00.000+0300' })
  })

  it('accepts a worklog plan through the operation guard', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([{ key: 'PROJ-586', summary: 's', steps: [{ worklog: { timeSpent: '1h' } }], state: 'pending' }])
    plan.operation = 'worklog'
    assert.ok(await applyPlan({ plan, client: s.client, persist: noop }))
  })
})

describe('applyPlan for create plans', () => {
  function createStub() {
    const posts = []
    const client = {
      post: async (path, body) => {
        posts.push({ path, body })
        return { key: 'PROJ-999', id: '12345' }
      }
    }
    return { client, posts }
  }

  function createPlan() {
    return {
      version: 1,
      operation: 'create',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [
        {
          key: '(new)',
          project: 'PROJ',
          summary: 'A test task under the epic',
          steps: [
            {
              create: {
                fields: {
                  project: { key: 'PROJ' },
                  issuetype: { name: 'Task' },
                  summary: 'A test task under the epic',
                  customfield_10800: 'PROJ-578'
                }
              }
            }
          ],
          state: 'pending'
        }
      ]
    }
  }

  it('posts to the issue endpoint and records the key Jira assigned', async () => {
    const s = createStub()
    const plan = createPlan()
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(s.posts.length, 1)
    assert.equal(s.posts[0].path, '/rest/api/2/issue')
    assert.equal(plan.rows[0].createdKey, 'PROJ-999')
    assert.equal(plan.rows[0].state, 'done')
  })

  it('issues no status read for a create row, since there is no issue to read', async () => {
    const s = createStub()
    const plan = createPlan()
    await applyPlan({ plan, client: s.client, persist: noop })
    // the stub has no get at all — a drift check would throw
    assert.equal(s.posts.length, 1)
  })

  it('is admitted by the operation guard', async () => {
    const s = createStub()
    assert.ok(await applyPlan({ plan: createPlan(), client: s.client, persist: noop }))
  })
})

describe('applyPlan for link steps', () => {
  function linkStub() {
    const posts = []
    const client = {
      post: async (path, body) => {
        posts.push({ path, body })
        return undefined
      }
    }
    return { client, posts }
  }

  function linkPlan() {
    return {
      version: 1,
      operation: 'transition',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [
        {
          key: 'PROJ-999',
          summary: 'Link the superseded sub-task to its replacement',
          steps: [{ link: { type: 'Relates', inwardIssue: 'PROJ-1', outwardIssue: 'PROJ-999' } }],
          state: 'pending'
        }
      ]
    }
  }

  it('posts to the issueLink endpoint with the type and both issue keys', async () => {
    const s = linkStub()
    const outcome = await applyPlan({ plan: linkPlan(), client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(s.posts.length, 1)
    assert.equal(s.posts[0].path, '/rest/api/2/issueLink')
    assert.deepEqual(s.posts[0].body, { type: { name: 'Relates' }, inwardIssue: { key: 'PROJ-1' }, outwardIssue: { key: 'PROJ-999' } })
  })

  it('runs a create step and a link step in order on the same row', async () => {
    const posts = []
    const plan = {
      version: 1,
      operation: 'create',
      allowlist: ['PROJ'],
      discoveredAt: '2026-09-09T13:06:36.000+03:00',
      rows: [
        {
          key: '(new)',
          project: 'PROJ',
          summary: 'A replacement sub-task',
          steps: [
            { create: { fields: { project: { key: 'PROJ' }, issuetype: { name: 'Sub-task' } } } },
            { link: { type: 'Relates', inwardIssue: 'PROJ-1', outwardIssue: 'PROJ-999' } }
          ],
          state: 'pending'
        }
      ]
    }
    const client = {
      post: async (path, body) => {
        posts.push({ path, body })
        return path === '/rest/api/2/issue' ? { key: 'PROJ-999' } : undefined
      }
    }
    const outcome = await applyPlan({ plan, client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.deepEqual(
      posts.map((p) => p.path),
      ['/rest/api/2/issue', '/rest/api/2/issueLink']
    )
    assert.equal(plan.rows[0].createdKey, 'PROJ-999')
  })

  it('marks the row failed and preserves the error when the link request fails', async () => {
    const client = {
      post: async () => {
        throw new JiraError(400, ['Cannot link an issue to itself.'])
      }
    }
    const plan = linkPlan()
    const outcome = await applyPlan({ plan, client, persist: noop })

    assert.equal(outcome.failed, 1)
    assert.equal(plan.rows[0].state, 'failed')
    assert.match(plan.rows[0].error, /Cannot link an issue to itself/)
  })
})

describe('applyPlan for comment plans', () => {
  it('posts the body to the issue comment collection and never edits the issue', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([
      { key: 'PROJ-586', summary: 'Bind write requests to a form', steps: [{ comment: { action: 'add', body: 'Verified on the lab stand.' } }], state: 'pending' }
    ])
    plan.operation = 'comment'
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(plan.rows[0].state, 'done')
    assert.equal(s.posts.length, 1)
    assert.equal(s.posts[0].path, '/rest/api/2/issue/PROJ-586/comment')
    assert.deepEqual(s.posts[0].body, { body: 'Verified on the lab stand.' })
    assert.equal(s.puts.length, 0)
  })

  it('puts an edit to the comment own path rather than to the issue', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([
      { key: 'PROJ-586', summary: 's', steps: [{ comment: { action: 'edit', id: '45678', body: 'Corrected: the stand runs firmware 2.4.1.' } }], state: 'pending' }
    ])
    plan.operation = 'comment'
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.equal(s.posts.length, 0)
    assert.equal(s.puts.length, 1)
    assert.equal(s.puts[0].path, '/rest/api/2/issue/PROJ-586/comment/45678')
    assert.deepEqual(s.puts[0].body, { body: 'Corrected: the stand runs firmware 2.4.1.' })
  })

  it('accepts a comment plan through the operation guard', async () => {
    const s = stub({ 'PROJ-586': 'Resolved' })
    const plan = planWith([{ key: 'PROJ-586', summary: 's', steps: [{ comment: { action: 'add', body: 'b' } }], state: 'pending' }])
    plan.operation = 'comment'
    assert.ok(await applyPlan({ plan, client: s.client, persist: noop }))
  })

  it('writes the comment alongside a transition when one row carries both steps', async () => {
    const s = stub({ 'PROJ-586': 'In Progress' })
    const plan = planWith([
      {
        key: 'PROJ-586',
        summary: 's',
        from: 'In Progress',
        steps: [{ transitionId: '821', to: 'Review' }, { comment: { action: 'add', body: 'Ready for review.' } }],
        state: 'pending'
      }
    ])
    const outcome = await applyPlan({ plan, client: s.client, persist: noop })

    assert.equal(outcome.applied, 1)
    assert.deepEqual(
      s.posts.map((p) => p.path),
      ['/rest/api/2/issue/PROJ-586/transitions', '/rest/api/2/issue/PROJ-586/comment']
    )
  })
})

describe('applyPlan with login placeholders', () => {
  it('sends the resolved login and keeps the placeholder in the plan', async () => {
    const s = stub({ 'PROJ-1': 'Review' })
    const plan = planWith([{ key: 'PROJ-1', summary: 's', from: 'Review', steps: [{ fields: { assignee: { name: '<JIRA_QA>' } } }], state: 'pending' }])
    plan.operation = 'edit'
    await applyPlan({ plan, client: s.client, persist: noop, values: { qa: 'qa.login' } })

    assert.deepEqual(s.puts[0].body, { fields: { assignee: { name: 'qa.login' } } })
    assert.equal(plan.rows[0].steps[0].fields.assignee.name, '<JIRA_QA>')
  })
})

describe('applyPlan with a description guard', () => {
  it('sends a description of the expected shape that differs, skips one of another shape, and sends nothing when it is equal', async () => {
    const descriptions = { 'PROJ-1': 'h3. Debt\n* old', 'PROJ-2': 'Written by hand.', 'PROJ-3': 'h3. Debt\r\n\r\n* same' }
    const puts = []
    const gets = []
    const client = {
      get: async (path) => {
        gets.push(path)
        return { fields: { status: { name: 'Opened' }, description: descriptions[keyFrom(path)] } }
      },
      put: async (path, body) => {
        puts.push({ path, body })
      }
    }
    const row = (key, description) => ({ key, summary: 's', from: 'Opened', body: { shape: '^h3\\. Debt\\n(?:\\* [^\\n]*\\n)+$' }, steps: [{ fields: { description } }], state: 'pending' })
    const plan = { ...planWith([row('PROJ-1', 'h3. Debt\n* new'), row('PROJ-2', 'h3. Debt\n* new'), row('PROJ-3', 'h3. Debt\n* same')]), operation: 'edit' }
    const outcome = await applyPlan({ plan, client, persist: noop })

    assert.deepEqual([outcome.applied, outcome.skippedDrift, outcome.unchanged], [1, 1, 1])
    assert.deepEqual(gets, ['/rest/api/2/issue/PROJ-1?fields=status,description', '/rest/api/2/issue/PROJ-2?fields=status,description', '/rest/api/2/issue/PROJ-3?fields=status,description'])
    assert.deepEqual(puts, [{ path: '/rest/api/2/issue/PROJ-1', body: { fields: { description: 'h3. Debt\n* new' } } }])
    assert.deepEqual(plan.rows.map((r) => r.state), ['done', 'skipped-drift', 'done'])
    assert.equal(plan.rows[1].error, 'The description was not built from the template; left untouched.')
    assert.equal(plan.rows[2].note, 'the description is already up to date; nothing was sent')
  })
})
