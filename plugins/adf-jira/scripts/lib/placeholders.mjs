// Personal logins a plan names without carrying them. The agent writes the placeholder; the
// apply process replaces it from the env file it reads itself, so the agent never reads that
// file. A login is not a secret, so the preview prints it resolved: the developer still sees
// who gets the issue. The plan file keeps the placeholder.
export const PLACEHOLDERS = {
  '<JIRA_ASSIGNEE>': 'assignee',
  '<JIRA_PM>': 'pm',
  '<JIRA_QA>': 'qa'
}

const PATTERN = /<JIRA_(?:ASSIGNEE|PM|QA)>/g

export function placeholderValues(env, extra = {}) {
  return { assignee: env.assignee, pm: env.pm, qa: env.qa, ...extra }
}

// Every placeholder a value uses, deep.
export function placeholdersIn(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PATTERN)) found.add(match[0])
  } else if (Array.isArray(value)) {
    for (const item of value) placeholdersIn(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) placeholdersIn(item, found)
  }
  return found
}

// Refuses, naming the variable and never a value, when a used placeholder has no value.
export function assertResolvable(value, values) {
  const unset = [...placeholdersIn(value)].filter((p) => !values[PLACEHOLDERS[p]])
  if (unset.length > 0) {
    const names = unset.map((p) => p.slice(1, -1))
    throw new Error(`The plan uses ${unset.join(', ')}, and ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set in the env file; nothing was applied.`)
  }
}

export function resolvePlaceholders(value, values) {
  if (typeof value === 'string') return value.replace(PATTERN, (p) => values[PLACEHOLDERS[p]] ?? p)
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, values))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, values)]))
  }
  return value
}
