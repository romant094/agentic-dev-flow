// The API facts of one project, read from the live instance: the issue types and their required
// fields, the field map, the workflow graph sampled per status, and the account's permissions.
// The graph is the account's own projection of the scheme, which is why the file is personal.
export function buildWorkflowGraph(samples) {
  const graph = {}
  for (const { status, transitions } of samples) {
    graph[status] = transitions.map((t) => {
      const fields = t.fields ?? {}
      const requiredFields = Object.keys(fields).filter((k) => fields[k]?.required === true)
      const allowedValues = {}
      for (const key of requiredFields) {
        const values = fields[key]?.allowedValues
        if (values) {
          allowedValues[key] = values.map((v) => v.name).filter((n) => typeof n === 'string')
        }
      }
      return { id: t.id, name: t.name, to: t.to.name, requiredFields, allowedValues }
    })
  }
  return graph
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
  const statusNames = [...new Set(statuses.flatMap((s) => s.statuses.map((x) => x.name)))]

  const samples = []
  const unsampledStatuses = []
  for (const status of statusNames) {
    try {
      const found = await client.search(`project = ${projectKey} AND status = "${status}" ORDER BY updated DESC`, ['key'], 1)
      if (found.length === 0) {
        unsampledStatuses.push({ status, reason: 'no issue in this status to sample' })
        samples.push({ status, transitions: [] })
        continue
      }
      const probe = await client.get(`/rest/api/2/issue/${found[0].key}/transitions?expand=transitions.fields`)
      samples.push({ status, transitions: probe.transitions })
    } catch (error) {
      unsampledStatuses.push({ status, reason: error instanceof Error ? error.message : String(error) })
      samples.push({ status, transitions: [] })
    }
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
    workflow: buildWorkflowGraph(samples),
    unsampledStatuses,
    permissions
  }
}
