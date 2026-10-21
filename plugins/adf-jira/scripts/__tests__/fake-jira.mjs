// An in-memory Jira behind a fetch function, for the tracker tests: no network. Routes the REST
// v2 calls the plugin makes, records every call, and fails a test on a route it does not know.
const graph = {
  Opened: [{ id: '4', name: 'Start Progress', to: 'In Progress', requiredFields: [], allowedValues: {} }],
  'In Progress': [
    { id: '811', name: 'Suspend', to: 'Suspended', requiredFields: [], allowedValues: {} },
    { id: '821', name: 'Review Issue', to: 'Review', requiredFields: [], allowedValues: {} }
  ],
  Review: [{ id: '751', name: 'Resolve Issue', to: 'Resolved', requiredFields: ['resolution'], allowedValues: {} }],
  Resolved: [{ id: '701', name: 'Close Issue', to: 'Closed', requiredFields: [], allowedValues: {} }],
  Closed: [],
  Suspended: [{ id: '791', name: 'Open Issue', to: 'Opened', requiredFields: [], allowedValues: {} }]
}

export const WORKFLOW = graph
const DONE = new Set(['Resolved', 'Closed'])

export function fakeJira({ token = 'token-value', account = 'dev.login', issues = {}, comments = {} } = {}) {
  const calls = []
  const store = structuredClone(issues)
  const posted = structuredClone(comments)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const empty = () => new Response(null, { status: 204 })

  const view = (key) => {
    const issue = store[key]
    const status = issue.fields.status
    return {
      key,
      fields: { ...issue.fields, status: { name: status, statusCategory: { key: DONE.has(status) ? 'done' : 'indeterminate' } } },
      changelog: issue.changelog ?? { histories: [] }
    }
  }

  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const { pathname, searchParams } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), body })
    if (init.headers?.Authorization !== `Bearer ${token}`) return json({ errorMessages: ['Unauthorized'] }, 401)

    if (method === 'GET' && pathname === '/rest/api/2/myself') return json({ name: account, displayName: 'Dev' })
    if (method === 'POST' && pathname === '/rest/api/2/search') {
      const text = (/text ~ "((?:[^"\\]|\\.)*)"/.exec(body.jql)?.[1] ?? '').replace(/\\(.)/g, '$1')
      const found = Object.keys(store).filter((k) => store[k].fields.summary.toLowerCase().includes(text.toLowerCase()) && !DONE.has(store[k].fields.status))
      return json({ startAt: 0, maxResults: body.maxResults, total: found.length, issues: found.slice(0, body.maxResults).map((key) => ({ key, fields: {} })) })
    }
    const m = /^\/rest\/api\/2\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/(comment|transitions))?$/.exec(pathname)
    if (!m) throw new Error(`fake Jira: unexpected ${method} ${pathname}`)
    const [, key, sub] = m
    if (!store[key]) return json({ errorMessages: ['Issue Does Not Exist'] }, 404)
    if (method === 'GET' && !sub) return json(view(key))
    if (method === 'GET' && sub === 'comment') {
      const all = posted[key] ?? []
      const startAt = Number(searchParams.get('startAt') ?? 0)
      const max = Number(searchParams.get('maxResults') ?? 50)
      return json({ startAt, maxResults: max, total: all.length, comments: all.slice(startAt, startAt + max) })
    }
    if (method === 'POST' && sub === 'transitions') {
      const hop = (graph[store[key].fields.status] ?? []).find((t) => t.id === body.transition.id)
      if (!hop) return json({ errorMessages: ['Transition not valid'] }, 400)
      store[key].fields.status = hop.to
      return empty()
    }
    if (method === 'PUT' && !sub) {
      Object.assign(store[key].fields, body.fields)
      return empty()
    }
    if (method === 'POST' && sub === 'comment') {
      posted[key] = [...(posted[key] ?? []), { id: String((posted[key]?.length ?? 0) + 1), body: body.body }]
      return json({ id: 'new' }, 201)
    }
    throw new Error(`fake Jira: unexpected ${method} ${pathname}`)
  }

  const writes = () => calls.filter((c) => c.method !== 'GET' && c.path !== '/rest/api/2/search')
  return { fetch, calls, writes, store, comments: posted }
}

export function issue(key, { summary = `Summary of ${key}`, status = 'Opened', type = 'Task', subtask = false, parent, subtasks = [], links = [], assignee = null, fields = {}, created = '2026-09-01T10:00:00.000+0300', changelog } = {}) {
  return {
    fields: {
      summary,
      description: `Description of ${key}`,
      status,
      issuetype: { name: type, subtask },
      parent: parent ? { key: parent } : undefined,
      subtasks: subtasks.map((k) => ({ key: k })),
      issuelinks: links,
      assignee: assignee ? { name: assignee } : null,
      created,
      ...fields
    },
    changelog
  }
}
