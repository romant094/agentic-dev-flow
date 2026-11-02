// The API facts of one project, read from the live instance: the issue types and their required
// fields, the field map, the workflow graph sampled per issue type and status, and the account's
// permissions. The graph is the account's own projection of the scheme, which is why the file is
// personal.
//
// A transition the API marks unavailable (`isAvailable: false`, a condition the account fails)
// stays out of the graph and is listed under `unavailable`; one it marks `isConditional` carries
// `conditional: true`. The REST transitions resource exposes no more than that: which condition
// or validator applies is not readable without admin access to the workflow.
function transitionRecord(t) {
  const fields = t.fields ?? {}
  const requiredFields = Object.keys(fields).filter((k) => fields[k]?.required === true)
  const allowedValues = {}
  for (const key of requiredFields) {
    const values = fields[key]?.allowedValues
    if (values) {
      allowedValues[key] = values.map((v) => v.name).filter((n) => typeof n === 'string')
    }
  }
  const record = { id: t.id, name: t.name, to: t.to.name, requiredFields, allowedValues }
  if (t.isConditional === true) record.conditional = true
  return record
}

export function buildWorkflowGraph(samples) {
  const graph = {}
  for (const { status, transitions } of samples) {
    graph[status] = transitions.filter((t) => t.isAvailable !== false).map(transitionRecord)
  }
  return graph
}

function unavailableTransitions(samples) {
  const out = {}
  for (const { status, transitions } of samples) {
    const blocked = transitions.filter((t) => t.isAvailable === false)
    if (blocked.length > 0) {
      out[status] = blocked.map((t) => ({ id: t.id, name: t.name, to: t.to.name, ...(t.isConditional === true ? { conditional: true } : {}) }))
    }
  }
  return out
}

// The status-keyed graph the route solver reads: per status, every transition any issue type
// offers, once per id and destination.
function mergeGraphs(graphs) {
  const merged = {}
  for (const graph of graphs) {
    for (const [status, transitions] of Object.entries(graph)) {
      const into = (merged[status] ??= [])
      for (const t of transitions) {
        if (!into.some((x) => x.id === t.id && x.to === t.to)) into.push(t)
      }
    }
  }
  return merged
}

// One issue of the type in the status: one the account is assigned to when there is one, since a
// workflow may offer a transition to the assignee alone, else any.
async function sampleIssue(client, projectKey, type, status) {
  const jql = `project = ${projectKey} AND issuetype = "${type}" AND status = "${status}"`
  const mine = await client.search(`${jql} AND assignee = currentUser() ORDER BY updated DESC`, ['key'], 1)
  if (mine.length > 0) return { issue: mine[0].key, asAssignee: true }
  const any = await client.search(`${jql} ORDER BY updated DESC`, ['key'], 1)
  return any.length > 0 ? { issue: any[0].key, asAssignee: false } : null
}

async function discoverType(client, projectKey, type, statuses) {
  const samples = []
  const sampled = {}
  const unsampledStatuses = []
  for (const status of statuses) {
    try {
      const found = await sampleIssue(client, projectKey, type, status)
      if (found === null) {
        unsampledStatuses.push({ status, reason: 'no issue of this type in this status to sample' })
        samples.push({ status, transitions: [] })
        continue
      }
      const probe = await client.get(`/rest/api/2/issue/${found.issue}/transitions?expand=transitions.fields&includeUnavailableTransitions=true`)
      sampled[status] = found
      samples.push({ status, transitions: probe.transitions })
    } catch (error) {
      unsampledStatuses.push({ status, reason: error instanceof Error ? error.message : String(error) })
      samples.push({ status, transitions: [] })
    }
  }
  return { workflow: buildWorkflowGraph(samples), samples: sampled, unavailable: unavailableTransitions(samples), unsampledStatuses }
}

// A status is unsampled only when no issue type sampled it.
function unsampledAcrossTypes(byType) {
  const types = Object.values(byType)
  const statuses = [...new Set(types.flatMap((t) => Object.keys(t.workflow)))]
  const out = []
  for (const status of statuses) {
    if (types.some((t) => status in t.samples)) continue
    const reasons = types.flatMap((t) => t.unsampledStatuses.filter((u) => u.status === status).map((u) => u.reason))
    const error = reasons.find((r) => r !== 'no issue of this type in this status to sample')
    out.push({ status, reason: error ?? 'no issue in this status to sample' })
  }
  return out
}

export const PERMISSION_KEYS = [
  'CREATE_ISSUE',
  'EDIT_ISSUE',
  'TRANSITION_ISSUE',
  'ASSIGN_ISSUE',
  'ASSIGNABLE_USER',
  'BULK_CHANGE',
  'SCHEDULE_ISSUE',
  'MODIFY_REPORTER'
]

export async function discover(client, projectKey, now) {
  const serverInfo = await client.get('/rest/api/2/serverInfo')
  const project = await client.get(`/rest/api/2/project/${projectKey}`)
  const createMeta = await client.get(`/rest/api/2/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`)

  const issueTypes = (createMeta.projects[0]?.issuetypes ?? []).map((it) => ({
    id: it.id,
    name: it.name,
    subtask: it.subtask,
    requiredFields: Object.keys(it.fields).filter((k) => it.fields[k]?.required === true)
  }))

  const fields = await client.get('/rest/api/2/field')
  const fieldMap = {}
  for (const f of fields) fieldMap[f.name] = f.id

  const statuses = await client.get(`/rest/api/2/project/${projectKey}/statuses`)
  const workflowByType = {}
  for (const entry of statuses) {
    workflowByType[entry.name] = await discoverType(client, projectKey, entry.name, [...new Set(entry.statuses.map((x) => x.name))])
  }

  const raw = await client.get(`/rest/api/2/mypermissions?projectKey=${projectKey}`)
  const permissions = {}
  for (const key of PERMISSION_KEYS) permissions[key] = raw.permissions[key]?.havePermission === true

  return {
    discoveredAt: now.toISOString(),
    instance: {
      baseUrl: serverInfo.baseUrl,
      version: serverInfo.version,
      deploymentType: serverInfo.deploymentType
    },
    project: { key: project.key, name: project.name, lead: project.lead?.displayName },
    issueTypes,
    fieldMap,
    workflow: mergeGraphs(Object.values(workflowByType).map((t) => t.workflow)),
    workflowByType,
    unsampledStatuses: unsampledAcrossTypes(workflowByType),
    permissions
  }
}
