// The schematic summary a developer confirms: rows with identical steps and values collapse
// into one counted line, with a sample of issues and the remainder counted.
const DEFAULT_SAMPLE = 3
const COMMENT_LIMIT = 100

export function renderPlan({ plan, planPath, title, excluded = [], sampleSize = DEFAULT_SAMPLE }) {
  const lines = [title, '']

  if (plan.rows.length === 0) {
    lines.push('  Nothing to do — no issue matched the selection.')
    lines.push('', `  full plan: ${planPath}`)
    return lines.join('\n')
  }

  for (const group of groupRows(plan.rows)) {
    lines.push(`  ${group.rows.length} × ${group.shape}`)
    for (const field of group.fields) lines.push(`              ${field}`)
    lines.push('')
    for (const row of group.rows.slice(0, sampleSize)) {
      lines.push(`  ${row.key}  ${row.summary}`)
    }
    const remainder = group.rows.length - sampleSize
    if (remainder > 0) lines.push(`  … ${remainder} more`)
    lines.push('')
  }

  if (excluded.length > 0) {
    const reasons = [...new Set(excluded.map((e) => e.reason))].join(', ')
    lines.push(`  ⚠ ${excluded.length} issues excluded: ${reasons} (${excluded.map((e) => e.key).join(', ')})`)
    lines.push('')
  }

  lines.push(`  full plan: ${planPath}`)
  return lines.join('\n')
}

function groupRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    const shape = describeShape(row)
    const fields = describeFields(row)
    const signature = `${shape}|${fields.join('|')}`
    const existing = groups.get(signature)
    if (existing) existing.rows.push(row)
    else groups.set(signature, { shape, fields, rows: [row] })
  }
  return [...groups.values()]
}

function describeShape(row) {
  const create = row.steps.find((s) => s.create !== undefined)?.create
  if (create !== undefined) {
    const type = renderValue(create.fields.issuetype)
    const project = row.project ?? renderValue(create.fields.project)
    return type === 'undefined' ? `create in ${project}` : `create ${type} in ${project}`
  }
  const worklog = row.steps.find((s) => s.worklog !== undefined)?.worklog
  if (worklog !== undefined) {
    const date = worklog.started?.slice(0, 10)
    return date === undefined ? `worklog ${worklog.timeSpent}` : `worklog ${worklog.timeSpent} on ${date}`
  }
  const link = row.steps.find((s) => s.link !== undefined)?.link
  if (link !== undefined) {
    return `link ${link.type}: ${link.inwardIssue} -> ${link.outwardIssue}`
  }
  const comment = row.steps.find((s) => s.comment !== undefined)?.comment
  if (comment !== undefined) {
    return comment.action === 'add' ? 'comment' : `edit comment ${comment.id}`
  }
  const stops = row.steps.map((s) => s.to).filter((s) => typeof s === 'string')
  if (stops.length === 0) return 'field edit'
  const hops = stops.length === 1 ? '1 hop' : `${stops.length} hops`
  return `${[row.from ?? '?', ...stops].join(' → ')}   (${hops})`
}

function describeFields(row) {
  const out = []
  for (const step of row.steps) {
    if (step.worklog?.comment !== undefined) {
      out.push(truncate(step.worklog.comment, COMMENT_LIMIT))
    }
    if (step.comment !== undefined) {
      out.push(truncate(step.comment.body, COMMENT_LIMIT))
    }
    for (const [key, value] of Object.entries(step.create?.fields ?? {})) {
      if (key === 'project' || key === 'issuetype') continue
      out.push(`${key}: ${renderValue(value)}`)
    }
    for (const [key, value] of Object.entries(step.fields ?? {})) {
      out.push(`${key}: ${renderValue(value)}`)
    }
  }
  return out
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function renderValue(value) {
  if (Array.isArray(value)) return value.map(renderValue).join(', ')
  if (value !== null && typeof value === 'object') {
    if (typeof value.name === 'string') return value.name
    if (typeof value.key === 'string') return value.key
    if (typeof value.value === 'string') return value.value
    if (typeof value.id === 'string') return value.id
    return JSON.stringify(value)
  }
  return String(value)
}
