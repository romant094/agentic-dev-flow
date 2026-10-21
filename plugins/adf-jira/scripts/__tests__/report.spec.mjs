import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderPlan } from '../lib/report.mjs'

const base = { version: 1, operation: 'transition', allowlist: ['PROJ'], discoveredAt: '2026-09-09T13:06:36.000+03:00' }

function transitionPlan(count) {
  return {
    ...base,
    rows: Array.from({ length: count }, (_, i) => ({
      key: `PROJ-${i + 1}`,
      summary: `Summary number ${i + 1}`,
      from: 'In Progress',
      steps: [
        { transitionId: '821', to: 'Review' },
        { transitionId: '751', to: 'Resolved', fields: { resolution: { name: 'Fixed' }, assignee: { name: 'pm.login' } } }
      ],
      state: 'pending'
    }))
  }
}

function oneRow(summary, fields) {
  return { ...base, rows: [{ key: 'PROJ-1', summary, from: 'Open', steps: [{ transitionId: '1', to: 'Closed', fields }], state: 'pending' }] }
}

describe('renderPlan', () => {
  it('collapses identical step sequences into one counted line', () => {
    const text = renderPlan({ plan: transitionPlan(14), planPath: '.adf/jira/bulk/plan-transition-2026-09-09-1412.json', title: 'adf-jira:bulk — close 14 issues, reassign to PM' })
    assert.ok(text.includes('14 ×'))
    assert.ok(text.includes('In Progress → Review → Resolved'))
  })

  it('names the field values being written', () => {
    const text = renderPlan({ plan: transitionPlan(2), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('resolution: Fixed'))
    assert.ok(text.includes('assignee: pm.login'))
  })

  it('lists a sample of issues and counts the remainder', () => {
    const text = renderPlan({ plan: transitionPlan(14), planPath: 'p.json', title: 't', sampleSize: 2 })
    assert.ok(text.includes('PROJ-1'))
    assert.ok(text.includes('PROJ-2'))
    assert.ok(!text.includes('PROJ-5'))
    assert.ok(text.includes('12 more'))
  })

  it('does not add a remainder line when every row is shown', () => {
    const text = renderPlan({ plan: transitionPlan(2), planPath: 'p.json', title: 't', sampleSize: 5 })
    assert.doesNotMatch(text, /…\s*\d+\s*more/)
  })

  it('reports exclusions with their reason', () => {
    const text = renderPlan({
      plan: transitionPlan(1),
      planPath: 'p.json',
      title: 't',
      excluded: [
        { key: 'PROJ-58', reason: 'already Closed' },
        { key: 'PROJ-91', reason: 'already Closed' }
      ]
    })
    assert.ok(text.includes('2 issues excluded'))
    assert.ok(text.includes('already Closed'))
    assert.ok(text.includes('PROJ-58'))
  })

  it('always quotes the full plan path so the detail is reachable', () => {
    const text = renderPlan({ plan: transitionPlan(1), planPath: '.adf/jira/bulk/plan-transition-2026-09-09-1412.json', title: 't' })
    assert.ok(text.includes('.adf/jira/bulk/plan-transition-2026-09-09-1412.json'))
  })

  it('renders an empty plan as nothing to do rather than an empty confirmation', () => {
    const text = renderPlan({ plan: transitionPlan(0), planPath: 'p.json', title: 't' })
    assert.match(text, /nothing to do/i)
  })

  it('groups rows with different field values into separate groups', () => {
    const plan = {
      ...base,
      rows: ['Fixed', "Won't Do"].map((resolution, i) => ({
        key: `PROJ-${i + 1}`,
        summary: `Issue ${i + 1}`,
        from: 'In Progress',
        steps: [
          { transitionId: '821', to: 'Review' },
          { transitionId: '751', to: 'Resolved', fields: { resolution: { name: resolution } } }
        ],
        state: 'pending'
      }))
    }
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes('1 ×'))
    assert.ok(!text.includes('2 ×'))
    assert.ok(text.includes('resolution: Fixed'))
    assert.ok(text.includes("resolution: Won't Do"))
  })

  it('renders arrays of objects as comma-separated names', () => {
    const text = renderPlan({ plan: oneRow('Has components', { components: [{ name: 'Backend' }, { name: 'Frontend' }] }), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('components: Backend, Frontend'))
    assert.ok(!text.includes('[object Object]'))
  })

  it('renders option-shaped fields with value property', () => {
    const text = renderPlan({ plan: oneRow('Has custom field', { 'QA-field': { value: 'approved' } }), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('QA-field: approved'))
  })

  it('renders unrecognized objects as JSON', () => {
    const text = renderPlan({ plan: oneRow('Has unknown object', { 'custom-obj': { foo: 'bar', baz: 123 } }), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('"foo":"bar"'))
    assert.ok(!text.includes('[object Object]'))
  })
})

describe('renderPlan for worklog plans', () => {
  const worklogPlan = () => ({
    ...base,
    operation: 'worklog',
    rows: [
      {
        key: 'PROJ-586',
        summary: '8h on 2026-08-20',
        steps: [{ worklog: { timeSpent: '8h', started: '2026-08-20T09:00:00.000+0300', comment: 'Added the `@Form` decorator + resolving guard' } }],
        state: 'pending'
      },
      {
        key: 'PROJ-586',
        summary: '4h on 2026-08-21',
        steps: [{ worklog: { timeSpent: '4h', started: '2026-08-21T09:00:00.000+0300', comment: 'Validated project writes against form schemas' } }],
        state: 'pending'
      }
    ]
  })

  it('names the hours and the date rather than calling it a field edit', () => {
    const text = renderPlan({ plan: worklogPlan(), planPath: 'p.json', title: 't' })
    assert.doesNotMatch(text, /field edit/)
    assert.ok(text.includes('worklog 8h on 2026-08-20'))
    assert.ok(text.includes('worklog 4h on 2026-08-21'))
  })

  it('shows the comment being written, since that is what the human approves', () => {
    const text = renderPlan({ plan: worklogPlan(), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('Added the `@Form` decorator + resolving guard'))
    assert.ok(text.includes('Validated project writes against form schemas'))
  })

  it('keeps entries with different content in separate groups', () => {
    const text = renderPlan({ plan: worklogPlan(), planPath: 'p.json', title: 't' })
    assert.doesNotMatch(text, /2 ×/)
    assert.equal((text.match(/1 ×/g) ?? []).length, 2)
  })

  it('collapses genuinely identical entries', () => {
    const plan = worklogPlan()
    plan.rows[1] = { ...plan.rows[0], summary: 'same again' }
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes('2 ×'))
  })

  it('truncates a long comment rather than flooding the summary', () => {
    const plan = worklogPlan()
    plan.rows = [plan.rows[0]]
    plan.rows[0].steps[0].worklog.comment = 'x'.repeat(300)
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.match(text, /x{100}…/)
    assert.doesNotMatch(text, /x{200}/)
  })

  it('renders a worklog with no comment without an empty line', () => {
    const plan = worklogPlan()
    plan.rows = [plan.rows[0]]
    plan.rows[0].steps[0].worklog.comment = undefined
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes('worklog 8h on 2026-08-20'))
  })
})

describe('renderPlan for create plans', () => {
  const createPlan = () => ({
    ...base,
    operation: 'create',
    rows: [
      {
        key: '(new)',
        project: 'PROJ',
        summary: 'A test task under the epic',
        steps: [{ create: { fields: { project: { key: 'PROJ' }, issuetype: { name: 'Task' }, summary: 'A test task under the epic', customfield_10800: 'PROJ-578' } } }],
        state: 'pending'
      }
    ]
  })

  it('names the issue type and the project instead of calling it a field edit', () => {
    const text = renderPlan({ plan: createPlan(), planPath: 'p.json', title: 't' })
    assert.doesNotMatch(text, /field edit/)
    assert.ok(text.includes('create Task in PROJ'))
  })

  it('lists the fields the new issue will carry', () => {
    const text = renderPlan({ plan: createPlan(), planPath: 'p.json', title: 't' })
    assert.ok(text.includes('customfield_10800: PROJ-578'))
    assert.ok(text.includes('summary: A test task under the epic'))
  })

  it('falls back gracefully when the issue type is absent', () => {
    const plan = createPlan()
    plan.rows[0].steps[0].create.fields.issuetype = undefined
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes('create in PROJ'))
  })
})

describe('renderPlan for link plans', () => {
  it('names both issue keys and the link type instead of calling it a field edit', () => {
    const plan = {
      ...base,
      rows: [
        {
          key: 'PROJ-999',
          summary: 'Link the superseded sub-task to its replacement',
          steps: [{ link: { type: 'Relates', inwardIssue: 'PROJ-1', outwardIssue: 'PROJ-999' } }],
          state: 'pending'
        }
      ]
    }
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.doesNotMatch(text, /field edit/)
    assert.ok(text.includes('Relates'))
    assert.ok(text.includes('PROJ-1'))
    assert.ok(text.includes('PROJ-999'))
  })
})

describe('renderPlan for comment plans', () => {
  const commentPlan = () => ({
    ...base,
    operation: 'comment',
    rows: [{ key: 'PROJ-586', summary: 'Bind write requests to a form', steps: [{ comment: { action: 'add', body: 'Verified on the lab stand.' } }], state: 'pending' }]
  })

  it('names the comment and shows its body instead of calling it a field edit', () => {
    const text = renderPlan({ plan: commentPlan(), planPath: 'p.json', title: 't' })
    assert.doesNotMatch(text, /field edit/)
    assert.ok(text.includes('1 × comment'))
    assert.ok(text.includes('Verified on the lab stand.'))
  })

  it('names the comment id an edit rewrites', () => {
    const plan = commentPlan()
    plan.rows[0].steps[0].comment = { action: 'edit', id: '45678', body: 'Corrected.' }
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes('edit comment 45678'))
  })

  it('truncates a long body rather than printing the whole essay', () => {
    const plan = commentPlan()
    plan.rows[0].steps[0].comment = { action: 'add', body: 'x'.repeat(180) }
    const text = renderPlan({ plan, planPath: 'p.json', title: 't' })
    assert.ok(text.includes(`${'x'.repeat(100)}…`))
    assert.ok(!text.includes('x'.repeat(101)))
  })
})
