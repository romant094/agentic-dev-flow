import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JiraClient, JiraError } from '../lib/client.mjs'

const env = { url: 'https://jira.example.com', pat: 'test-pat', allowedProjects: ['PROJ'] }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('JiraClient', () => {
  it('sends the PAT as a bearer token against the v2 API', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ key: 'PROJ-1', fields: {} })
    }

    const client = new JiraClient(env, fetchImpl)
    await client.get('/rest/api/2/issue/PROJ-1')

    assert.equal(calls[0].url, 'https://jira.example.com/rest/api/2/issue/PROJ-1')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-pat')
    assert.equal(calls[0].init.headers.Accept, 'application/json')
  })

  it('surfaces Jira error messages and the status on a failure', async () => {
    const fetchImpl = async () => jsonResponse({ errorMessages: [], errors: { resolution: 'Resolution is required.' } }, 400)

    const client = new JiraClient(env, fetchImpl)
    await assert.rejects(client.post('/rest/api/2/issue/PROJ-1/transitions', {}), JiraError)
    await assert.rejects(client.post('/rest/api/2/issue/PROJ-1/transitions', {}), /Resolution is required/)
  })

  it('returns undefined for a 204, which transitions answer with', async () => {
    const fetchImpl = async () => new Response(null, { status: 204 })
    const client = new JiraClient(env, fetchImpl)
    assert.equal(await client.post('/rest/api/2/issue/PROJ-1/transitions', {}), undefined)
  })

  it('pages through search until every issue is collected', async () => {
    const pages = [
      { startAt: 0, maxResults: 2, total: 3, issues: [{ key: 'A-1', fields: {} }, { key: 'A-2', fields: {} }] },
      { startAt: 2, maxResults: 2, total: 3, issues: [{ key: 'A-3', fields: {} }] }
    ]
    let call = 0
    const bodies = []
    const fetchImpl = async (_url, init) => {
      bodies.push(String(init?.body))
      return jsonResponse(pages[call++])
    }

    const client = new JiraClient(env, fetchImpl)
    const issues = await client.search('project = PROJ', ['key'])

    assert.deepEqual(
      issues.map((i) => i.key),
      ['A-1', 'A-2', 'A-3']
    )
    assert.equal(JSON.parse(bodies[1]).startAt, 2)
  })

  it('stops paging when a page comes back empty', async () => {
    const fetchImpl = async () => jsonResponse({ startAt: 0, maxResults: 50, total: 99, issues: [] })
    const client = new JiraClient(env, fetchImpl)
    assert.deepEqual(await client.search('project = PROJ', ['key']), [])
  })

  it('falls back to the raw body text when a 502 comes back non-JSON', async () => {
    const fetchImpl = async () =>
      new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } })

    const client = new JiraClient(env, fetchImpl)
    await assert.rejects(client.post('/rest/api/2/issue/PROJ-1/transitions', {}), /502 Bad Gateway/)
  })

  it('issues exactly one request and returns just the first page when maxResults is given', async () => {
    let calls = 0
    const bodies = []
    const fetchImpl = async (_url, init) => {
      calls += 1
      bodies.push(String(init?.body))
      return jsonResponse({ startAt: 0, maxResults: 1, total: 600, issues: [{ key: 'A-1', fields: {} }] })
    }

    const client = new JiraClient(env, fetchImpl)
    const issues = await client.search('project = PROJ', ['key'], 1)

    assert.equal(calls, 1)
    assert.equal(JSON.parse(bodies[0]).maxResults, 1)
    assert.deepEqual(
      issues.map((i) => i.key),
      ['A-1']
    )
  })
})
