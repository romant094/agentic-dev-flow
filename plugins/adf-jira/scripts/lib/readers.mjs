// The rows the read scripts print, and the comment reader the tracker shares with them. Reads
// only; nothing here writes to Jira.
export const DEFAULT_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'issuetype',
  'parent',
  'resolution',
  'created',
  'updated',
  'labels'
]

const COMMENT_PAGE = 100

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function named(value) {
  if (typeof value !== 'object' || value === null) return null
  return typeof value.name === 'string' ? value.name : null
}

export function issueRow(issue) {
  const f = issue.fields
  const parent = f.parent
  return {
    key: issue.key,
    summary: text(f.summary) ?? '',
    status: named(f.status) ?? 'unknown',
    resolution: named(f.resolution),
    assignee: named(f.assignee) ?? text(f.assignee?.displayName),
    issueType: named(f.issuetype) ?? 'unknown',
    parent: typeof parent?.key === 'string' ? parent.key : null,
    labels: Array.isArray(f.labels) ? f.labels.filter((l) => typeof l === 'string') : [],
    created: text(f.created),
    updated: text(f.updated),
    description: text(f.description)
  }
}

export function commentRow(comment) {
  const author = comment.author
  return {
    id: String(comment.id ?? ''),
    author: text(author?.displayName) ?? text(author?.name),
    created: text(comment.created),
    updated: text(comment.updated),
    body: text(comment.body) ?? ''
  }
}

// Every comment of an issue, page by page: the endpoint pages, and a JQL search returns the
// field truncated.
export async function readAllComments(client, key) {
  const collected = []
  let startAt = 0
  for (;;) {
    const page = await client.get(`/rest/api/2/issue/${key}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE}`)
    const comments = page?.comments ?? []
    collected.push(...comments)
    const total = typeof page?.total === 'number' ? page.total : collected.length
    if (comments.length === 0 || collected.length >= total) return collected
    startAt += comments.length
  }
}
