import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkflowGraph, discover } from '../lib/discovered.mjs'

describe('buildWorkflowGraph', () => {
  const samples = [
    {
      status: 'In Progress',
      transitions: [
        { id: '811', name: 'Suspend', to: { name: 'Suspended' }, fields: {} },
        { id: '821', name: 'Review Issue', to: { name: 'Review' }, fields: {} }
      ]
    },
    {
      status: 'Review',
      transitions: [
        {
          id: '751',
          name: 'Resolve Issue',
          to: { name: 'Resolved' },
          fields: {
            resolution: { name: 'Resolution', required: true, allowedValues: [{ name: 'Fixed' }, { name: 'Done' }] },
            assignee: { name: 'Assignee', required: false }
          }
        }
      ]
    }
  ]

  it('keys transitions by their originating status', () => {
    const graph = buildWorkflowGraph(samples)
    assert.deepEqual(Object.keys(graph).sort(), ['In Progress', 'Review'])
    assert.deepEqual(
      graph['In Progress'].map((t) => t.id),
      ['811', '821']
    )
  })

  it('records the destination status name', () => {
    assert.equal(buildWorkflowGraph(samples)['In Progress'][1].to, 'Review')
  })

  it('captures required screen fields, so a missing resolution cannot slip through', () => {
    const resolve = buildWorkflowGraph(samples).Review[0]
    assert.deepEqual(resolve.requiredFields, ['resolution'])
  })

  it('captures allowed values for required option fields', () => {
    const resolve = buildWorkflowGraph(samples).Review[0]
    assert.deepEqual(resolve.allowedValues.resolution, ['Fixed', 'Done'])
  })

  it('leaves a status with no transitions out rather than storing undefined', () => {
    const graph = buildWorkflowGraph([{ status: 'Closed', transitions: [] }])
    assert.deepEqual(graph.Closed, [])
  })
})

function makeClient(cfg) {
  const get = async (path) => {
    if (cfg.serverInfoError && path === '/rest/api/2/serverInfo') throw new Error(cfg.serverInfoError)
    if (path === '/rest/api/2/serverInfo') return { baseUrl: 'https://jira.example.com', version: '8.20.2', deploymentType: 'Server' }
    if (path === '/rest/api/2/project/DEMO') return { key: 'DEMO', name: 'Demo Project', issueTypes: [] }
    if (path.startsWith('/rest/api/2/issue/createmeta')) return { projects: [{ issuetypes: [] }] }
    if (path === '/rest/api/2/field') return []
    if (path === '/rest/api/2/project/DEMO/statuses') return [{ name: 'wf', statuses: cfg.statuses.map((name) => ({ name })) }]
    const transitionsMatch = path.match(/^\/rest\/api\/2\/issue\/([^/]+)\/transitions/)
    if (transitionsMatch) {
      const status = transitionsMatch[1].replace(/-1$/, '')
      const statusCfg = cfg.perStatus[status]
      if (statusCfg?.transitionsError) throw new Error(statusCfg.transitionsError)
      return { transitions: statusCfg?.transitions ?? [] }
    }
    if (path.startsWith('/rest/api/2/mypermissions')) return { permissions: {} }
    throw new Error(`stub client: unexpected get ${path}`)
  }

  const search = async (jql) => {
    const match = jql.match(/status = "([^"]+)"/)
    const status = match?.[1] ?? ''
    return cfg.perStatus[status]?.found ? [{ key: `${status}-1`, fields: {} }] : []
  }

  return { get, search }
}

describe('discover', () => {
  it('records a status with no issues in unsampledStatuses, and still resolves', async () => {
    const client = makeClient({ statuses: ['Backlog'], perStatus: { Backlog: { found: false } } })

    const facts = await discover(client, 'DEMO', new Date('2026-09-01T00:00:00Z'))

    assert.deepEqual(facts.unsampledStatuses, [{ status: 'Backlog', reason: 'no issue in this status to sample' }])
    assert.deepEqual(facts.workflow.Backlog, [])
  })

  it('records a status whose transitions probe throws, still resolves, and keeps later statuses in workflow', async () => {
    const client = makeClient({
      statuses: ['In Progress', 'Done'],
      perStatus: {
        'In Progress': { found: true, transitionsError: 'socket hang up' },
        Done: { found: true, transitions: [{ id: '901', name: 'Reopen', to: { name: 'Open' }, fields: {} }] }
      }
    })

    const facts = await discover(client, 'DEMO', new Date('2026-09-01T00:00:00Z'))

    assert.deepEqual(facts.unsampledStatuses, [{ status: 'In Progress', reason: 'socket hang up' }])
    assert.deepEqual(
      facts.workflow.Done.map((t) => t.id),
      ['901']
    )
  })

  it('yields an empty unsampledStatuses when every status is sampled', async () => {
    const client = makeClient({
      statuses: ['To Do', 'Done'],
      perStatus: { 'To Do': { found: true, transitions: [] }, Done: { found: true, transitions: [] } }
    })

    const facts = await discover(client, 'DEMO', new Date('2026-09-01T00:00:00Z'))

    assert.deepEqual(facts.unsampledStatuses, [])
  })

  it('still rejects when serverInfo fails, since that is not a per-status probe', async () => {
    const client = makeClient({ statuses: [], perStatus: {}, serverInfoError: 'connection refused' })

    await assert.rejects(discover(client, 'DEMO', new Date('2026-09-01T00:00:00Z')), /connection refused/)
  })
})
